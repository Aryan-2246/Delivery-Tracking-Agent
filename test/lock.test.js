/**
 * Direct tests of the locking primitive against a real Redis.
 *
 * The load test proves the system as a whole does not double-book. These prove
 * the specific mechanism that makes that true, in isolation and without the
 * dispatch loop, HTTP, or WebSockets in the way.
 *
 * Requires Redis to be running: `npm run infra:up`.
 */
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { redis, K } from '../src/redis.js';
import { tryLockDriver, unlockDriver, holdForRide, lockHolder, releaseDriver }
  from '../src/services/lock.service.js';

const DRIVER = `test-driver-${randomUUID()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => { await redis.ping(); });

beforeEach(async () => {
  await redis.del(K.driverLock(DRIVER), K.driverRide(DRIVER));
  await redis.zrem(K.driversGeo, DRIVER);
});

after(async () => {
  await redis.del(K.driverLock(DRIVER), K.driverRide(DRIVER));
  await redis.zrem(K.driversGeo, DRIVER);
  await redis.quit();
});

test('a free driver can be locked', async () => {
  assert.equal(await tryLockDriver(DRIVER, 'ride-a', 5000), true);
  assert.equal(await lockHolder(DRIVER), 'ride-a');
});

test('a locked driver cannot be locked by a second ride', async () => {
  assert.equal(await tryLockDriver(DRIVER, 'ride-a', 5000), true);
  assert.equal(await tryLockDriver(DRIVER, 'ride-b', 5000), false);
  assert.equal(await lockHolder(DRIVER), 'ride-a', 'the first ride keeps the driver');
});

/**
 * The core claim. Fire many simultaneous claims at one driver and require that
 * exactly one succeeds — no locking, no retry, no coordination in the caller.
 */
test('exactly one of 200 concurrent claims wins', async () => {
  const rides = Array.from({ length: 200 }, (_, i) => `ride-${i}`);
  const results = await Promise.all(rides.map((r) => tryLockDriver(DRIVER, r, 5000)));

  const winners = results.filter(Boolean).length;
  assert.equal(winners, 1, `expected exactly 1 winner, got ${winners}`);

  const holder = await lockHolder(DRIVER);
  const winnerIndex = results.indexOf(true);
  assert.equal(holder, rides[winnerIndex], 'the lock is held by the ride that won');
});

test('winning the lock removes the driver from the matching index', async () => {
  await redis.geoadd(K.driversGeo, 77.5946, 12.9716, DRIVER);
  assert.equal(await redis.zscore(K.driversGeo, DRIVER) !== null, true);

  await tryLockDriver(DRIVER, 'ride-a', 5000);
  assert.equal(await redis.zscore(K.driversGeo, DRIVER), null,
    'a claimed driver must not be visible to concurrent searches');
});

test('unlock only succeeds for the ride that holds the lock', async () => {
  await tryLockDriver(DRIVER, 'ride-a', 5000);

  assert.equal(await unlockDriver(DRIVER, 'ride-b'), false, 'a stranger cannot unlock');
  assert.equal(await lockHolder(DRIVER), 'ride-a');

  assert.equal(await unlockDriver(DRIVER, 'ride-a'), true);
  assert.equal(await lockHolder(DRIVER), null);
});

/**
 * The bug the compare-and-delete guards against: ride A's lock expires, ride B
 * legitimately claims the driver, and a late unlock from A must not free B's
 * driver out from under it.
 */
test('a stale unlock cannot free a driver claimed by a later ride', async () => {
  await tryLockDriver(DRIVER, 'ride-a', 100);
  await sleep(200); // ride-a's lock expires

  assert.equal(await tryLockDriver(DRIVER, 'ride-b', 5000), true);
  await unlockDriver(DRIVER, 'ride-a'); // the late unlock

  assert.equal(await lockHolder(DRIVER), 'ride-b',
    "ride-a's stale unlock must not release ride-b's driver");
});

test('locks expire on their own so a crash cannot strand a driver', async () => {
  await tryLockDriver(DRIVER, 'ride-a', 150);
  assert.equal(await lockHolder(DRIVER), 'ride-a');

  await sleep(300);
  assert.equal(await lockHolder(DRIVER), null, 'the lock should have expired');
  assert.equal(await tryLockDriver(DRIVER, 'ride-b', 5000), true);
});

test('holdForRide removes the TTL so the lock survives the whole trip', async () => {
  await tryLockDriver(DRIVER, 'ride-a', 200);
  assert.equal(await holdForRide(DRIVER, 'ride-a'), true);

  assert.equal(await redis.pttl(K.driverLock(DRIVER)), -1, 'expected no expiry');
  await sleep(300);
  assert.equal(await lockHolder(DRIVER), 'ride-a', 'the lock must outlive the original TTL');
  assert.equal(await redis.get(K.driverRide(DRIVER)), 'ride-a');
});

test('holdForRide refuses when another ride holds the lock', async () => {
  await tryLockDriver(DRIVER, 'ride-a', 5000);
  assert.equal(await holdForRide(DRIVER, 'ride-b'), false);
  assert.equal(await redis.get(K.driverRide(DRIVER)), null);
});

test('releaseDriver clears both the lock and the active-ride pointer', async () => {
  await tryLockDriver(DRIVER, 'ride-a', 5000);
  await holdForRide(DRIVER, 'ride-a');

  await releaseDriver(DRIVER, 'ride-a');
  assert.equal(await lockHolder(DRIVER), null);
  assert.equal(await redis.get(K.driverRide(DRIVER)), null);
});

test('a released driver can immediately be claimed again', async () => {
  await tryLockDriver(DRIVER, 'ride-a', 5000);
  await holdForRide(DRIVER, 'ride-a');
  await releaseDriver(DRIVER, 'ride-a');

  assert.equal(await tryLockDriver(DRIVER, 'ride-b', 5000), true);
});
