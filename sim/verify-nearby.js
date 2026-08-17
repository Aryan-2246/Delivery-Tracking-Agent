/**
 * Phase 2 deliverable — prove the nearest-driver query is actually correct.
 *
 *   node sim/verify-nearby.js
 *
 * Places drivers at deterministic positions on a grid, then probes
 * GET /api/drivers/nearby from several points and radii and checks the result
 * against a brute-force haversine scan computed here in the test. Redis and the
 * test disagree on nothing: same membership, same ordering, same distances
 * (within Redis's documented ~0.5% geohash error).
 *
 * Results are filtered to this script's own drivers, so it stays correct even
 * if a fleet simulation is running in the same pool.
 */
import { api, waitForServer, sleep, CENTER, c, args } from './lib/client.js';
import { DriverAgent } from './lib/driver-agent.js';
import { haversineMeters, offsetPoint } from '../src/lib/geo.js';

const opts = args({ rows: 5, cols: 5, spacing: 600 });

// Redis encodes positions as 52-bit geohashes, so reported distances carry a
// small error. 0.5% + 1m is comfortably inside its documented worst case.
const distanceTolerance = (expected) => Math.max(1, expected * 0.005);

let passed = 0;
let failed = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ${c.green('PASS')} ${name}`);
  } else {
    failed++;
    console.log(`  ${c.red('FAIL')} ${name}${detail ? `\n       ${detail}` : ''}`);
  }
}

async function main() {
  await waitForServer();

  // ---------------------------------------------------------------- setup
  const positions = [];
  for (let row = 0; row < opts.rows; row++) {
    for (let col = 0; col < opts.cols; col++) {
      // Grid centred on CENTER: north/south by row, east/west by col.
      const northed = offsetPoint(CENTER, (row - (opts.rows - 1) / 2) * opts.spacing, 0);
      positions.push(offsetPoint(northed, (col - (opts.cols - 1) / 2) * opts.spacing, 90));
    }
  }

  console.log(c.bold(`\nPlacing ${positions.length} drivers on a ${opts.rows}x${opts.cols} grid (${opts.spacing}m spacing)\n`));

  const drivers = [];
  for (const [i, start] of positions.entries()) {
    const agent = new DriverAgent({
      email: `geo${String(i + 1).padStart(2, '0')}@sim.test`,
      password: 'password',
      name: `Geo ${i + 1}`,
      vehicle: 'Sedan',
      plate: `GEO-${i + 1}`,
      start,
    });
    await agent.login();
    await agent.goOnline();
    drivers.push(agent);
    process.stdout.write('.');
  }
  console.log(c.green(`\n${drivers.length} drivers placed\n`));

  const ours = new Map(drivers.map((d) => [d.driverId, d.position]));
  await sleep(200);

  // ---------------------------------------------------------------- probes
  const probes = [
    { name: 'grid centre, 1km',            point: CENTER, radius: 1000 },
    { name: 'grid centre, 2km',            point: CENTER, radius: 2000 },
    { name: 'grid centre, 250m (tight)',   point: CENTER, radius: 250 },
    { name: 'offset 1.4km NE, 1.5km',      point: offsetPoint(CENTER, 1400, 45), radius: 1500 },
    { name: 'far corner 5km SW, 1km',      point: offsetPoint(CENTER, 5000, 225), radius: 1000 },
    { name: 'whole grid, 10km',            point: CENTER, radius: 10_000 },
  ];

  for (const probe of probes) {
    console.log(c.bold(`\nProbe: ${probe.name}`));

    const res = await api('GET',
      `/api/drivers/nearby?lat=${probe.point.lat}&lng=${probe.point.lng}` +
      `&radius=${probe.radius}&limit=100`);

    const actual = res.drivers.filter((d) => ours.has(d.driverId));

    // Ground truth: brute-force scan over the positions we placed.
    const expected = [...ours.entries()]
      .map(([driverId, pos]) => ({ driverId, distanceMeters: haversineMeters(probe.point, pos) }))
      .filter((d) => d.distanceMeters <= probe.radius)
      .sort((a, b) => a.distanceMeters - b.distanceMeters);

    console.log(c.dim(`  redis returned ${actual.length}, brute force expected ${expected.length}`));

    // 1. Same set of drivers.
    const actualIds = new Set(actual.map((d) => d.driverId));
    const expectedIds = new Set(expected.map((d) => d.driverId));
    const missing = [...expectedIds].filter((id) => !actualIds.has(id));
    const extra = [...actualIds].filter((id) => !expectedIds.has(id));

    // Drivers sitting exactly on the radius boundary can fall either side of
    // the cut given geohash rounding; tolerate that band only.
    const boundary = (id) => {
      const pos = ours.get(id);
      const d = haversineMeters(probe.point, pos);
      return Math.abs(d - probe.radius) <= distanceTolerance(probe.radius);
    };
    const realMissing = missing.filter((id) => !boundary(id));
    const realExtra = extra.filter((id) => !boundary(id));

    check('membership matches brute force', realMissing.length === 0 && realExtra.length === 0,
      `missing=${realMissing.length} extra=${realExtra.length}`);

    // 2. Ordering is nearest-first.
    const ascending = actual.every((d, i) => i === 0 || actual[i - 1].distanceMeters <= d.distanceMeters);
    check('results ordered nearest-first', ascending);

    // 3. Ordering agrees with brute force.
    //
    // Compared by *distance sequence*, not by id sequence. A regular grid puts
    // several drivers at identical distances from the probe (the four at
    // (0,±600) and (±600,0) from the centre, for instance), and any tie order
    // is equally correct. Comparing ids would fail on a correct result.
    const truth = new Map(expected.map((d) => [d.driverId, d.distanceMeters]));
    const common = actual.map((d) => d.driverId).filter((id) => expectedIds.has(id));
    const expectedOrder = expected.map((d) => d.driverId).filter((id) => actualIds.has(id));

    const actualSeq = common.map((id) => truth.get(id));
    const expectedSeq = expectedOrder.map((id) => truth.get(id));
    const orderingOk =
      actualSeq.length === expectedSeq.length &&
      actualSeq.every((d, i) => Math.abs(d - expectedSeq[i]) <= distanceTolerance(probe.radius));

    const ties = expectedSeq.filter((d, i) => i > 0 && Math.abs(d - expectedSeq[i - 1]) < 1).length;
    check(`ordering matches brute force${ties ? c.dim(` (${ties} tied pairs)`) : ''}`, orderingOk,
      `redis=${actualSeq.slice(0, 4).map((d) => d.toFixed(0))} truth=${expectedSeq.slice(0, 4).map((d) => d.toFixed(0))}`);

    // 4. Reported distances are accurate.
    const worst = actual.reduce((max, d) => {
      if (!truth.has(d.driverId)) return max;
      return Math.max(max, Math.abs(d.distanceMeters - truth.get(d.driverId)));
    }, 0);
    check(`distances accurate (worst error ${worst.toFixed(1)}m)`,
      worst <= distanceTolerance(probe.radius));

    // 5. Nothing outside the radius leaks in.
    const outside = actual.filter((d) => d.distanceMeters > probe.radius + distanceTolerance(probe.radius));
    check('no driver returned beyond the radius', outside.length === 0);
  }

  // ---------------------------------------------------------------- teardown
  console.log(c.dim('\ntaking test drivers offline...'));
  for (const d of drivers) {
    await api('POST', '/api/drivers/offline', { token: d.token }).catch(() => {});
    d.close();
  }

  console.log(c.bold(`\n${passed} passed, ${failed} failed\n`));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(c.red(`\nverification failed: ${err.message}`));
  process.exit(1);
});
