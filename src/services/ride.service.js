import { query, isUniqueViolation } from '../db.js';
import { hub } from '../ws/hub.js';
import * as geo from './geo.service.js';
import * as lock from './lock.service.js';
import {
  dispatch, publicRide, cacheRide, dropCachedRide,
} from './matching.service.js';

/** Thrown for expected, user-facing failures. Mapped to HTTP status in routes. */
export class RideError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const TERMINAL = new Set(['completed', 'cancelled', 'no_drivers']);

/**
 * Create a ride and kick off dispatch.
 *
 * Dispatch is deliberately *not* awaited by the HTTP request: it can take tens
 * of seconds while drivers are offered the ride one by one. The rider's app
 * gets an immediate 201 with status `requested` and learns the outcome over the
 * WebSocket. That also keeps the request thread free under load.
 */
export async function requestRide(riderId, pickup, dropoff) {
  let ride;
  try {
    const { rows } = await query(
      `INSERT INTO rides (rider_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [riderId, pickup.lat, pickup.lng, dropoff.lat, dropoff.lng]
    );
    ride = rows[0];
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new RideError(409, 'You already have an active ride');
    }
    throw err;
  }

  await cacheRide(ride);

  // Fire and forget; failures are reported to the rider over the socket.
  dispatch(ride)
    .then((result) => notifyDispatchResult(ride, result))
    .catch(async (err) => {
      console.error('[dispatch] failed for ride', ride.id, err);
      await query(
        `UPDATE rides SET status = 'no_drivers' WHERE id = $1 AND status = 'requested'`,
        [ride.id]
      );
      hub.sendToUser(ride.rider_id, {
        type: 'ride:no_drivers', rideId: ride.id, reason: 'dispatch_error',
      });
    });

  return ride;
}

async function notifyDispatchResult(ride, result) {
  if (result.status === 'matched') {
    const driver = await driverCard(result.driverId);
    hub.sendToUser(ride.rider_id, {
      type: 'ride:matched',
      ride: publicRide(result.ride),
      driver,
    });
    hub.sendToDriver(result.driverId, {
      type: 'ride:assigned',
      ride: publicRide(result.ride),
    });
  } else {
    hub.sendToUser(ride.rider_id, {
      type: 'ride:no_drivers',
      rideId: ride.id,
      attempts: result.attempts,
    });
  }
}

/** Driver details shown to a rider once matched. Position comes from Redis. */
export async function driverCard(driverId) {
  const { rows } = await query(
    `SELECT d.id, d.vehicle, d.plate, u.name
       FROM drivers d JOIN users u ON u.id = d.user_id
      WHERE d.id = $1`,
    [driverId]
  );
  if (!rows[0]) return null;
  const position = await geo.getPosition(driverId);
  return { ...rows[0], position };
}

// ------------------------------------------------------------- transitions

export async function startRide(rideId, driverId) {
  const ride = await transition(rideId, 'matched', 'in_progress', 'started_at', { driverId });
  await cacheRide(ride);
  broadcastStatus(ride);
  return ride;
}

export async function completeRide(rideId, driverId) {
  const ride = await transition(rideId, 'in_progress', 'completed', 'completed_at', { driverId });
  await lock.releaseDriver(driverId, rideId);
  await dropCachedRide(rideId);

  // Put the driver straight back into the available pool at their last position.
  const position = await geo.getPosition(driverId);
  if (position) await geo.updatePosition(driverId, position.lat, position.lng);

  broadcastStatus(ride);
  return ride;
}

/** A rider may cancel any time before the ride starts. */
export async function cancelRide(rideId, riderId) {
  const { rows } = await query(
    `UPDATE rides SET status = 'cancelled'
      WHERE id = $1 AND rider_id = $2 AND status IN ('requested', 'matched')
    RETURNING *`,
    [rideId, riderId]
  );
  const ride = rows[0];
  if (!ride) throw new RideError(409, 'Ride cannot be cancelled in its current state');

  if (ride.driver_id) {
    await lock.releaseDriver(ride.driver_id, rideId);
    const position = await geo.getPosition(ride.driver_id);
    if (position) await geo.updatePosition(ride.driver_id, position.lat, position.lng);
  }
  await dropCachedRide(rideId);
  broadcastStatus(ride);
  return ride;
}

/**
 * Guarded state change. The WHERE clause pins the expected current status, so
 * two concurrent transition attempts cannot both succeed — the second one
 * matches zero rows and throws.
 */
async function transition(rideId, from, to, timestampColumn, { driverId }) {
  const { rows } = await query(
    `UPDATE rides
        SET status = $3, ${timestampColumn} = now()
      WHERE id = $1 AND status = $2 AND driver_id = $4
    RETURNING *`,
    [rideId, from, to, driverId]
  );
  if (!rows[0]) {
    throw new RideError(409, `Ride is not in state '${from}'`);
  }
  return rows[0];
}

function broadcastStatus(ride) {
  const payload = { type: 'ride:status', ride: publicRide(ride) };
  hub.sendToUser(ride.rider_id, payload);
  if (ride.driver_id) hub.sendToDriver(ride.driver_id, payload);
}

// ------------------------------------------------------------------ queries

export async function getRide(rideId) {
  const { rows } = await query(`SELECT * FROM rides WHERE id = $1`, [rideId]);
  return rows[0] || null;
}

export async function activeRideForRider(riderId) {
  const { rows } = await query(
    `SELECT * FROM rides
      WHERE rider_id = $1 AND status IN ('requested', 'matched', 'in_progress')
      ORDER BY requested_at DESC LIMIT 1`,
    [riderId]
  );
  return rows[0] || null;
}

export async function activeRideForDriver(driverId) {
  const { rows } = await query(
    `SELECT * FROM rides
      WHERE driver_id = $1 AND status IN ('matched', 'in_progress')
      ORDER BY requested_at DESC LIMIT 1`,
    [driverId]
  );
  return rows[0] || null;
}

export async function rideHistory(userId, { asDriver = false, limit = 20 } = {}) {
  const { rows } = await query(
    asDriver
      ? `SELECT r.* FROM rides r JOIN drivers d ON d.id = r.driver_id
          WHERE d.user_id = $1 ORDER BY r.requested_at DESC LIMIT $2`
      : `SELECT * FROM rides WHERE rider_id = $1 ORDER BY requested_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

export const isTerminal = (status) => TERMINAL.has(status);
