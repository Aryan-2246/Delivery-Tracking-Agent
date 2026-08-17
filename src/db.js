import pg from 'pg';
import { config } from './config.js';

// Postgres returns DOUBLE PRECISION (OID 701) as a string by default in some
// driver versions; force numbers so lat/lng arithmetic never silently
// string-concatenates.
pg.types.setTypeParser(701, (v) => (v === null ? null : parseFloat(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

export const query = (text, params) => pool.query(text, params);

/** Run a function inside a transaction, rolling back on any throw. */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres unique-violation. Used to detect the double-booking backstop firing. */
export const isUniqueViolation = (err) => err && err.code === '23505';

export async function waitForDb({ attempts = 30, delayMs = 1000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
