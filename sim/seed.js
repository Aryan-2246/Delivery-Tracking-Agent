/**
 * Create the demo accounts used by the browser UI.
 *
 *   node sim/seed.js
 *
 * Idempotent: re-running logs into existing accounts instead of failing.
 */
import { ensureAccount, waitForServer, BASE, c } from './lib/client.js';

const ACCOUNTS = [
  { email: 'rider@demo.test',  password: 'password', name: 'Demo Rider',  role: 'rider' },
  { email: 'rider2@demo.test', password: 'password', name: 'Second Rider', role: 'rider' },
  { email: 'driver@demo.test', password: 'password', name: 'Demo Driver', role: 'driver',
    vehicle: 'Sedan', plate: 'KA-01-DEMO' },
];

async function main() {
  await waitForServer();
  console.log(c.bold('\nSeeding demo accounts\n'));

  for (const account of ACCOUNTS) {
    const { user, driverId } = await ensureAccount(account);
    console.log(`  ${c.green('ok')} ${user.email.padEnd(20)} ${user.role}${driverId ? c.dim(` driver ${driverId.slice(0, 8)}`) : ''}`);
  }

  console.log(c.dim('\n  password for all accounts: password'));
  console.log(c.dim(`  rider  → ${BASE}/`));
  console.log(c.dim(`  driver → ${BASE}/driver.html\n`));
}

main().catch((err) => {
  console.error(c.red(`seed failed: ${err.message}`));
  process.exit(1);
});
