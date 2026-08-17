/* Shared browser helpers: auth, API calls, socket handling, map setup. */

export const API = '';

export const store = {
  get token() { return localStorage.getItem('token'); },
  set token(v) { v ? localStorage.setItem('token', v) : localStorage.removeItem('token'); },
  get user() { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; } },
  set user(v) { v ? localStorage.setItem('user', JSON.stringify(v)) : localStorage.removeItem('user'); },
  get driverId() { return localStorage.getItem('driverId') || null; },
  set driverId(v) { v ? localStorage.setItem('driverId', v) : localStorage.removeItem('driverId'); },
  clear() { this.token = null; this.user = null; this.driverId = null; },
};

export async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(store.token ? { authorization: `Bearer ${store.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }

  if (!res.ok) {
    const err = new Error(json.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return json;
}

/**
 * Authenticated WebSocket with automatic reconnect.
 *
 * Reconnection matters more than it looks: a driver whose socket drops stops
 * sending positions, ages out of the matching pool after DRIVER_STALE_MS, and
 * silently stops receiving work. Backing off and retrying is what keeps them
 * dispatchable across a flaky connection.
 */
export function openSocket({ onMessage, onStatus }) {
  let socket;
  let retries = 0;
  let closed = false;

  const connect = () => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(store.token)}`);

    socket.onopen = () => { retries = 0; onStatus?.('open'); };

    socket.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      onMessage(msg);
    };

    socket.onclose = (event) => {
      onStatus?.(event.code === 4001 ? 'unauthorized' : 'closed');
      if (closed || event.code === 4001) return;
      const delay = Math.min(1000 * 2 ** retries++, 15_000);
      setTimeout(connect, delay);
    };

    socket.onerror = () => onStatus?.('error');
  };

  connect();

  return {
    send(payload) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    },
    close() { closed = true; socket?.close(); },
    get ready() { return socket?.readyState === WebSocket.OPEN; },
  };
}

// ------------------------------------------------------------------ map

export const CENTER = [12.9716, 77.5946];

export function createMap(elementId) {
  const map = L.map(elementId, { zoomControl: false }).setView(CENTER, 14);

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 19,
  }).addTo(map);

  return map;
}

export const pinIcon = (kind, glyph) => L.divIcon({
  className: '',
  html: `<div class="pin ${kind}">${glyph}</div>`,
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

export const dotIcon = (busy) => L.divIcon({
  className: '',
  html: `<div class="driver-dot ${busy ? 'busy' : ''}"></div>`,
  iconSize: [12, 12],
  iconAnchor: [6, 6],
});

/**
 * Glide a marker between position updates.
 *
 * Drivers report every second or two; snapping the marker makes live tracking
 * look broken even when it is working perfectly. Interpolating between the last
 * and next fix is the difference between a demo that reads as real-time and one
 * that reads as a polling loop.
 */
export function glideMarker(marker, to, durationMs = 900) {
  const from = marker.getLatLng();
  const start = performance.now();

  if (marker._glide) cancelAnimationFrame(marker._glide);

  const tick = (now) => {
    const t = Math.min(1, (now - start) / durationMs);
    const eased = t * (2 - t); // ease-out
    marker.setLatLng([
      from.lat + (to[0] - from.lat) * eased,
      from.lng + (to[1] - from.lng) * eased,
    ]);
    if (t < 1) marker._glide = requestAnimationFrame(tick);
  };

  marker._glide = requestAnimationFrame(tick);
}

// ------------------------------------------------------------------ ui bits

export const $ = (sel) => document.querySelector(sel);

export function log(container, message, kind = '') {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const line = document.createElement('div');
  line.innerHTML = `<span class="t">${time}</span> <span class="${kind}">${escapeHtml(message)}</span>`;
  container.prepend(line);
  while (container.childElementCount > 100) container.lastElementChild.remove();
}

export function toast(message, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

export function setPill(el, text, kind) {
  el.textContent = text;
  el.className = `status-pill ${kind}`;
}

export const fmtDuration = (seconds) => {
  if (seconds === null || seconds === undefined) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`;
};

export const fmtDistance = (metres) => {
  if (metres === null || metres === undefined) return '—';
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(2)} km`;
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}
