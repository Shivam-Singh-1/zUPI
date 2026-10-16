import { getDatabase } from '../config/database.js';
import { Transaction, TransactionRow, toTransactionEntity } from '../models/transaction.entity.js';

export class TransactionRepository {
  public existsByPaymentNonce(paymentNonce: string): boolean {
    const db = getDatabase();
    const stmt = db.prepare('SELECT 1 FROM transactions WHERE payment_nonce = ? LIMIT 1');
    const row = stmt.get(paymentNonce);
    return row !== undefined;
  }

  public existsByPacketHash(packetHash: string): boolean {
    const db = getDatabase();
    const stmt = db.prepare('SELECT 1 FROM transactions WHERE packet_hash = ? LIMIT 1');
    const row = stmt.get(packetHash);
    return row !== undefined;
  }

  public save(tx: Transaction): Transaction {
    const db = getDatabase();
    const stmt = db.prepare(`
      INSERT INTO transactions (
        packet_hash, payment_nonce, sender_vpa, receiver_vpa,
        amount, signed_at, settled_at, bridge_node_id, hop_count, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      tx.packetHash,
      tx.paymentNonce,
      tx.senderVpa,
      tx.receiverVpa,
      tx.amount,
      tx.signedAt,
      tx.settledAt,
      tx.bridgeNodeId,
      tx.hopCount,
      tx.status
    );

    return {
      ...tx,
      id: Number(result.lastInsertRowid),
    };
  }

  public findTop20ByOrderByIdDesc(): Transaction[] {
    const db = getDatabase();
    const stmt = db.prepare(`
      SELECT id, packet_hash, payment_nonce, sender_vpa, receiver_vpa,
             amount, signed_at, settled_at, bridge_node_id, hop_count, status
      FROM transactions
      ORDER BY id DESC
      LIMIT 20
    `);
    const rows = stmt.all() as TransactionRow[];
    return rows.map(toTransactionEntity);
  }
}

export const transactionRepository = new TransactionRepository();
