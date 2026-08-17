import { Router } from 'express';
import { requireAuth, requireDriver } from '../auth.js';
import { isValidCoord, etaSeconds } from '../lib/geo.js';
import { config } from '../config.js';
import * as geo from '../services/geo.service.js';
import { publicRide } from '../services/matching.service.js';
import {
  requestRide, cancelRide, startRide, completeRide,
  getRide, activeRideForRider, activeRideForDriver, driverCard, rideHistory,
} from '../services/ride.service.js';

export const rideRoutes = Router();

const point = (body, prefix) => ({
  lat: Number(body?.[`${prefix}Lat`] ?? body?.[prefix]?.lat),
  lng: Number(body?.[`${prefix}Lng`] ?? body?.[prefix]?.lng),
});

/** Request a ride. Returns immediately; matching happens over the WebSocket. */
rideRoutes.post('/', requireAuth, async (req, res, next) => {
  try {
    const pickup = point(req.body, 'pickup');
    const dropoff = point(req.body, 'dropoff');
    if (!isValidCoord(pickup.lat, pickup.lng)) return res.status(400).json({ error: 'invalid pickup' });
    if (!isValidCoord(dropoff.lat, dropoff.lng)) return res.status(400).json({ error: 'invalid dropoff' });

    const ride = await requestRide(req.user.userId, pickup, dropoff);
    res.status(201).json({ ride: publicRide(ride) });
  } catch (err) { next(err); }
});

/** The caller's current open ride, whichever side they are on. */
rideRoutes.get('/active', requireAuth, async (req, res, next) => {
  try {
    const ride = req.user.role === 'driver' && req.user.driverId
      ? await activeRideForDriver(req.user.driverId)
      : await activeRideForRider(req.user.userId);

    if (!ride) return res.json({ ride: null });

    res.json({
      ride: publicRide(ride),
      driver: ride.driver_id ? await driverCard(ride.driver_id) : null,
    });
  } catch (err) { next(err); }
});

rideRoutes.get('/history', requireAuth, async (req, res, next) => {
  try {
    const rides = await rideHistory(req.user.userId, { asDriver: req.user.role === 'driver' });
    res.json({ rides: rides.map(publicRide) });
  } catch (err) { next(err); }
});

rideRoutes.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const ride = await getRide(req.params.id);
    if (!ride) return res.status(404).json({ error: 'ride not found' });

    const isParticipant =
      ride.rider_id === req.user.userId || ride.driver_id === req.user.driverId;
    if (!isParticipant) return res.status(403).json({ error: 'not your ride' });

    const driver = ride.driver_id ? await driverCard(ride.driver_id) : null;
    const target = ride.status === 'in_progress'
      ? { lat: ride.dropoff_lat, lng: ride.dropoff_lng }
      : { lat: ride.pickup_lat, lng: ride.pickup_lng };

    res.json({
      ride: publicRide(ride),
      driver,
      etaSeconds: driver?.position
        ? etaSeconds(driver.position, target, config.avgSpeedKmh)
        : null,
    });
  } catch (err) { next(err); }
});

rideRoutes.post('/:id/cancel', requireAuth, async (req, res, next) => {
  try {
    const ride = await cancelRide(req.params.id, req.user.userId);
    res.json({ ride: publicRide(ride) });
  } catch (err) { next(err); }
});

rideRoutes.post('/:id/start', requireAuth, requireDriver, async (req, res, next) => {
  try {
    const ride = await startRide(req.params.id, req.user.driverId);
    res.json({ ride: publicRide(ride) });
  } catch (err) { next(err); }
});

rideRoutes.post('/:id/complete', requireAuth, requireDriver, async (req, res, next) => {
  try {
    const ride = await completeRide(req.params.id, req.user.driverId);
    res.json({ ride: publicRide(ride) });
  } catch (err) { next(err); }
});

/** Fare-free quote: straight-line distance and ETA for a prospective trip. */
rideRoutes.post('/quote', requireAuth, async (req, res, next) => {
  try {
    const pickup = point(req.body, 'pickup');
    const dropoff = point(req.body, 'dropoff');
    if (!isValidCoord(pickup.lat, pickup.lng) || !isValidCoord(dropoff.lat, dropoff.lng)) {
      return res.status(400).json({ error: 'invalid coordinates' });
    }
    const nearby = await geo.findNearby(pickup.lat, pickup.lng, { limit: 1 });
    res.json({
      tripSeconds: etaSeconds(pickup, dropoff, config.avgSpeedKmh),
      pickupSeconds: nearby[0] ? etaSeconds(nearby[0], pickup, config.avgSpeedKmh) : null,
      driversNearby: nearby.length,
    });
  } catch (err) { next(err); }
});
