import { redis, K } from '../redis.js';
import { config } from '../config.js';

/**
 * Driver locking — the mechanism that makes concurrent matching safe.
 *
 * The problem: two riders request a ride at the same instant, in the same
 * place. Both dispatch loops run GEOSEARCH, both get back the same nearest
 * driver, and without coordination both send that driver an offer. Whoever's
 * accept lands second either overwrites the first ride or creates a second
 * one — the driver is double-booked.
 *
 * The fix is that claiming a driver is a single atomic Redis operation:
 *
 *     SET lock:driver:<id> <rideId> NX PX <ttl>
 *
 * `NX` means set-only-if-absent, and Redis executes commands one at a time, so
 * of N concurrent claims on the same driver exactly one returns OK. The losers
 * get null immediately and move on to their next candidate rather than
 * queueing, blocking, or retrying.
 *
 * Three properties matter here:
 *
 *  1. The lock is taken *before* the offer is sent, not after the driver
 *     accepts. The window between "offer shown" and "driver taps accept" is
 *     seconds long and is exactly where the race lives.
 *
 *  2. Every lock has a TTL. If the app crashes between locking and offering,
 *     the driver frees themselves after OFFER_TIMEOUT_MS instead of being
 *     stranded forever. On accept we PERSIST the lock (see holdForRide) so it
 *     survives for the length of the ride, and the ride's terminal transition
 *     releases it.
 *
 *  3. Unlocking is guarded by ownership (compare-and-delete in Lua). A naive
 *     DEL would let a timed-out dispatcher delete the lock of the ride that
 *     legitimately claimed the driver a moment later.
 *
 * Redis is the fast path. `rides_one_active_per_driver` in db/schema.sql is the
 * durable backstop — see the comment there.
 */

/**
 * Try to claim a driver for a ride.
 * @returns {Promise<boolean>} true if this caller won the driver.
 */
export async function tryLockDriver(driverId, rideId, ttlMs) {
  // Demo mode: behave like an implementation with no locking at all — every
  // caller "wins" the driver and they stay visible to concurrent searches.
  // This is what the race test is designed to catch.
  if (config.unsafeDisableLock) {
    await redis.set(K.driverLock(driverId), rideId, 'PX', ttlMs);
    return true;
  }

  const res = await redis.set(K.driverLock(driverId), rideId, 'PX', ttlMs, 'NX');
  if (res === 'OK') {
    // Pull them out of the matching index immediately so concurrent GEOSEARCH
    // callers do not even see them as a candidate.
    await redis.zrem(K.driversGeo, driverId);
    return true;
  }
  return false;
}

/** Release a lock, but only if this ride still owns it. */
export async function unlockDriver(driverId, rideId) {
  const removed = await redis.unlockDriver(K.driverLock(driverId), rideId);
  return removed === 1;
}

/** Turn a short offer lock into one held for the ride's duration (no TTL). */
export async function holdForRide(driverId, rideId) {
  const held = await redis.holdDriverLock(K.driverLock(driverId), rideId);
  if (held === 1) {
    await redis.set(K.driverRide(driverId), rideId);
    return true;
  }
  return false;
}

/** Which ride, if any, currently holds this driver. */
export const lockHolder = (driverId) => redis.get(K.driverLock(driverId));

/** The driver's active ride id (set once an offer is accepted). */
export const activeRideOf = (driverId) => redis.get(K.driverRide(driverId));

/** Full release at the end of a ride: drop the lock and the active-ride pointer. */
export async function releaseDriver(driverId, rideId) {
  await redis.unlockDriver(K.driverLock(driverId), rideId);
  await redis.del(K.driverRide(driverId));
}
