import { Decimal } from 'decimal.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDatabase, resetDatabase } from '../src/config/database.js';
import { hybridCryptoService } from '../src/crypto/hybridCrypto.service.js';
import { serverKeyHolder } from '../src/crypto/serverKeyHolder.js';
import { accountRepository } from '../src/repositories/account.repo.js';
import { bridgeIngestionService } from '../src/services/bridgeIngestion.service.js';
import { demoService } from '../src/services/demo.service.js';
import { idempotencyService } from '../src/services/idempotency.service.js';
import { meshSimulatorService } from '../src/services/meshSimulator.service.js';
import { MeshPacket, PaymentInstruction } from '../src/types/mesh.types.js';

describe('IdempotencyConcurrencyTest', () => {
  beforeEach(() => {
    resetDatabase();
    demoService.seedAccounts();
    idempotencyService.clear();
  });

  it('singlePacketDeliveredByThreeBridgesSettlesExactlyOnce', async () => {
    // 1. Capture starting balances
    const aliceBefore = new Decimal(accountRepository.findById('alice@demo')!.balance);
    const bobBefore = new Decimal(accountRepository.findById('bob@demo')!.balance);

    // 2. Generate one valid mesh packet
    const packet = demoService.createPacket('alice@demo', 'bob@demo', '100.00', '1234', 5);

    // 3. Deliver from 3 simulated bridge nodes simultaneously
    const bridgeNodes = ['bridge-0', 'bridge-1', 'bridge-2'];
    const results = await Promise.all(
      bridgeNodes.map((node) => bridgeIngestionService.ingest(packet, node, 3))
    );

    const settledCount = results.filter((r) => r.outcome === 'SETTLED').length;
    const duplicateCount = results.filter((r) => r.outcome === 'DUPLICATE_DROPPED').length;

    expect(settledCount).toBe(1);
    expect(duplicateCount).toBe(2);

    // 4. Verify balances moved exactly once
    const aliceAfter = new Decimal(accountRepository.findById('alice@demo')!.balance);
    const bobAfter = new Decimal(accountRepository.findById('bob@demo')!.balance);

    expect(aliceBefore.minus(new Decimal('100.00')).toFixed(2)).toBe(aliceAfter.toFixed(2));
    expect(bobBefore.plus(new Decimal('100.00')).toFixed(2)).toBe(bobAfter.toFixed(2));
  });

  it('tamperedCiphertextIsRejected', () => {
    const packet = demoService.createPacket('alice@demo', 'bob@demo', '50.00', '1234', 5);

    // Flip a byte in the middle of the base64 ciphertext
    const buffer = Buffer.from(packet.ciphertext, 'base64');
    buffer[buffer.length - 20] ^= 0xff; // Flip bits in ciphertext area
    packet.ciphertext = buffer.toString('base64');

    const result = bridgeIngestionService.ingest(packet, 'bridge-x', 1);
    expect(result.outcome).toBe('INVALID');
    expect(result.reason).toBe('decryption_failed');
  });

  it('encryptDecryptRoundTrip', () => {
    const original: PaymentInstruction = {
      senderVpa: 'alice@demo',
      receiverVpa: 'bob@demo',
      amount: '123.45',
      pinHash: 'abcdef',
      nonce: '11111111-2222-3333-4444-555555555555',
      signedAt: Date.now(),
    };

    const ciphertext = hybridCryptoService.encrypt(original, serverKeyHolder.getPublicKey());
    const decrypted = hybridCryptoService.decrypt(ciphertext);

    expect(decrypted.senderVpa).toBe(original.senderVpa);
    expect(decrypted.receiverVpa).toBe(original.receiverVpa);
    expect(decrypted.amount).toBe(original.amount);
    expect(decrypted.nonce).toBe(original.nonce);
    expect(decrypted.signedAt).toBe(original.signedAt);
  });

  it('sameNonceWithDifferentCiphertextCannotSettleTwice', () => {
    const aliceBefore = new Decimal(accountRepository.findById('alice@demo')!.balance);
    const bobBefore = new Decimal(accountRepository.findById('bob@demo')!.balance);
    const signedAt = Date.now();
    const nonce = '99999999-8888-7777-6666-555555555555';

    // Two instructions sharing the exact same nonce
    const instruction1: PaymentInstruction = {
      senderVpa: 'alice@demo',
      receiverVpa: 'bob@demo',
      amount: '100.00',
      pinHash: 'hash-test',
      nonce,
      signedAt,
    };

    const instruction2: PaymentInstruction = {
      senderVpa: 'alice@demo',
      receiverVpa: 'bob@demo',
      amount: '100.00',
      pinHash: 'hash-test',
      nonce,
      signedAt,
    };

    // Encrypt independently — fresh AES key/IV guarantees distinct ciphertexts
    const ciphertext1 = hybridCryptoService.encrypt(instruction1, serverKeyHolder.getPublicKey());
    const ciphertext2 = hybridCryptoService.encrypt(instruction2, serverKeyHolder.getPublicKey());
    expect(ciphertext1).not.toBe(ciphertext2);

    const packet1: MeshPacket = {
      packetId: 'packet-1',
      ttl: 5,
      createdAt: signedAt,
      ciphertext: ciphertext1,
    };

    const packet2: MeshPacket = {
      packetId: 'packet-2',
      ttl: 5,
      createdAt: signedAt,
      ciphertext: ciphertext2,
    };

    const result1 = bridgeIngestionService.ingest(packet1, 'bridge-test-1', 1);
    const result2 = bridgeIngestionService.ingest(packet2, 'bridge-test-2', 1);

    expect(result1.outcome).toBe('SETTLED');
    expect(result2.outcome).not.toBe('SETTLED');
    expect(result2.outcome).toBe('DUPLICATE_DROPPED');
    expect(result2.reason).toBe('duplicate_payment_nonce');

    // Balance should only move once
    const aliceAfter = new Decimal(accountRepository.findById('alice@demo')!.balance);
    const bobAfter = new Decimal(accountRepository.findById('bob@demo')!.balance);

    expect(aliceBefore.minus(new Decimal('100.00')).toFixed(2)).toBe(aliceAfter.toFixed(2));
    expect(bobBefore.plus(new Decimal('100.00')).toFixed(2)).toBe(bobAfter.toFixed(2));
  });

  it('firstBridgeWinsBountyAndBroadcastsAckToClearMesh', async () => {
    meshSimulatorService.resetMesh();

    // 1. Create a packet and gossip it across the 5 devices
    const packet = demoService.createPacket('alice@demo', 'bob@demo', '75.00', '1234', 5);
    meshSimulatorService.inject('phone-alice', packet);
    const gossipRes = meshSimulatorService.gossipOnce();
    expect(gossipRes.transfers).toBe(4);

    // All 5 devices now hold the packet in their local buffers
    for (const d of meshSimulatorService.getDevices()) {
      expect(d.packetCount()).toBe(1);
    }

    // 2. Three bridges simultaneously upload the packet
    const results = await Promise.all([
      bridgeIngestionService.ingest(packet, 'bridge-winner-1', 2),
      bridgeIngestionService.ingest(packet, 'bridge-loser-2', 3),
      bridgeIngestionService.ingest(packet, 'bridge-loser-3', 4),
    ]);

    const settled = results.filter((r) => r.outcome === 'SETTLED');
    const duplicates = results.filter((r) => r.outcome === 'DUPLICATE_DROPPED');

    expect(settled).toHaveLength(1);
    expect(duplicates).toHaveLength(2);

    // 3. Upgrade 2: Winning bridge earns ₹0.50 bounty
    const db = getDatabase();
    const winningReward = db
      .prepare('SELECT * FROM bridge_rewards WHERE bridge_id = ?')
      .get('bridge-winner-1') as { total_reward_inr: string; packets_relayed: number } | undefined;

    expect(winningReward).toBeDefined();
    expect(winningReward!.total_reward_inr).toBe('0.50');
    expect(winningReward!.packets_relayed).toBe(1);

    // Loser duplicate bridges earned ₹0.00
    const loserReward = db
      .prepare('SELECT * FROM bridge_rewards WHERE bridge_id = ?')
      .get('bridge-loser-2');
    expect(loserReward).toBeUndefined();

    // 4. Upgrade 1: Reverse ACK clears buffers across ALL mesh phones
    for (const d of meshSimulatorService.getDevices()) {
      expect(d.packetCount()).toBe(0);
    }

    // Attempting to gossip again does 0 transfers because packet is settled
    const secondGossip = meshSimulatorService.gossipOnce();
    expect(secondGossip.transfers).toBe(0);
  });
});

