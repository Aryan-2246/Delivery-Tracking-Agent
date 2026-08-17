import Redis from 'ioredis';
import { config } from './config.js';

export const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

redis.on('error', (err) => console.error('[redis] error', err.message));

/**
 * Every Redis key this service owns, in one place.
 *
 *   drivers:geo            GEO set of *available* drivers (the matching index)
 *   driver:meta:<id>       HASH  { lat, lng, updatedAt, name, vehicle, plate }
 *   lock:driver:<id>       STRING rideId — the anti-double-booking lock
 *   driver:ride:<id>       STRING rideId — driver's current active ride
 *   ride:<id>              HASH  live ride snapshot, avoids a PG hit per GPS tick
 */
export const K = {
  driversGeo: 'drivers:geo',
  driverMeta: (id) => `driver:meta:${id}`,
  driverLock: (id) => `lock:driver:${id}`,
  driverRide: (id) => `driver:ride:${id}`,
  ride: (id) => `ride:${id}`,
};

// ------------------------------------------------------------------ scripts
//
// Each of these has to be atomic. Doing them as read-then-write from Node would
// reintroduce exactly the race the lock exists to prevent.

/**
 * Release a lock only if we still own it.
 * Guards against the classic bug: our lock expires, another ride grabs the
 * driver, and then our stale unlock deletes *their* lock.
 */
redis.defineCommand('unlockDriver', {
  numberOfKeys: 1,
  lua: `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('DEL', KEYS[1])
    end
    return 0
  `,
});

/**
 * Promote a short-lived offer lock into a held-for-the-ride lock.
 * Only the owner may do this, and only while the lock is still theirs.
 */
redis.defineCommand('holdDriverLock', {
  numberOfKeys: 1,
  lua: `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      return redis.call('PERSIST', KEYS[1])
    end
    return 0
  `,
});

/**
 * Update a driver's position, but only re-add them to the matching GEO index
 * if they are not currently locked to a ride. This keeps "busy" drivers out of
 * search results without needing a filtering pass on every query.
 *
 * KEYS: geo, meta, lock          ARGV: driverId, lng, lat, nowMs
 */
redis.defineCommand('updateDriverPosition', {
  numberOfKeys: 3,
  lua: `
    redis.call('HSET', KEYS[2], 'lat', ARGV[3], 'lng', ARGV[2], 'updatedAt', ARGV[4])
    if redis.call('EXISTS', KEYS[3]) == 1 then
      redis.call('ZREM', KEYS[1], ARGV[1])
      return 0
    end
    redis.call('GEOADD', KEYS[1], ARGV[2], ARGV[3], ARGV[1])
    return 1
  `,
});

export async function waitForRedis({ attempts = 30, delayMs = 1000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await redis.ping();
      return;
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
