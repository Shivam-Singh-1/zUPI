// -----------------------------------------------------------------------------
// Transaction Entity
// -----------------------------------------------------------------------------

export type TransactionStatus = 'SETTLED' | 'REJECTED';

export interface Transaction {
  id?: number;
  packetHash: string;
  paymentNonce: string;
  senderVpa: string;
  receiverVpa: string;
  amount: string;
  signedAt: string; // ISO 8601 string
  settledAt: string; // ISO 8601 string
  bridgeNodeId: string;
  hopCount: number;
  status: TransactionStatus;
}

export interface TransactionRow {
  id: number;
  packet_hash: string;
  payment_nonce: string;
  sender_vpa: string;
  receiver_vpa: string;
  amount: string;
  signed_at: string;
  settled_at: string;
  bridge_node_id: string;
  hop_count: number;
  status: TransactionStatus;
}

export function toTransactionEntity(row: TransactionRow): Transaction {
  return {
    id: row.id,
    packetHash: row.packet_hash,
    paymentNonce: row.payment_nonce,
    senderVpa: row.sender_vpa,
    receiverVpa: row.receiver_vpa,
    amount: row.amount,
    signedAt: row.signed_at,
    settledAt: row.settled_at,
    bridgeNodeId: row.bridge_node_id,
    hopCount: row.hop_count,
    status: row.status,
  };
}
