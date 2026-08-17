import { offsetPoint, haversineMeters, bearingDegrees } from '../../src/lib/geo.js';
import { api, connect, send, CENTER } from './client.js';

/**
 * A simulated driver.
 *
 * Movement is deliberately grid-constrained rather than free-roaming: the
 * driver only ever heads north/south/east/west and may turn at intersections
 * spaced `gridSpacingM` apart. That produces a Manhattan-style street layout,
 * which makes nearest-neighbour results easy to eyeball on the map and easy to
 * assert against by hand.
 */
export class DriverAgent {
  constructor({
    email, password, name, vehicle, plate,
    start = CENTER,
    speedKmh = 30,
    gridSpacingM = 200,
    autoAccept = false,
    onEvent = () => {},
  }) {
    Object.assign(this, { email, password, name, vehicle, plate, autoAccept, onEvent });
    this.position = { ...start };
    this.speedMs = (speedKmh * 1000) / 3600;
    this.gridSpacingM = gridSpacingM;
    this.bearing = [0, 90, 180, 270][Math.floor(Math.random() * 4)];
    this.metresUntilTurn = gridSpacingM;
    this.ride = null;       // active ride, once assigned
    this.destination = null; // set while carrying/collecting a rider
    this.stats = { offers: 0, accepted: 0, rejected: 0, completed: 0 };
  }

  async login() {
    const auth = await api('POST', '/api/auth/register', {
      body: {
        email: this.email, password: this.password, name: this.name,
        role: 'driver', vehicle: this.vehicle, plate: this.plate,
      },
    }).catch(async (err) => {
      if (err.status === 409) {
        return api('POST', '/api/auth/login', { body: { email: this.email, password: this.password } });
      }
      throw err;
    });

    this.token = auth.token;
    this.driverId = auth.driverId;
    return this;
  }

  async goOnline() {
    await api('POST', '/api/drivers/online', {
      token: this.token,
      body: { lat: this.position.lat, lng: this.position.lng },
    });
    this.socket = await connect(this.token, (msg) => this.handle(msg));
    this.online = true;
    return this;
  }

  handle(msg) {
    switch (msg.type) {
      case 'ride:offer':
        this.stats.offers++;
        this.onEvent({ driver: this, type: 'offer', msg });
        if (this.autoAccept && !this.ride) {
          this.stats.accepted++;
          send(this.socket, { type: 'driver:accept', rideId: msg.ride.id });
        } else if (this.autoAccept) {
          // Already carrying someone — should never happen if locking works.
          this.stats.rejected++;
          send(this.socket, { type: 'driver:reject', rideId: msg.ride.id });
          this.onEvent({ driver: this, type: 'offer_while_busy', msg });
        }
        break;

      case 'ride:assigned':
        this.ride = msg.ride;
        this.destination = msg.ride.pickup;
        this.onEvent({ driver: this, type: 'assigned', msg });
        break;

      case 'ride:status':
        if (this.ride && msg.ride.id === this.ride.id) {
          this.ride = msg.ride;
          if (msg.ride.status === 'in_progress') this.destination = msg.ride.dropoff;
          if (['completed', 'cancelled'].includes(msg.ride.status)) this.clearRide();
        }
        break;

      case 'ride:offer_expired':
        this.onEvent({ driver: this, type: 'offer_expired', msg });
        break;
    }
  }

  clearRide() {
    this.ride = null;
    this.destination = null;
  }

  /**
   * Re-send the current position without moving.
   *
   * Real drivers stream GPS continuously, and the server treats a position
   * older than DRIVER_STALE_MS as a lost connection. A stationary simulated
   * driver still has to ping or it correctly ages out of the matching pool.
   */
  ping() {
    send(this.socket, {
      type: 'driver:location',
      lat: this.position.lat,
      lng: this.position.lng,
    });
  }

  /** Advance one simulation tick. */
  async step(dtSeconds) {
    const distance = this.speedMs * dtSeconds;

    if (this.destination) {
      // On a job: head straight for the target so the demo converges quickly.
      const remaining = haversineMeters(this.position, this.destination);
      if (remaining <= distance) {
        this.position = { ...this.destination };
        await this.onArrival();
      } else {
        this.bearing = bearingDegrees(this.position, this.destination);
        this.position = offsetPoint(this.position, distance, this.bearing);
      }
    } else {
      // Idle: cruise the grid, turning only at intersections.
      this.metresUntilTurn -= distance;
      if (this.metresUntilTurn <= 0) {
        this.metresUntilTurn = this.gridSpacingM;
        if (Math.random() < 0.4) {
          this.bearing = (this.bearing + (Math.random() < 0.5 ? 90 : 270)) % 360;
        }
      }
      this.position = offsetPoint(this.position, distance, this.bearing);
    }

    send(this.socket, {
      type: 'driver:location',
      lat: this.position.lat,
      lng: this.position.lng,
    });
  }

  /** Reached the current destination: start the trip, or finish it. */
  async onArrival() {
    if (!this.ride) return;
    try {
      if (this.ride.status === 'matched') {
        const { ride } = await api('POST', `/api/rides/${this.ride.id}/start`, { token: this.token });
        this.ride = ride;
        this.destination = ride.dropoff;
        this.onEvent({ driver: this, type: 'started', msg: { ride } });
      } else if (this.ride.status === 'in_progress') {
        const { ride } = await api('POST', `/api/rides/${this.ride.id}/complete`, { token: this.token });
        this.stats.completed++;
        this.onEvent({ driver: this, type: 'completed', msg: { ride } });
        this.clearRide();
      }
    } catch (err) {
      this.onEvent({ driver: this, type: 'error', msg: { error: err.message } });
      this.clearRide();
    }
  }

  close() {
    this.socket?.close();
  }
}

/** Scatter `count` start positions over a square around `center`. */
export function scatter(center, count, spreadM) {
  return Array.from({ length: count }, () => {
    const bearing = Math.random() * 360;
    const distance = Math.sqrt(Math.random()) * spreadM;
    return offsetPoint(center, distance, bearing);
  });
}
