import { z } from 'zod';

// -----------------------------------------------------------------------------
// Mesh Wire Format
// -----------------------------------------------------------------------------

/**
 * Zod validation schema for inbound wire-format mesh packets.
 */
export const MeshPacketSchema = z.object({
  packetId: z.string().min(1, 'packetId is required'),
  ttl: z.number().int().min(0, 'ttl must be >= 0'),
  createdAt: z.number().int().positive('createdAt must be a valid epoch millis timestamp'),
  ciphertext: z.string().min(1, 'ciphertext is required'),
});

export type MeshPacket = z.infer<typeof MeshPacketSchema>;

// -----------------------------------------------------------------------------
// Decrypted Payment Instruction
// -----------------------------------------------------------------------------

/**
 * Payload contained inside the encrypted ciphertext.
 */
export const PaymentInstructionSchema = z.object({
  senderVpa: z.string().min(1),
  receiverVpa: z.string().min(1),
  amount: z.union([z.string(), z.number()]).transform((val) => String(val)),
  pinHash: z.string().min(1),
  nonce: z.string().uuid(),
  signedAt: z.number().int().positive(),
});

export interface PaymentInstruction {
  senderVpa: string;
  receiverVpa: string;
  amount: string; // Serialized as exact decimal string e.g. "100.00"
  pinHash: string;
  nonce: string; // Unique UUID
  signedAt: number; // Epoch millis
}

// -----------------------------------------------------------------------------
// Bridge Ingestion Results
// -----------------------------------------------------------------------------

export type IngestOutcome = 'SETTLED' | 'DUPLICATE_DROPPED' | 'INVALID';

export interface IngestResult {
  outcome: IngestOutcome;
  packetHash: string;
  reason: string | null;
  transactionId: number | null;
}

// -----------------------------------------------------------------------------
// REST API Request / Response DTOs
// -----------------------------------------------------------------------------

export const DemoSendRequestSchema = z.object({
  senderVpa: z.string().min(1),
  receiverVpa: z.string().min(1),
  amount: z.union([z.string(), z.number()]).transform((val) => String(val)),
  pin: z.string().min(1),
  ttl: z.number().int().min(0).optional().default(5),
  startDevice: z.string().optional().default('phone-alice'),
});

export type DemoSendRequest = z.infer<typeof DemoSendRequestSchema>;

export interface DemoSendResponse {
  packetId: string;
  ciphertextPreview: string;
  ttl: number;
  injectedAt: string;
}

export interface DeviceStateDto {
  deviceId: string;
  hasInternet: boolean;
  packetCount: number;
  packetIds: string[];
}

export interface MeshStateResponse {
  devices: DeviceStateDto[];
  idempotencyCacheSize: number;
}

export interface GossipResponse {
  transfers: number;
  deviceCounts: Record<string, number>;
}

export interface FlushResultItem {
  bridgeNode: string;
  packetId: string;
  outcome: IngestOutcome;
  reason: string;
  transactionId: number;
}

export interface FlushResponse {
  uploadsAttempted: number;
  results: FlushResultItem[];
}
