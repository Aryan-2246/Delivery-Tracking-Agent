/**
 * Phase 3 deliverable — the headline result.
 *
 *   node sim/load-test-match.js --riders=50 --drivers=10
 *
 * Fires N ride requests at the same instant, at the same pickup point, against
 * a deliberately scarce pool of M drivers. Every driver auto-accepts every
 * offer they receive, which is the worst case: nothing on the driver side slows
 * the race down or breaks the tie for us.
 *
 * If matching were unsafe you would see one of:
 *   - a driver assigned to two live rides at once
 *   - more matched rides than there are drivers
 *   - a driver receiving a second offer while already carrying someone
 *
 * The assertions below check all three, in Redis, in Postgres, and from the
 * drivers' own point of view.
 */
import { api, ensureAccount, waitForServer, sleep, CENTER, c, args } from './lib/client.js';
import { DriverAgent, scatter } from './lib/driver-agent.js';
import { offsetPoint } from '../src/lib/geo.js';

const opts = args({
  riders: 50,
  drivers: 10,
  spread: 800,   // drivers scattered tightly so all are plausible candidates
  rounds: 1,
});

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ${c.green('PASS')} ${name}`); }
  else { failed++; console.log(`  ${c.red('FAIL')} ${name}${detail ? `\n       ${detail}` : ''}`); }
}

const PICKUP = CENTER;
const DROPOFF = offsetPoint(CENTER, 4000, 60);

async function main() {
  await waitForServer();

  console.log(c.bold(`\nConcurrent matching test — ${opts.riders} riders vs ${opts.drivers} drivers\n`));

  // ------------------------------------------------------- driver pool
  const doubleBookAttempts = [];
  const starts = scatter(PICKUP, opts.drivers, opts.spread);

  const drivers = starts.map((start, i) => new DriverAgent({
    email: `race-driver${String(i + 1).padStart(2, '0')}@sim.test`,
    password: 'password',
    name: `Race ${i + 1}`,
    vehicle: 'Sedan',
    plate: `RACE-${i + 1}`,
    start,
    autoAccept: true,
    onEvent: ({ driver, type, msg }) => {
      if (type === 'offer_while_busy') {
        doubleBookAttempts.push({ driver: driver.name, rideId: msg.ride.id });
      }
    },
  }));

  process.stdout.write(c.dim('  booting drivers '));
  for (const d of drivers) {
    await d.login();
    await d.goOnline();
    process.stdout.write('.');
  }
  console.log(c.green(` ${drivers.length} online`));

  // Keep the fleet's positions fresh for the whole test. Without this, the time
  // spent creating rider accounts is enough for every driver to age past
  // DRIVER_STALE_MS and be filtered out of matching as presumed-disconnected.
  // Drivers stay stationary so rides settle in `matched` and stay there.
  const heartbeat = setInterval(() => drivers.forEach((d) => d.ping()), 5_000);

  // ------------------------------------------------------- rider accounts
  process.stdout.write(c.dim('  booting riders  '));
  const riders = [];
  for (let i = 0; i < opts.riders; i++) {
    const auth = await ensureAccount({
      email: `race-rider${String(i + 1).padStart(3, '0')}@sim.test`,
      password: 'password',
      name: `Rider ${i + 1}`,
      role: 'rider',
    });
    riders.push(auth);
    if (i % 10 === 0) process.stdout.write('.');
  }
  console.log(c.green(` ${riders.length} ready`));

  // Clear any ride left open by a previous run — the one-active-ride-per-rider
  // index would otherwise reject the request for the wrong reason.
  await Promise.all(riders.map(async (r) => {
    const { ride } = await api('GET', '/api/rides/active', { token: r.token });
    if (ride) await api('POST', `/api/rides/${ride.id}/cancel`, { token: r.token }).catch(() => {});
  }));

  // ------------------------------------------------------- the race
  console.log(c.bold(`\n  firing ${opts.riders} simultaneous ride requests...\n`));

  const startedAt = Date.now();
  const results = await Promise.allSettled(
    riders.map((rider) => api('POST', '/api/rides', {
      token: rider.token,
      body: { pickup: PICKUP, dropoff: DROPOFF },
    }))
  );
  const fireMs = Date.now() - startedAt;

  const created = results.filter((r) => r.status === 'fulfilled').map((r) => r.value.ride);
  const rejected = results.filter((r) => r.status === 'rejected');

  console.log(c.dim(`  ${created.length} accepted, ${rejected.length} rejected, all fired in ${fireMs}ms`));

  // Dispatch is asynchronous. Wait for every ride to leave `requested`, with a
  // ceiling generous enough to cover MAX_CANDIDATES × OFFER_TIMEOUT_MS.
  console.log(c.dim('  waiting for dispatch to settle...'));
  const settled = await waitForSettlement(riders, created, 60_000);

  // ------------------------------------------------------- assertions
  console.log(c.bold('\nResults\n'));

  const byStatus = settled.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1;
    return acc;
  }, {});
  for (const [status, n] of Object.entries(byStatus)) {
    console.log(`  ${String(status).padEnd(12)} ${n}`);
  }

  const live = settled.filter((r) => ['matched', 'in_progress'].includes(r.status));
  console.log('');

  // 1. No driver holds two live rides simultaneously.
  const perDriver = new Map();
  for (const ride of live) {
    if (!ride.driverId) continue;
    if (!perDriver.has(ride.driverId)) perDriver.set(ride.driverId, []);
    perDriver.get(ride.driverId).push(ride.id);
  }
  const doubled = [...perDriver.entries()].filter(([, rides]) => rides.length > 1);
  check('no driver assigned to more than one live ride', doubled.length === 0,
    doubled.map(([d, r]) => `driver ${d.slice(0, 8)} → ${r.length} rides`).join(', '));

  // 2. Live rides cannot exceed the number of drivers.
  check(`live rides (${live.length}) never exceed drivers (${opts.drivers})`,
    live.length <= opts.drivers);

  // 3. No driver ever saw an offer while already on a ride.
  check('no driver was offered a ride while busy', doubleBookAttempts.length === 0,
    doubleBookAttempts.map((a) => `${a.driver} ← ${a.rideId.slice(0, 8)}`).join(', '));

  // 4. Every matched ride has a driver; every unmatched one does not.
  const matchedWithoutDriver = live.filter((r) => !r.driverId);
  check('every live ride has a driver attached', matchedWithoutDriver.length === 0);

  // 5. Redis and Postgres agree on who is locked.
  const lockReport = await Promise.all(drivers.map(async (d) => {
    const me = await api('GET', '/api/drivers/me', { token: d.token });
    return { name: d.name, driverId: d.driverId, lock: me.lockedToRide, ride: me.activeRide };
  }));
  const disagreements = lockReport.filter((r) =>
    Boolean(r.lock) !== Boolean(r.ride) || (r.ride && r.lock !== r.ride.id));
  check('redis locks agree with postgres ride assignments', disagreements.length === 0,
    disagreements.map((d) => `${d.name}: lock=${d.lock} ride=${d.ride?.id}`).join(', '));

  // 6. Losers were told, rather than left hanging in `requested`.
  const stuck = settled.filter((r) => r.status === 'requested');
  check('no ride left stuck in `requested`', stuck.length === 0, `${stuck.length} stuck`);

  // 7. Liveness. Every assertion above is satisfied by a system that simply
  // refuses to match anyone, so the safety checks are only meaningful
  // alongside this one: all available capacity must actually get used.
  const capacity = Math.min(opts.riders, opts.drivers);
  check(`all ${capacity} available drivers were matched (no wasted capacity)`,
    live.length === capacity, `matched ${live.length} of ${capacity}`);

  // ------------------------------------------------------- summary
  const busy = lockReport.filter((r) => r.lock).length;
  console.log(c.dim(`\n  ${busy}/${drivers.length} drivers currently locked to a ride`));
  console.log(c.dim(`  ${live.length} riders matched, ${(byStatus.no_drivers || 0)} told no drivers available`));

  clearInterval(heartbeat);
  console.log(c.dim('\ncleaning up...'));
  await Promise.all(riders.map(async (r) => {
    const { ride } = await api('GET', '/api/rides/active', { token: r.token }).catch(() => ({}));
    if (ride && ride.status !== 'in_progress') {
      await api('POST', `/api/rides/${ride.id}/cancel`, { token: r.token }).catch(() => {});
    }
  }));
  for (const d of drivers) {
    await api('POST', '/api/drivers/offline', { token: d.token }).catch(() => {});
    d.close();
  }

  console.log(c.bold(`\n${passed} passed, ${failed} failed\n`));
  process.exit(failed === 0 ? 0 : 1);
}

/** Poll each rider's ride until none are still `requested`, or we time out. */
async function waitForSettlement(riders, created, timeoutMs) {
  const byRider = new Map(created.map((ride) => [ride.riderId, ride]));
  const deadline = Date.now() + timeoutMs;
  let snapshot = created;

  while (Date.now() < deadline) {
    snapshot = await Promise.all(created.map(async (ride) => {
      const rider = riders.find((r) => r.user.id === ride.riderId);
      const { ride: latest } = await api('GET', `/api/rides/${ride.id}`, { token: rider.token });
      return latest;
    }));

    if (!snapshot.some((r) => r.status === 'requested')) break;
    await sleep(1000);
  }

  byRider.clear();
  return snapshot;
}

main().catch((err) => {
  console.error(c.red(`\nload test failed: ${err.message}`));
  console.error(err.stack);
  process.exit(1);
});
