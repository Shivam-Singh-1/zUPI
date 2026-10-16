import { getDatabase } from '../config/database.js';
import { env } from '../config/env.js';

// -----------------------------------------------------------------------------
// Two-Tier Idempotency Service (In-Memory Fast Path + SQLite WAL Persistence)
// -----------------------------------------------------------------------------

export class IdempotencyService {
  private readonly seen = new Map<string, number>();
  private evictionTimer: NodeJS.Timeout | null = null;

  constructor(private readonly ttlSeconds: number = env.IDEMPOTENCY_TTL_SECONDS) {
    this.loadPersistedClaims();
    this.startEvictionScheduler();
  }

  /**
   * Pre-loads existing claims from SQLite into the in-memory cache upon startup
   * to ensure zero-millisecond rejection across server restarts.
   */
  private loadPersistedClaims(): void {
    try {
      const db = getDatabase();
      const rows = db.prepare('SELECT packet_hash, claimed_at FROM processed_packets').all() as {
        packet_hash: string;
        claimed_at: number;
      }[];
      for (const row of rows) {
        this.seen.set(row.packet_hash, row.claimed_at);
      }
    } catch {
      // In case table not ready yet or mock
    }
  }

  /**
   * Tries to claim a hash atomically.
   *
   * Fast Path: 0ms synchronous in-memory rejection.
   * Persistent Path: Atomic SQLite INSERT OR IGNORE surviving server restarts.
   */
  public claim(packetHash: string, bridgeNodeId: string = 'unknown'): boolean {
    // 1. Fast Path (In-Memory 0ms check)
    if (this.seen.has(packetHash)) {
      return false;
    }

    // 2. Persistent Atomic Check (Survives server restarts)
    try {
      const db = getDatabase();
      const insertClaimStmt = db.prepare(`
        INSERT OR IGNORE INTO processed_packets (packet_hash, bridge_node_id, claimed_at)
        VALUES (?, ?, ?)
      `);
      const result = insertClaimStmt.run(packetHash, bridgeNodeId, Date.now());

      if (result.changes === 1) {
        this.seen.set(packetHash, Date.now());
        return true; // Lock won!
      }

      this.seen.set(packetHash, Date.now());
      return false; // Already processed before restart
    } catch {
      // Fallback to in-memory atomic CAS if DB offline
      this.seen.set(packetHash, Date.now());
      return true;
    }
  }

  public size(): number {
    return this.seen.size;
  }

  public evictExpired(): void {
    const cutoff = Date.now() - this.ttlSeconds * 1000;
    for (const [hash, timestamp] of this.seen.entries()) {
      if (timestamp < cutoff) {
        this.seen.delete(hash);
      }
    }
    try {
      const db = getDatabase();
      db.prepare('DELETE FROM processed_packets WHERE claimed_at < ?').run(cutoff);
    } catch {
      // Ignore if DB busy
    }
  }

  public clear(): void {
    this.seen.clear();
    try {
      const db = getDatabase();
      db.prepare('DELETE FROM processed_packets').run();
    } catch {
      // Ignore
    }
  }

  public startEvictionScheduler(): void {
    if (!this.evictionTimer) {
      this.evictionTimer = setInterval(() => {
        this.evictExpired();
      }, 60_000);
      this.evictionTimer.unref();
    }
  }

  public stopEvictionScheduler(): void {
    if (this.evictionTimer) {
      clearInterval(this.evictionTimer);
      this.evictionTimer = null;
    }
  }
}

export const idempotencyService = new IdempotencyService();
