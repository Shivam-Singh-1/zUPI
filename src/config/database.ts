import Database, { Database as DatabaseType } from 'better-sqlite3';
import path from 'node:path';

// -----------------------------------------------------------------------------
// SQLite Database Setup (WAL Mode & Persistence)
// -----------------------------------------------------------------------------

let instance: DatabaseType | null = null;

export function getDatabase(): DatabaseType {
  if (!instance) {
    const isTest = process.env.NODE_ENV === 'test';
    const dbPath = isTest ? ':memory:' : path.join(process.cwd(), 'zupi-ledger.db');

    instance = new Database(dbPath);

    // WAL Mode and Concurrency Pragmas
    if (!isTest) {
      instance.pragma('journal_mode = WAL');
      instance.pragma('synchronous = NORMAL');
    }
    instance.pragma('foreign_keys = ON');
    instance.pragma('busy_timeout = 5000'); // Wait up to 5s before failing on lock

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

    -- Upgrade 3: Persistent CAS Idempotency Gate (Survives Server Restarts)
    CREATE TABLE IF NOT EXISTS processed_packets (
      packet_hash TEXT PRIMARY KEY,
      bridge_node_id TEXT,
      claimed_at INTEGER NOT NULL
    );

    -- Upgrade 2: Bridge Node Micro-Reward Ledger
    CREATE TABLE IF NOT EXISTS bridge_rewards (
      bridge_id TEXT PRIMARY KEY,
      total_reward_inr TEXT NOT NULL DEFAULT '0.00',
      packets_relayed INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tx_packet_hash ON transactions(packet_hash);
    CREATE INDEX IF NOT EXISTS idx_tx_payment_nonce ON transactions(payment_nonce);
    CREATE INDEX IF NOT EXISTS idx_tx_settled_at ON transactions(settled_at DESC);
  `);
}

export function resetDatabase(): void {
  const db = getDatabase();
  db.exec(`
    DELETE FROM bridge_rewards;
    DELETE FROM processed_packets;
    DELETE FROM transactions;
    DELETE FROM accounts;
  `);
}
