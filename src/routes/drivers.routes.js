import { Router } from 'express';
import { requireAuth, requireDriver } from '../auth.js';
import { query } from '../db.js';
import * as geo from '../services/geo.service.js';
import * as lock from '../services/lock.service.js';
import { activeRideForDriver } from '../services/ride.service.js';
import { publicRide } from '../services/matching.service.js';
import { isValidCoord } from '../lib/geo.js';
import { config } from '../config.js';

export const driverRoutes = Router();

/** Current driver's own state: online flag, position, lock and active ride. */
driverRoutes.get('/me', requireAuth, requireDriver, async (req, res, next) => {
  try {
    const { driverId } = req.user;
    const { rows } = await query(
      `SELECT d.id, d.vehicle, d.plate, d.is_online, u.name
         FROM drivers d JOIN users u ON u.id = d.user_id WHERE d.id = $1`,
      [driverId]
    );
    const ride = await activeRideForDriver(driverId);
    res.json({
      driver: rows[0],
      position: await geo.getPosition(driverId),
      lockedToRide: await lock.lockHolder(driverId),
      activeRide: ride ? publicRide(ride) : null,
    });
  } catch (err) { next(err); }
});

/**
 * Go online. Position is optional here — a driver can flip the switch before
 * the first GPS fix lands, and the first WebSocket location ping will insert
 * them into the matching index.
 */
driverRoutes.post('/online', requireAuth, requireDriver, async (req, res, next) => {
  try {
    const { driverId, name } = req.user;
    const { lat, lng } = req.body || {};

    const { rows } = await query(
      `UPDATE drivers SET is_online = true WHERE id = $1 RETURNING vehicle, plate`,
      [driverId]
    );
    const inPool = await geo.goOnline(driverId, Number(lat), Number(lng), {
      name, vehicle: rows[0].vehicle, plate: rows[0].plate,
    });

    res.json({ online: true, inMatchingPool: inPool });
  } catch (err) { next(err); }
});

driverRoutes.post('/offline', requireAuth, requireDriver, async (req, res, next) => {
  try {
    const { driverId } = req.user;
    const ride = await activeRideForDriver(driverId);
    if (ride) {
      return res.status(409).json({ error: 'finish your active ride before going offline' });
    }
    await query(`UPDATE drivers SET is_online = false WHERE id = $1`, [driverId]);
    await geo.goOffline(driverId);
    res.json({ online: false });
  } catch (err) { next(err); }
});

/**
 * HTTP location update. The WebSocket path is the real one (see ws/handlers.js);
 * this exists for clients without a socket and for scripted testing.
 */
driverRoutes.post('/location', requireAuth, requireDriver, async (req, res, next) => {
  try {
    const lat = Number(req.body?.lat);
    const lng = Number(req.body?.lng);
    if (!isValidCoord(lat, lng)) return res.status(400).json({ error: 'invalid lat/lng' });

    const inPool = await geo.updatePosition(req.user.driverId, lat, lng);
    res.json({ ok: true, inMatchingPool: inPool });
  } catch (err) { next(err); }
});

/**
 * Nearest-driver search — the Phase 2 deliverable, exposed directly so the
 * geospatial layer can be verified without going through a ride request.
 */
driverRoutes.get('/nearby', async (req, res, next) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (!isValidCoord(lat, lng)) return res.status(400).json({ error: 'invalid lat/lng' });

    const radiusM = Number(req.query.radius) || config.searchRadiusM;
    const limit = Math.min(Number(req.query.limit) || 10, 100);

    const drivers = await geo.findNearby(lat, lng, { radiusM, limit });
    res.json({
      query: { lat, lng, radiusM, limit },
      availableTotal: await geo.availableCount(),
      count: drivers.length,
      drivers,
    });
  } catch (err) { next(err); }
});
