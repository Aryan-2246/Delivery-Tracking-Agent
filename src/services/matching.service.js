import { config } from '../config.js';
import { query, withTransaction, isUniqueViolation } from '../db.js';
import { redis, K } from '../redis.js';
import { hub } from '../ws/hub.js';
import * as geo from './geo.service.js';
import * as lock from './lock.service.js';
import { etaSeconds } from '../lib/geo.js';

/**
 * The dispatch loop.
 *
 * For one ride request:
 *
 *   1. GEOSEARCH for the nearest available drivers
 *   2. take the closest one we have not already tried
 *   3. atomically claim them  ── whoever loses this race skips to the next driver
 *   4. send the offer over WebSocket, wait up to OFFER_TIMEOUT_MS
 *   5. accepted → commit the match; rejected/timed out → release and go to 2
 *
 * Steps 3 and 4 are the interesting ones. The claim happens *before* the offer
 * is shown, so the several-second window in which a human is looking at an
 * offer is already exclusive. See lock.service.js for why that ordering is the
 * whole ballgame.
 */

export async function dispatch(ride) {
  const pickup = { lat: ride.pickup_lat, lng: ride.pickup_lng };
  const tried = new Set();
  const attempts = [];

  // Two separate budgets, because the two failure modes cost wildly different
  // amounts of time.
  //
  // An *offer* is expensive: we hold the driver and wait up to
  // OFFER_TIMEOUT_MS for a human to respond. `maxCandidates` caps those,
  // which is what bounds the rider's worst-case wait.
  //
  // A *lost lock race* is cheap: one Redis round-trip telling us someone else
  // claimed that driver first. Counting those against the offer budget was a
  // real bug — under heavy contention a rider would burn all five attempts on
  // already-claimed drivers and give up while free drivers sat one position
  // further down the list. Scanning past them costs almost nothing, so it gets
  // its own much larger budget.
  let offersMade = 0;

  for (let scan = 0; scan < config.maxScanCandidates; scan++) {
    if (offersMade >= config.maxCandidates) break;

    // Re-query each round: drivers move, go offline, and get claimed by other
    // rides while we are waiting on a human to tap a button.
    const candidates = await geo.findNearby(pickup.lat, pickup.lng, {
      radiusM: config.searchRadiusM,
      limit: tried.size + 10,
    });

    const candidate = candidates.find((c) => !tried.has(c.driverId));
    if (!candidate) break;
    tried.add(candidate.driverId);

    // (3) Atomic claim. Losing here is normal under concurrency, not an error.
    const won = await lock.tryLockDriver(candidate.driverId, ride.id, config.offerTimeoutMs);
    if (!won) {
      attempts.push({ driverId: candidate.driverId, response: 'lock_failed' });
      await recordOffer(ride.id, candidate.driverId, 'lock_failed');
      continue;
    }

    // A claimed driver who is not actually connected cannot answer; release
    // straight away rather than burning the full offer timeout.
    if (!hub.isDriverConnected(candidate.driverId)) {
      await lock.unlockDriver(candidate.driverId, ride.id);
      await geo.updatePosition(candidate.driverId, candidate.lat, candidate.lng);
      attempts.push({ driverId: candidate.driverId, response: 'timeout' });
      await recordOffer(ride.id, candidate.driverId, 'timeout');
      continue;
    }

    const offerId = await recordOffer(ride.id, candidate.driverId, null);
    offersMade++;

    // (4) Offer + wait.
    hub.sendToDriver(candidate.driverId, {
      type: 'ride:offer',
      ride: publicRide(ride),
      distanceMeters: candidate.distanceMeters,
      etaSeconds: etaSeconds(candidate, pickup, config.avgSpeedKmh),
      expiresInMs: config.offerTimeoutMs,
    });

    const response = await hub.waitForOffer(ride.id, candidate.driverId, config.offerTimeoutMs);
    await closeOffer(offerId, response);
    attempts.push({ driverId: candidate.driverId, response });

    if (response === 'accepted') {
      const matched = await confirmMatch(ride, candidate.driverId);
      if (matched) return { status: 'matched', ride: matched, driverId: candidate.driverId, attempts };

      // The DB backstop rejected the match (driver already live on another
      // ride). Redis and Postgres disagreed — trust Postgres, drop the lock.
      await lock.releaseDriver(candidate.driverId, ride.id);
      continue;
    }

    // Rejected or timed out: hand the driver back to the pool.
    await lock.unlockDriver(candidate.driverId, ride.id);
    await geo.updatePosition(candidate.driverId, candidate.lat, candidate.lng);
    hub.sendToDriver(candidate.driverId, { type: 'ride:offer_expired', rideId: ride.id });
  }

  const failed = await markNoDrivers(ride.id);
  return { status: 'no_drivers', ride: failed, attempts };
}

