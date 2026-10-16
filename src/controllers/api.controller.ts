import { Request, Response, Router } from 'express';
import { getDatabase } from '../config/database.js';
import { serverKeyHolder } from '../crypto/serverKeyHolder.js';
import { accountRepository } from '../repositories/account.repo.js';
import { transactionRepository } from '../repositories/transaction.repo.js';
import { bridgeIngestionService } from '../services/bridgeIngestion.service.js';
import { demoService } from '../services/demo.service.js';
import { idempotencyService } from '../services/idempotency.service.js';
import { meshSimulatorService } from '../services/meshSimulator.service.js';
import {
  DemoSendRequestSchema,
  FlushResultItem,
  MeshPacketSchema,
} from '../types/mesh.types.js';

export const apiRouter = Router();

// -----------------------------------------------------------------------------
// 1. Server Public Key
// -----------------------------------------------------------------------------
apiRouter.get('/server-key', (_req: Request, res: Response): void => {
  res.json({
    publicKey: serverKeyHolder.getPublicKeyBase64(),
    algorithm: 'RSA-2048 / OAEP-SHA256',
    hybridScheme: 'RSA-OAEP encrypts an AES-256-GCM session key',
  });
});

// -----------------------------------------------------------------------------
// 2. Demo Packet Creation & Mesh Injection
// -----------------------------------------------------------------------------
apiRouter.post('/demo/send', (req: Request, res: Response): void => {
  const parsed = DemoSendRequestSchema.parse(req.body);
  const ttl = parsed.ttl ?? 5;
  const startDevice = parsed.startDevice ?? 'phone-alice';

  const packet = demoService.createPacket(
    parsed.senderVpa,
    parsed.receiverVpa,
    parsed.amount,
    parsed.pin,
    ttl
  );

  meshSimulatorService.inject(startDevice, packet);

  res.json({
    packetId: packet.packetId,
    ciphertextPreview: `${packet.ciphertext.substring(0, 64)}...`,
    ttl: packet.ttl,
    injectedAt: startDevice,
  });
});

// -----------------------------------------------------------------------------
// 3. Mesh State
// -----------------------------------------------------------------------------
apiRouter.get('/mesh/state', (_req: Request, res: Response): void => {
  const devices = meshSimulatorService.getDevices().map((d) => ({
    deviceId: d.deviceId,
    hasInternet: d.hasInternet,
    packetCount: d.packetCount(),
    packetIds: d.getHeldPackets().map((p) => p.packetId.substring(0, 8)),
  }));

  res.json({
    devices,
    idempotencyCacheSize: idempotencyService.size(),
  });
});

// -----------------------------------------------------------------------------
// 4. Mesh Gossip Round
// -----------------------------------------------------------------------------
apiRouter.post('/mesh/gossip', (_req: Request, res: Response): void => {
  const result = meshSimulatorService.gossipOnce();
  res.json({
    transfers: result.transfers,
    deviceCounts: result.deviceCounts,
  });
});

// -----------------------------------------------------------------------------
// 5. Mesh Bridge Flush (Simulates 4G Bridge Upload Storm)
// -----------------------------------------------------------------------------
apiRouter.post('/mesh/flush', async (_req: Request, res: Response): Promise<void> => {
  const uploads = meshSimulatorService.collectBridgeUploads();

  // Execute uploads concurrently to exercise idempotency deduplication
  const results: FlushResultItem[] = await Promise.all(
    uploads.map(async (up) => {
      const hopCount = 5 - up.packet.ttl;
      const ingestRes = bridgeIngestionService.ingest(up.packet, up.bridgeNodeId, hopCount);

      return {
        bridgeNode: up.bridgeNodeId,
        packetId: up.packet.packetId.substring(0, 8),
        outcome: ingestRes.outcome,
        reason: ingestRes.reason ?? '',
        transactionId: ingestRes.transactionId ?? -1,
      };
    })
  );

  res.json({
    uploadsAttempted: uploads.length,
    results,
  });
});

// -----------------------------------------------------------------------------
// 6. Reset Mesh & Cache
// -----------------------------------------------------------------------------
apiRouter.post('/mesh/reset', (_req: Request, res: Response): void => {
  meshSimulatorService.resetMesh();
  idempotencyService.clear();
  res.json({ status: 'mesh and idempotency cache cleared' });
});

// -----------------------------------------------------------------------------
// 7. Production Bridge Ingest Endpoint
// -----------------------------------------------------------------------------
apiRouter.post('/bridge/ingest', (req: Request, res: Response): void => {
  const packet = MeshPacketSchema.parse(req.body);
  const bridgeNodeId = (req.headers['x-bridge-node-id'] as string) || 'unknown';
  const hopCountHeader = req.headers['x-hop-count'];
  const hopCount = hopCountHeader ? Number(hopCountHeader) : 0;

  const result = bridgeIngestionService.ingest(packet, bridgeNodeId, hopCount);
  res.json(result);
});

// -----------------------------------------------------------------------------
// 8. Accounts Listing
// -----------------------------------------------------------------------------
apiRouter.get('/accounts', (_req: Request, res: Response): void => {
  const accounts = accountRepository.findAll();
  res.json(accounts);
});

// -----------------------------------------------------------------------------
// 9. Transaction Ledger Listing
// -----------------------------------------------------------------------------
apiRouter.get('/transactions', (_req: Request, res: Response): void => {
  const transactions = transactionRepository.findTop20ByOrderByIdDesc();
  res.json(transactions);
});

// -----------------------------------------------------------------------------
// 10. Upgrade 2: Bridge Node Rewards Listing
// -----------------------------------------------------------------------------
apiRouter.get('/bridges/rewards', (_req: Request, res: Response): void => {
  const db = getDatabase();
  const rewards = db.prepare('SELECT * FROM bridge_rewards ORDER BY packets_relayed DESC').all();
  res.json({ bridges: rewards });
});
