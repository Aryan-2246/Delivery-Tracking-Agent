import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { config } from './config.js';
import { pool, waitForDb } from './db.js';
import { redis, waitForRedis } from './redis.js';
import { attachWebSockets } from './ws/handlers.js';
import { hub } from './ws/hub.js';
import { authRoutes } from './routes/auth.routes.js';
import { driverRoutes } from './routes/drivers.routes.js';
import { rideRoutes } from './routes/rides.routes.js';
import * as geo from './services/geo.service.js';
import { reconcileLiveRides } from './services/matching.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', async (_req, res) => {
  const [db, cache] = await Promise.allSettled([pool.query('SELECT 1'), redis.ping()]);
  const ok = db.status === 'fulfilled' && cache.status === 'fulfilled';
  res.status(ok ? 200 : 503).json({
    ok,
    postgres: db.status === 'fulfilled' ? 'up' : 'down',
    redis: cache.status === 'fulfilled' ? 'up' : 'down',
    availableDrivers: await geo.availableCount().catch(() => null),
    sockets: hub.stats(),
    uptimeSeconds: Math.round(process.uptime()),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/rides', rideRoutes);

app.use('/api', (_req, res) => res.status(404).json({ error: 'not found' }));

// Central error handler. Services throw errors carrying a `status`; anything
// without one is a bug and becomes a 500 with the detail kept server-side.
app.use((err, _req, res, _next) => {
  if (err.status) return res.status(err.status).json({ error: err.message });
  console.error('[http] unhandled', err);
  res.status(500).json({ error: 'internal error' });
});

const server = http.createServer(app);
attachWebSockets(server);

async function main() {
  console.log('[boot] waiting for postgres and redis...');
  await Promise.all([waitForDb(), waitForRedis()]);

  // A restart invalidates every in-memory socket, so no driver can answer an
  // offer made by the previous process. Clearing the availability index keeps
  // us from dispatching to ghosts; drivers re-register on their next ping.
  const dropped = await redis.del('drivers:geo');
  if (dropped) console.log('[boot] cleared stale driver availability index');

  // Postgres outlives Redis, so rides that were live at shutdown still exist
  // while their locks do not. Rebuild them before serving traffic.
  const restored = await reconcileLiveRides();
  if (restored) console.log(`[boot] reconciled ${restored} in-flight ride(s) from postgres`);

  server.listen(config.port, () => {
    console.log(`[boot] http   → http://localhost:${config.port}`);
    console.log(`[boot] ws     → ws://localhost:${config.port}/ws?token=...`);
    console.log(`[boot] rider  → http://localhost:${config.port}/`);
    console.log(`[boot] driver → http://localhost:${config.port}/driver.html`);
    console.log(`[boot] admin  → http://localhost:${config.port}/fleet.html`);
  });
}

async function shutdown(signal) {
  console.log(`\n[shutdown] ${signal}`);
  server.close();
  await Promise.allSettled([pool.end(), redis.quit()]);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error('[boot] failed:', err.message);
  process.exit(1);
});
