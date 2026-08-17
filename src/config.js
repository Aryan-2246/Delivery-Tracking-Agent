import 'dotenv/config';

const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));

export const config = {
  port: num(process.env.PORT, 3000),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-me',
  databaseUrl: process.env.DATABASE_URL || 'postgres://tracking:tracking@localhost:5433/tracking',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6380',

  // Dispatch tuning
  searchRadiusM: num(process.env.SEARCH_RADIUS_M, 5000),
  // Offers actually made before giving up. Each one can cost OFFER_TIMEOUT_MS,
  // so this is what bounds a rider's worst-case wait.
  maxCandidates: num(process.env.MAX_CANDIDATES, 5),
  // Drivers examined before giving up, including those lost to a lock race.
  // Losing a race is ~1ms, so this can be far larger than maxCandidates.
  maxScanCandidates: num(process.env.MAX_SCAN_CANDIDATES, 60),
  offerTimeoutMs: num(process.env.OFFER_TIMEOUT_MS, 8000),
  driverStaleMs: num(process.env.DRIVER_STALE_MS, 30000),
  avgSpeedKmh: num(process.env.AVG_SPEED_KMH, 30),

  // Deliberately breaks driver locking. Exists so the race test can be shown to
  // fail against a naive implementation — a test that never fails proves
  // nothing. Never set this outside a demo. See sim/load-test-match.js.
  unsafeDisableLock: process.env.UNSAFE_DISABLE_LOCK === '1',
};

if (config.unsafeDisableLock) {
  console.warn('\n[config] ⚠  UNSAFE_DISABLE_LOCK=1 — driver locking is OFF. Double-booking is expected.\n');
}
