import { EventEmitter } from 'node:events';

/**
 * Connection registry + in-process event bus.
 *
 * Sockets are indexed twice — by user id (riders) and by driver id (drivers) —
 * because the two sides are addressed differently: a rider is notified about
 * *their* ride, a driver is notified about an offer aimed at their driver
 * record.
 *
 * Scale note: this is single-process. Running multiple app nodes means the
 * driver who should receive an offer may be connected to a different node than
 * the one running the dispatch loop. The fix is a Redis pub/sub fan-out keyed
 * by driver id; the send/onOfferResponse interface below is what would change,
 * and nothing above it would. The *locking* is already multi-node safe because
 * it lives in Redis, which is the part that actually matters for correctness.
 */
class Hub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.byUser = new Map();   // userId   -> Set<WebSocket>
    this.byDriver = new Map(); // driverId -> Set<WebSocket>
    this.sockets = new Set();  // every live socket, counted once
  }

  add(socket, { userId, driverId }) {
    this.sockets.add(socket);
    if (userId) mapAdd(this.byUser, userId, socket);
    if (driverId) mapAdd(this.byDriver, driverId, socket);
  }

  remove(socket, { userId, driverId }) {
    this.sockets.delete(socket);
    if (userId) mapRemove(this.byUser, userId, socket);
    if (driverId) mapRemove(this.byDriver, driverId, socket);
  }

  /** @returns {number} how many sockets actually received the payload. */
  sendToUser(userId, payload) {
    return send(this.byUser.get(userId), payload);
  }

  sendToDriver(driverId, payload) {
    return send(this.byDriver.get(driverId), payload);
  }

  isDriverConnected(driverId) {
    const set = this.byDriver.get(driverId);
    return Boolean(set && set.size);
  }

  /**
   * A driver's socket is registered under both their user id and their driver
   * id, so `total` is tracked separately rather than summed — otherwise every
   * driver connection would be counted twice.
   */
  stats() {
    return {
      total: this.sockets.size,
      riders: this.byUser.size - this.byDriver.size,
      drivers: this.byDriver.size,
    };
  }

  // -- offer responses ------------------------------------------------------

  offerKey(rideId, driverId) {
    return `offer:${rideId}:${driverId}`;
  }

  /** Called by the driver's socket handler when they accept or reject. */
  resolveOffer(rideId, driverId, response) {
    this.emit(this.offerKey(rideId, driverId), response);
  }

  /**
   * Await a driver's answer to an offer.
   * @returns {Promise<'accepted'|'rejected'|'timeout'>}
   */
  waitForOffer(rideId, driverId, timeoutMs) {
    const key = this.offerKey(rideId, driverId);
    return new Promise((resolve) => {
      const done = (response) => {
        clearTimeout(timer);
        this.off(key, done);
        resolve(response);
      };
      const timer = setTimeout(() => done('timeout'), timeoutMs);
      this.once(key, done);
    });
  }
}

function mapAdd(map, key, socket) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(socket);
}

function mapRemove(map, key, socket) {
  const set = map.get(key);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) map.delete(key);
}

const OPEN = 1; // ws.OPEN

function send(set, payload) {
  if (!set || set.size === 0) return 0;
  const data = JSON.stringify(payload);
  let sent = 0;
  for (const socket of set) {
    if (socket.readyState === OPEN) {
      socket.send(data);
      sent++;
    }
  }
  return sent;
}

export const hub = new Hub();
