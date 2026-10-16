import { env } from '../config/env.js';
import { HybridCryptoService, hybridCryptoService } from '../crypto/hybridCrypto.service.js';
import { IngestResult, MeshPacket, PaymentInstruction } from '../types/mesh.types.js';
import { IdempotencyService, idempotencyService } from './idempotency.service.js';
import { SettlementService, settlementService } from './settlement.service.js';

export class BridgeIngestionService {
  constructor(
    private readonly crypto: HybridCryptoService = hybridCryptoService,
    private readonly idempotency: IdempotencyService = idempotencyService,
    private readonly settlement: SettlementService = settlementService,
    private readonly maxAgeSeconds: number = env.PACKET_MAX_AGE_SECONDS,
    private readonly clockSkewToleranceSeconds: number = env.CLOCK_SKEW_TOLERANCE_SECONDS
  ) {}

  public ingest(packet: MeshPacket, bridgeNodeId: string, hopCount: number): IngestResult {
    try {
      const packetHash = this.crypto.hashCiphertext(packet.ciphertext);

      // 1. Idempotency Gate (Synchronous atomic CAS)
      if (!this.idempotency.claim(packetHash)) {
        console.info(
          { packetHashPreview: packetHash.substring(0, 12), bridgeNodeId },
          'DUPLICATE packet dropped via idempotency cache'
        );
        return {
          outcome: 'DUPLICATE_DROPPED',
          packetHash,
          reason: 'duplicate_packet_hash',
          transactionId: null,
        };
      }

      // 2. Cryptographic Decryption & Authentication
      let instruction: PaymentInstruction;
      try {
        instruction = this.crypto.decrypt(packet.ciphertext);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        console.warn(
          { packetHashPreview: packetHash.substring(0, 12), error: errorMsg },
          'Decryption failed — rejecting packet'
        );
        return {
          outcome: 'INVALID',
          packetHash,
          reason: 'decryption_failed',
          transactionId: null,
        };
      }

      // 3. Freshness Check (Replay window protection)
      const ageSeconds = (Date.now() - instruction.signedAt) / 1000;
      if (ageSeconds > this.maxAgeSeconds) {
        console.warn(
          { packetHashPreview: packetHash.substring(0, 12), ageSeconds },
          'Packet too old — rejected as stale'
        );
        return {
          outcome: 'INVALID',
          packetHash,
          reason: 'stale_packet',
          transactionId: null,
        };
      }

      if (ageSeconds < -this.clockSkewToleranceSeconds) {
        console.warn(
          { packetHashPreview: packetHash.substring(0, 12), ageSeconds },
          'Packet has future timestamp beyond tolerance window'
        );
        return {
          outcome: 'INVALID',
          packetHash,
          reason: 'future_dated',
          transactionId: null,
        };
      }

      // 4. Ledger Settlement
      try {
        const tx = this.settlement.settle(instruction, packetHash, bridgeNodeId, hopCount);
        return {
          outcome: 'SETTLED',
          packetHash,
          reason: null,
          transactionId: tx.id ?? null,
        };
      } catch (err) {
        if (err instanceof Error && err.message === 'DUPLICATE_PAYMENT_NONCE') {
          console.info(
            { nonce: instruction.nonce, packetHashPreview: packetHash.substring(0, 12) },
            'Duplicate payment nonce dropped'
          );
          return {
            outcome: 'DUPLICATE_DROPPED',
            packetHash,
            reason: 'duplicate_payment_nonce',
            transactionId: null,
          };
        }
        throw err;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error({ error: errorMsg }, 'Ingestion pipeline error');
      return {
        outcome: 'INVALID',
        packetHash: '?',
        reason: `internal_error: ${errorMsg}`,
        transactionId: null,
      };
    }
  }
}

export const bridgeIngestionService = new BridgeIngestionService();
