import { redis, K } from '../redis.js';
import { config } from '../config.js';
import { isValidCoord } from '../lib/geo.js';

/**
 * Driver location index, backed entirely by Redis.
 *
 * `drivers:geo` is a sorted set whose scores are geohash-encoded lat/lng, which
 * is what lets GEOSEARCH do a real nearest-neighbour query rather than a table
 * scan. Membership of that set *is* the definition of "available": a driver is
 * added when they go online, removed when they go offline or get locked to a
 * ride. That means the hot matching query never has to filter out busy drivers.
 */

/** Record a position ping. Returns true if the driver is in the available index. */
export async function updatePosition(driverId, lat, lng, meta = {}) {
  if (!isValidCoord(lat, lng)) throw new Error('invalid coordinates');

  const available = await redis.updateDriverPosition(
    K.driversGeo,
    K.driverMeta(driverId),
    K.driverLock(driverId),
    driverId,
    String(lng),
    String(lat),
    String(Date.now())
  );

  if (Object.keys(meta).length) {
    await redis.hset(K.driverMeta(driverId), meta);
  }
  return available === 1;
}

/** Put a driver into the available pool (going online). */
export async function goOnline(driverId, lat, lng, meta = {}) {
  await redis.hset(K.driverMeta(driverId), { ...meta, online: '1' });
  if (isValidCoord(lat, lng)) return updatePosition(driverId, lat, lng);
  return false;
}

/** Remove a driver from the available pool. Position metadata is kept. */
export async function goOffline(driverId) {
  await redis.zrem(K.driversGeo, driverId);
  await redis.hset(K.driverMeta(driverId), { online: '0' });
}

export async function getPosition(driverId) {
  const meta = await redis.hgetall(K.driverMeta(driverId));
  if (!meta || meta.lat === undefined) return null;
  return {
    lat: Number(meta.lat),
    lng: Number(meta.lng),
    updatedAt: Number(meta.updatedAt),
    name: meta.name,
    vehicle: meta.vehicle,
    plate: meta.plate,
  };
}

/**
 * Nearest available drivers to a point, closest first.
 *
 * GEOSEARCH ... BYRADIUS ... ASC does the heavy lifting in Redis. The only
 * post-filter is staleness: a driver whose last ping is older than
 * DRIVER_STALE_MS has probably lost connectivity, and dispatching to them just
 * burns an offer timeout.
 */
export async function findNearby(lat, lng, {
  radiusM = config.searchRadiusM,
  limit = 10,
  includeStale = false,
} = {}) {
  if (!isValidCoord(lat, lng)) throw new Error('invalid coordinates');

  // COUNT is intentionally over-fetched (x3) so that dropping stale drivers
  // still leaves a usable candidate list.
  const raw = await redis.geosearch(
    K.driversGeo,
    'FROMLONLAT', String(lng), String(lat),
    'BYRADIUS', String(radiusM), 'm',
    'ASC',
    'COUNT', String(limit * 3),
    'WITHCOORD', 'WITHDIST'
  );

  const now = Date.now();
  const results = [];

  for (const [driverId, distance, coords] of raw) {
    const updatedAt = Number(await redis.hget(K.driverMeta(driverId), 'updatedAt')) || 0;
    const ageMs = now - updatedAt;
    if (!includeStale && ageMs > config.driverStaleMs) continue;

    results.push({
      driverId,
      distanceMeters: Math.round(Number(distance)),
      lng: Number(coords[0]),
      lat: Number(coords[1]),
      ageMs,
    });
    if (results.length >= limit) break;
  }

  return results;
}

/** Total drivers currently in the available pool. */
export const availableCount = () => redis.zcard(K.driversGeo);
