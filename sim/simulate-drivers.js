/**
 * Phase 2 + 5 driver fleet simulator.
 *
 *   node sim/simulate-drivers.js --count=25 --auto-accept
 *
 * Spins up N driver accounts, puts them online, and drives them around a street
 * grid, streaming positions over WebSocket. With --auto-accept they also take
 * rides end to end (accept → drive to pickup → start → drive to dropoff →
 * complete), which is what makes the browser demo run itself.
 */
import { args, waitForServer, sleep, CENTER, BASE, c } from './lib/client.js';
import { DriverAgent, scatter } from './lib/driver-agent.js';

const opts = args({
  count: 25,
  spread: 3000,       // metres drivers are scattered over
  interval: 1000,     // ms between position pings
  speed: 30,          // km/h
  grid: 200,          // metres between intersections
  'auto-accept': false,
  quiet: false,
});

const center = opts.center
  ? { lat: Number(String(opts.center).split(',')[0]), lng: Number(String(opts.center).split(',')[1]) }
  : CENTER;

const log = (...a) => { if (!opts.quiet) console.log(...a); };

function onEvent({ driver, type, msg }) {
  const tag = c.cyan(driver.name.padEnd(10));
  switch (type) {
    case 'offer':
      log(`${tag} ${c.yellow('offer')}     ride ${short(msg.ride.id)} · ${msg.distanceMeters}m away`);
      break;
    case 'assigned':
      log(`${tag} ${c.green('assigned')}  ride ${short(msg.ride.id)} → driving to pickup`);
      break;
    case 'started':
      log(`${tag} ${c.green('started')}   ride ${short(msg.ride.ride?.id || msg.ride.id)} → driving to dropoff`);
      break;
    case 'completed':
      log(`${tag} ${c.green('completed')} ride ${short(msg.ride.id)}`);
      break;
    case 'offer_while_busy':
      log(`${tag} ${c.red('DOUBLE-BOOK ATTEMPT')} — offered ride ${short(msg.ride.id)} while already on one`);
      break;
    case 'error':
      log(`${tag} ${c.red('error')}     ${msg.error}`);
      break;
  }
}

const short = (id) => String(id).slice(0, 8);

async function main() {
  await waitForServer();

  const starts = scatter(center, opts.count, opts.spread);
  const drivers = starts.map((start, i) => new DriverAgent({
    email: `driver${String(i + 1).padStart(2, '0')}@sim.test`,
    password: 'password',
    name: `Driver ${String(i + 1).padStart(2, '0')}`,
    vehicle: ['Sedan', 'Hatchback', 'SUV', 'Auto'][i % 4],
    plate: `KA-01-${String(1000 + i)}`,
    start,
    speedKmh: opts.speed,
    gridSpacingM: opts.grid,
    autoAccept: Boolean(opts['auto-accept']),
    onEvent,
  }));

  console.log(c.bold(`\nBooting ${opts.count} drivers around ${center.lat.toFixed(4)}, ${center.lng.toFixed(4)}`));
  console.log(c.dim(`spread ${opts.spread}m · ${opts.speed}km/h · ping every ${opts.interval}ms · auto-accept ${Boolean(opts['auto-accept'])}\n`));

  // Stagger logins so 25 bcrypt hashes do not land at once.
  for (const driver of drivers) {
    await driver.login();
    await driver.goOnline();
    process.stdout.write('.');
    await sleep(40);
  }
  console.log(c.green(`\n${drivers.length} drivers online\n`));

  const dt = opts.interval / 1000;
  const timer = setInterval(() => {
    for (const driver of drivers) {
      driver.step(dt).catch((err) => console.error(driver.name, err.message));
    }
  }, opts.interval);

  // Periodic fleet summary.
  const summary = setInterval(() => {
    const busy = drivers.filter((d) => d.ride).length;
    const completed = drivers.reduce((n, d) => n + d.stats.completed, 0);
    log(c.dim(`— fleet: ${busy}/${drivers.length} on a ride · ${completed} completed`));
  }, 15_000);

  const stop = () => {
    clearInterval(timer);
    clearInterval(summary);
    console.log(c.dim('\nshutting down fleet...'));
    drivers.forEach((d) => d.close());
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.log(c.dim(`Drivers are moving. Open ${BASE} to request a ride. Ctrl+C to stop.\n`));
}

main().catch((err) => {
  console.error(c.red(`\nsimulator failed: ${err.message}`));
  process.exit(1);
});
