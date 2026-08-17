-- Ride-hailing tracking service — Postgres schema.
-- Postgres is the durable system of record. All *live* geospatial state
-- (driver positions, driver locks) lives in Redis; see src/services/geo.service.js.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- users

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('rider', 'driver')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- drivers

CREATE TABLE IF NOT EXISTS drivers (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  vehicle       TEXT NOT NULL DEFAULT 'Sedan',
  plate         TEXT NOT NULL DEFAULT 'UNKNOWN',
  is_online     BOOLEAN NOT NULL DEFAULT false,
  -- Last known position, mirrored from Redis on a slow cadence. This is a
  -- convenience/debug column, never the read path for matching.
  last_lat      DOUBLE PRECISION,
  last_lng      DOUBLE PRECISION,
  last_seen_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS drivers_online_idx ON drivers (is_online) WHERE is_online;

-- ---------------------------------------------------------------- rides

CREATE TABLE IF NOT EXISTS rides (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rider_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  driver_id    UUID REFERENCES drivers(id) ON DELETE SET NULL,
  status       TEXT NOT NULL DEFAULT 'requested'
                 CHECK (status IN ('requested', 'matched', 'in_progress',
                                   'completed', 'cancelled', 'no_drivers')),
  pickup_lat   DOUBLE PRECISION NOT NULL,
  pickup_lng   DOUBLE PRECISION NOT NULL,
  dropoff_lat  DOUBLE PRECISION NOT NULL,
  dropoff_lng  DOUBLE PRECISION NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  matched_at   TIMESTAMPTZ,
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

-- The second line of defence against double-booking.
--
-- Redis `SET NX` on the driver lock is the fast path that stops two riders
-- racing for the same driver (src/services/lock.service.js). This index is the
-- durable backstop: even if Redis were flushed, restarted, or a lock expired
-- mid-flight, the database physically cannot record two live rides for one
-- driver. The INSERT/UPDATE simply fails.
CREATE UNIQUE INDEX IF NOT EXISTS rides_one_active_per_driver
  ON rides (driver_id)
  WHERE driver_id IS NOT NULL AND status IN ('matched', 'in_progress');

-- A rider may only have one open request at a time.
CREATE UNIQUE INDEX IF NOT EXISTS rides_one_active_per_rider
  ON rides (rider_id)
  WHERE status IN ('requested', 'matched', 'in_progress');

CREATE INDEX IF NOT EXISTS rides_rider_idx  ON rides (rider_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS rides_driver_idx ON rides (driver_id, requested_at DESC);

-- ---------------------------------------------------------------- ride_offers

-- Audit trail of the dispatch loop: every driver we offered a ride to and what
-- they did with it. Makes the matching behaviour inspectable after the fact,
-- which is most of the value when you are trying to prove no double-booking.
CREATE TABLE IF NOT EXISTS ride_offers (
  id           BIGSERIAL PRIMARY KEY,
  ride_id      UUID NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
  driver_id    UUID NOT NULL REFERENCES drivers(id) ON DELETE CASCADE,
  offered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ,
  response     TEXT CHECK (response IN ('accepted', 'rejected', 'timeout', 'lock_failed'))
);

CREATE INDEX IF NOT EXISTS ride_offers_ride_idx   ON ride_offers (ride_id);
CREATE INDEX IF NOT EXISTS ride_offers_driver_idx ON ride_offers (driver_id, offered_at DESC);
