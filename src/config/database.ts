import Database, { Database as DatabaseType } from 'better-sqlite3';

// -----------------------------------------------------------------------------
// In-Memory SQLite Database Setup
// -----------------------------------------------------------------------------

let instance: DatabaseType | null = null;

export function getDatabase(): DatabaseType {
  if (!instance) {
    instance = new Database(':memory:');
    // Enable WAL mode and foreign keys for high-performance and relational integrity
    instance.pragma('journal_mode = WAL');
    instance.pragma('foreign_keys = ON');
    initSchema(instance);
  }
  return instance;
}

export function initSchema(db: DatabaseType): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      vpa TEXT PRIMARY KEY,
      holder_name TEXT NOT NULL,
      balance TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      packet_hash TEXT NOT NULL UNIQUE,
      payment_nonce TEXT NOT NULL UNIQUE,
      sender_vpa TEXT NOT NULL,
      receiver_vpa TEXT NOT NULL,
      amount TEXT NOT NULL,
      signed_at TEXT NOT NULL,
      settled_at TEXT NOT NULL,
      bridge_node_id TEXT NOT NULL,
      hop_count INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('SETTLED', 'REJECTED'))
    );

    CREATE INDEX IF NOT EXISTS idx_tx_packet_hash ON transactions(packet_hash);
    CREATE INDEX IF NOT EXISTS idx_tx_payment_nonce ON transactions(payment_nonce);
    CREATE INDEX IF NOT EXISTS idx_tx_settled_at ON transactions(settled_at DESC);
  `);
}

export function resetDatabase(): void {
  const db = getDatabase();
  db.exec(`
    DELETE FROM transactions;
    DELETE FROM accounts;
  `);
}
