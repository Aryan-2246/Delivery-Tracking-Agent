import { WebSocketServer } from 'ws';
import { verifyToken } from '../auth.js';
import { config } from '../config.js';
import { hub } from './hub.js';
import * as geo from '../services/geo.service.js';
import * as lock from '../services/lock.service.js';
import { getCachedRide } from '../services/matching.service.js';
import { etaSeconds, haversineMeters, isValidCoord } from '../lib/geo.js';

const HEARTBEAT_MS = 30_000;

/**
 * WebSocket layer.
 *
 * Two jobs: carry driver position pings up, and push ride events down. Both
 * directions matter for the demo — the driver's GPS stream is what makes the
 * rider's map move, and the offer/accept handshake is what makes matching
 * interactive rather than automatic.
 */
export function attachWebSockets(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (socket, req) => {
    const token = new URL(req.url, 'http://localhost').searchParams.get('token');
    const user = token && verifyToken(token);

    if (!user) {
      socket.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
      return socket.close(4001, 'unauthorized');
    }

    socket.user = user;
    socket.isAlive = true;
    hub.add(socket, { userId: user.userId, driverId: user.driverId });

    socket.send(JSON.stringify({
      type: 'connected',
      role: user.role,
      userId: user.userId,
      driverId: user.driverId,
    }));

    socket.on('pong', () => { socket.isAlive = true; });

    socket.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return socket.send(JSON.stringify({ type: 'error', message: 'malformed json' }));
      }
      try {
        await handleMessage(socket, msg);
      } catch (err) {
        console.error('[ws] handler error', msg?.type, err.message);
        socket.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    socket.on('close', () => {
      hub.remove(socket, { userId: user.userId, driverId: user.driverId });
    });
  });

  // Drop half-open connections so a driver whose phone died stops looking
  // available. Their GEO entry also ages out via the staleness filter.
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);

  wss.on('close', () => clearInterval(heartbeat));
  return wss;
}

async function handleMessage(socket, msg) {
  const { user } = socket;

  switch (msg.type) {
    case 'ping':
      return socket.send(JSON.stringify({ type: 'pong', t: Date.now() }));

    /** Driver GPS tick. The hot path — runs several times a second per driver. */
    case 'driver:location': {
      if (!user.driverId) throw new Error('not a driver');
      const lat = Number(msg.lat);
      const lng = Number(msg.lng);
      if (!isValidCoord(lat, lng)) throw new Error('invalid coordinates');

      await geo.updatePosition(user.driverId, lat, lng, { name: user.name });
      await relayToRider(user.driverId, { lat, lng });
      return;
    }

    /** Driver answers an offer. Resolves the promise the dispatch loop awaits. */
    case 'driver:accept':
    case 'driver:reject': {
      if (!user.driverId) throw new Error('not a driver');
      if (!msg.rideId) throw new Error('rideId required');

      const response = msg.type === 'driver:accept' ? 'accepted' : 'rejected';

      // Only the driver actually holding the offer lock may answer for it.
      // Without this check a stale client could resolve someone else's offer.
      const holder = await lock.lockHolder(user.driverId);
      if (response === 'accepted' && holder !== msg.rideId) {
        return socket.send(JSON.stringify({
          type: 'ride:offer_expired', rideId: msg.rideId,
          reason: holder ? 'claimed_by_another_ride' : 'expired',
        }));
      }

      hub.resolveOffer(msg.rideId, user.driverId, response);
      return;
    }

    default:
      socket.send(JSON.stringify({ type: 'error', message: `unknown message type: ${msg.type}` }));
  }
}

/**
 * Push a driver's position to the rider they are currently carrying.
 *
 * The driver→ride mapping and the ride details both come from Redis, so a
 * position tick costs two Redis reads and zero database queries. That is the
 * difference between this scaling and not.
 */
async function relayToRider(driverId, position) {
  const rideId = await lock.activeRideOf(driverId);
  if (!rideId) return;

  const ride = await getCachedRide(rideId);
  if (!ride || !['matched', 'in_progress'].includes(ride.status)) return;

  const target = ride.status === 'in_progress' ? ride.dropoff : ride.pickup;

  hub.sendToUser(ride.riderId, {
    type: 'driver:position',
    rideId,
    driverId,
    lat: position.lat,
    lng: position.lng,
    distanceMeters: Math.round(haversineMeters(position, target)),
    etaSeconds: etaSeconds(position, target, config.avgSpeedKmh),
    heading: ride.status === 'in_progress' ? 'dropoff' : 'pickup',
    at: Date.now(),
  });
}
