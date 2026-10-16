import { env } from '../config/env.js';

// -----------------------------------------------------------------------------
// In-Memory Idempotency Service — Atomic Compare-And-Swap Cache
// -----------------------------------------------------------------------------

export class IdempotencyService {
  private readonly seen = new Map<string, number>();
  private evictionTimer: NodeJS.Timeout | null = null;

  constructor(private readonly ttlSeconds: number = env.IDEMPOTENCY_TTL_SECONDS) {
    this.startEvictionScheduler();
  }

  /**
   * Tries to claim a hash. Returns true on first claim, false on duplicate.
   *
   * Crucial guarantee: Because JS is single-threaded and this method has no
   * `await` points, checking `has()` and calling `set()` is strictly synchronous
   * and atomic on the event loop, equivalent to Redis SETNX or ConcurrentHashMap.putIfAbsent.
   */
  public claim(packetHash: string): boolean {
    if (this.seen.has(packetHash)) {
      return false;
    }
    this.seen.set(packetHash, Date.now());
    return true;
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
  }

  public clear(): void {
    this.seen.clear();
  }

  public startEvictionScheduler(): void {
    if (!this.evictionTimer) {
      this.evictionTimer = setInterval(() => {
        this.evictExpired();
      }, 60_000);
      // unref allows Node to exit cleanly during tests or process shutdown
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
