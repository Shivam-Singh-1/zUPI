import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { resetDatabase } from '../src/config/database.js';
import { demoService } from '../src/services/demo.service.js';
import { idempotencyService } from '../src/services/idempotency.service.js';
import { meshSimulatorService } from '../src/services/meshSimulator.service.js';

describe('API Endpoints & Dashboard Integration', () => {
  const app = createApp();

  beforeEach(() => {
    resetDatabase();
    demoService.seedAccounts();
    meshSimulatorService.resetMesh();
    idempotencyService.clear();
  });

  it('GET / serves the dashboard HTML', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('UPI Offline Mesh — Live Demo');
  });

  it('GET /api/server-key returns 2048-bit RSA SPKI public key', async () => {
    const res = await request(app).get('/api/server-key');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('publicKey');
    expect(res.body).toHaveProperty('algorithm', 'RSA-2048 / OAEP-SHA256');
    expect(typeof res.body.publicKey).toBe('string');
    expect(res.body.publicKey.length).toBeGreaterThan(100);
  });

  it('GET /api/accounts lists seeded accounts', async () => {
    const res = await request(app).get('/api/accounts');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(4);

    const alice = res.body.find((a: { vpa: string }) => a.vpa === 'alice@demo');
    expect(alice).toBeDefined();
    expect(alice.balance).toBe('5000.00');
  });

  it('full demo lifecycle: send -> gossip -> flush -> transaction recorded', async () => {
    // 1. Send payment packet into phone-alice
    const sendRes = await request(app)
      .post('/api/demo/send')
      .send({
        senderVpa: 'alice@demo',
        receiverVpa: 'bob@demo',
        amount: 250,
        pin: '1234',
        ttl: 5,
        startDevice: 'phone-alice',
      });

    expect(sendRes.status).toBe(200);
    expect(sendRes.body).toHaveProperty('packetId');
    expect(sendRes.body).toHaveProperty('ciphertextPreview');
    expect(sendRes.body.injectedAt).toBe('phone-alice');

    // 2. Check mesh state — only phone-alice holds packet
    const stateBefore = await request(app).get('/api/mesh/state');
    expect(stateBefore.status).toBe(200);
    const aliceDeviceBefore = stateBefore.body.devices.find(
      (d: { deviceId: string }) => d.deviceId === 'phone-alice'
    );
    expect(aliceDeviceBefore.packetCount).toBe(1);

    // 3. Run gossip round — packet spreads to all 5 devices
    const gossipRes = await request(app).post('/api/mesh/gossip');
    expect(gossipRes.status).toBe(200);
    expect(gossipRes.body.transfers).toBe(4);

    const stateAfterGossip = await request(app).get('/api/mesh/state');
    const bridgeDevice = stateAfterGossip.body.devices.find(
      (d: { deviceId: string }) => d.deviceId === 'phone-bridge'
    );
    expect(bridgeDevice.packetCount).toBe(1);

    // 4. Flush bridges — bridge uploads to backend and settles
    const flushRes = await request(app).post('/api/mesh/flush');
    expect(flushRes.status).toBe(200);
    expect(flushRes.body.uploadsAttempted).toBe(1);
    expect(flushRes.body.results[0].outcome).toBe('SETTLED');

    // 5. Verify balances updated
    const accountsRes = await request(app).get('/api/accounts');
    const alice = accountsRes.body.find((a: { vpa: string }) => a.vpa === 'alice@demo');
    const bob = accountsRes.body.find((a: { vpa: string }) => a.vpa === 'bob@demo');
    expect(alice.balance).toBe('4750.00');
    expect(bob.balance).toBe('1250.00');

    // 6. Verify transaction ledger entry
    const txRes = await request(app).get('/api/transactions');
    expect(txRes.status).toBe(200);
    expect(txRes.body.length).toBeGreaterThanOrEqual(1);
    expect(txRes.body[0].senderVpa).toBe('alice@demo');
    expect(txRes.body[0].receiverVpa).toBe('bob@demo');
    expect(txRes.body[0].amount).toBe('250.00');
    expect(txRes.body[0].status).toBe('SETTLED');

    // 7. Reset mesh
    const resetRes = await request(app).post('/api/mesh/reset');
    expect(resetRes.status).toBe(200);
    const stateAfterReset = await request(app).get('/api/mesh/state');
    expect(stateAfterReset.body.idempotencyCacheSize).toBe(0);
    stateAfterReset.body.devices.forEach((d: { packetCount: number }) => {
      expect(d.packetCount).toBe(0);
    });
  });

  it('direct POST /api/bridge/ingest processes incoming packet', async () => {
    const packet = demoService.createPacket('alice@demo', 'bob@demo', '150.00', '1234', 5);

    const res = await request(app)
      .post('/api/bridge/ingest')
      .set('X-Bridge-Node-Id', 'bridge-direct')
      .set('X-Hop-Count', '2')
      .send(packet);

    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('SETTLED');
    expect(res.body.transactionId).toBeGreaterThan(0);

    // Duplicate call with same packet returns DUPLICATE_DROPPED
    const dupRes = await request(app)
      .post('/api/bridge/ingest')
      .set('X-Bridge-Node-Id', 'bridge-direct-2')
      .set('X-Hop-Count', '3')
      .send(packet);

    expect(dupRes.status).toBe(200);
    expect(dupRes.body.outcome).toBe('DUPLICATE_DROPPED');
  });
});
