import 'dotenv/config';
import WebSocket from 'ws';

export const BASE = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3100}`;
export const WS_BASE = BASE.replace(/^http/, 'ws');

/** Bengaluru city centre — the default map origin for every simulation. */
export const CENTER = { lat: 12.9716, lng: 77.5946 };

export async function api(method, path, { token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) {
    const err = new Error(json.error || `HTTP ${res.status} on ${method} ${path}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

/** Register, or log in if the account already exists. Keeps seeding idempotent. */
export async function ensureAccount({ email, password, name, role, vehicle, plate }) {
  try {
    return await api('POST', '/api/auth/register', {
      body: { email, password, name, role, vehicle, plate },
    });
  } catch (err) {
    if (err.status === 409) {
      return api('POST', '/api/auth/login', { body: { email, password } });
    }
    throw err;
  }
}

/** Open an authenticated socket and resolve once the server confirms it. */
export function connect(token, onMessage) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => reject(new Error('websocket connect timeout')), 10_000);

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'connected') {
        clearTimeout(timer);
        resolve(socket);
      }
      onMessage?.(msg, socket);
    });

    socket.on('error', (err) => { clearTimeout(timer); reject(err); });
    socket.on('close', (code) => {
      if (code === 4001) { clearTimeout(timer); reject(new Error('websocket unauthorized')); }
    });
  });
}

export const send = (socket, payload) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Parse `--key=value` / `--flag` argv into an object. */
export function args(defaults = {}) {
  const out = { ...defaults };
  for (const arg of process.argv.slice(2)) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) continue;
    const [, key, value] = m;
    out[key] = value === undefined ? true : /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  }
  return out;
}

export async function waitForServer(attempts = 40) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`server at ${BASE} never became healthy — is \`npm start\` running?`);
}

// Small console helpers so simulation output stays readable.
export const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};
