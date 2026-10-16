// -----------------------------------------------------------------------------
// Environment configuration — maps Spring Boot's application.properties to
// typed constants with environment-variable overrides.
// -----------------------------------------------------------------------------

export const env = {
  /** HTTP port for the Express server. */
  PORT: process.env.PORT ? Number(process.env.PORT) : 8080,

  /** Allowed CORS origin for the dashboard frontend. */
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN ?? 'http://localhost:5174',

  /**
   * How long (in seconds) a ciphertext hash stays in the in-memory idempotency
   * cache before it is evicted. Default: 24 hours.
   */
  IDEMPOTENCY_TTL_SECONDS: process.env.IDEMPOTENCY_TTL_SECONDS
    ? Number(process.env.IDEMPOTENCY_TTL_SECONDS)
    : 86_400,

  /**
   * Maximum age (in seconds) for a valid packet. Anything signed earlier than
   * this window is rejected as a potential replay. Default: 24 hours.
   */
  PACKET_MAX_AGE_SECONDS: process.env.PACKET_MAX_AGE_SECONDS
    ? Number(process.env.PACKET_MAX_AGE_SECONDS)
    : 86_400,

  /**
   * Clock-skew tolerance (in seconds) for future-dated packets. Packets with
   * signedAt more than this many seconds in the future are rejected.
   */
  CLOCK_SKEW_TOLERANCE_SECONDS: 300,
} as const;