/**
 * Commit the match. The UPDATE is conditional on the ride still being in
 * `requested`, so a cancellation that lands mid-dispatch wins cleanly.
 * A unique violation here means the DB backstop caught a double-book.
 */
async function confirmMatch(ride, driverId) {
  try {
    const matched = await withTransaction(async (client) => {
      const { rows } = await client.query(
        `UPDATE rides
            SET driver_id = $1, status = 'matched', matched_at = now()
          WHERE id = $2 AND status = 'requested'
        RETURNING *`,
        [driverId, ride.id]
      );
      return rows[0] || null;
    });

    if (!matched) return null;

    await lock.holdForRide(driverId, ride.id);
    await cacheRide(matched);
    return matched;
  } catch (err) {
    if (isUniqueViolation(err)) {
      console.warn(
        `[dispatch] backstop fired: driver ${driverId} already has a live ride ` +
        `(ride ${ride.id} rejected by rides_one_active_per_driver)`
      );
      return null;
    }
    throw err;
  }
}

async function markNoDrivers(rideId) {
  const { rows } = await query(
    `UPDATE rides SET status = 'no_drivers'
      WHERE id = $1 AND status = 'requested'
    RETURNING *`,
    [rideId]
  );
  return rows[0] || null;
}

// ------------------------------------------------------------------ offers

async function recordOffer(rideId, driverId, response) {
  const { rows } = await query(
    `INSERT INTO ride_offers (ride_id, driver_id, response, responded_at)
     VALUES ($1, $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() END)
     RETURNING id`,
    [rideId, driverId, response]
  );
  return rows[0].id;
}

const closeOffer = (offerId, response) =>
  query(`UPDATE ride_offers SET response = $2, responded_at = now() WHERE id = $1`,
    [offerId, response]);

// ------------------------------------------------------------------ ride cache

/**
 * Mirror the live ride into Redis so a driver's position ping (which can arrive
 * several times a second, per driver) can be routed to the right rider without
 * touching Postgres.
 */
export async function cacheRide(ride) {
  await redis.hset(K.ride(ride.id), {
    riderId: ride.rider_id,
    driverId: ride.driver_id || '',
    status: ride.status,
    pickupLat: String(ride.pickup_lat),
    pickupLng: String(ride.pickup_lng),
    dropoffLat: String(ride.dropoff_lat),
    dropoffLng: String(ride.dropoff_lng),
  });
  await redis.expire(K.ride(ride.id), 24 * 3600);
}

export async function getCachedRide(rideId) {
  const h = await redis.hgetall(K.ride(rideId));
  if (!h || !h.riderId) return null;
  return {
    id: rideId,
    riderId: h.riderId,
    driverId: h.driverId || null,
    status: h.status,
    pickup: { lat: Number(h.pickupLat), lng: Number(h.pickupLng) },
    dropoff: { lat: Number(h.dropoffLat), lng: Number(h.dropoffLng) },
  };
}

export const dropCachedRide = (rideId) => redis.del(K.ride(rideId));

/**
 * Rebuild Redis live state from Postgres on boot.
 *
 * Postgres is durable; Redis is not (and is explicitly configured without
 * persistence here). After a restart — or a Redis flush — every in-flight ride
 * still exists in the database while its driver lock, active-ride pointer and
 * cached snapshot are gone. Left alone that diverges the two stores in the one
 * way that actually matters: a driver already carrying a rider would look
 * unlocked, and could be offered a second ride. The database backstop would
 * refuse the write, but only after the rider had been promised a car.
 *
 * Reconciling makes the durable record the source of truth at startup and
 * restores the invariant before the first request is served.
 */
export async function reconcileLiveRides() {
  const { rows } = await query(
    `SELECT * FROM rides WHERE status IN ('matched', 'in_progress') AND driver_id IS NOT NULL`
  );

  for (const ride of rows) {
    // No TTL: these locks are held for the duration of the ride, exactly as
    // holdForRide would have left them.
    await redis.set(K.driverLock(ride.driver_id), ride.id);
    await redis.set(K.driverRide(ride.driver_id), ride.id);
    await redis.zrem(K.driversGeo, ride.driver_id);
    await cacheRide(ride);
  }

  return rows.length;
}

// ------------------------------------------------------------------ shaping

export function publicRide(ride) {
  return {
    id: ride.id,
    status: ride.status,
    riderId: ride.rider_id,
    driverId: ride.driver_id,
    pickup: { lat: ride.pickup_lat, lng: ride.pickup_lng },
    dropoff: { lat: ride.dropoff_lat, lng: ride.dropoff_lng },
    requestedAt: ride.requested_at,
    matchedAt: ride.matched_at,
    startedAt: ride.started_at,
    completedAt: ride.completed_at,
  };
}
