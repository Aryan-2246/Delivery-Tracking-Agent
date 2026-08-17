import { api, createMap, dotIcon, pinIcon, glideMarker, $, fmtDistance } from './app-common.js';

/**
 * Observer view. No auth — /api/drivers/nearby and /health are both public so
 * the geospatial layer can be inspected without a session.
 *
 * The point of this page is to make the matching index legible: every dot is a
 * row in the Redis sorted set, and the probe runs the exact query the
 * dispatcher runs.
 */

const map = createMap('map');
const markers = new Map(); // driverId -> marker
let probeMarker = null;
let probeCircle = null;
let probeLines = [];

const opts = { radius: 3000, limit: 5 };

$('#radius').oninput = (e) => {
  opts.radius = Number(e.target.value);
  $('#radiusLabel').textContent = opts.radius;
  if (probeMarker) runProbe(probeMarker.getLatLng());
};

$('#limit').oninput = (e) => {
  opts.limit = Number(e.target.value);
  $('#limitLabel').textContent = opts.limit;
  if (probeMarker) runProbe(probeMarker.getLatLng());
};

map.on('click', (e) => runProbe(e.latlng));

// ------------------------------------------------------------------ probe

async function runProbe({ lat, lng }) {
  const started = performance.now();
  const res = await api('GET',
    `/api/drivers/nearby?lat=${lat}&lng=${lng}&radius=${opts.radius}&limit=${opts.limit}`);
  const elapsed = performance.now() - started;

  $('#probePoint').textContent = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  $('#probeCount').textContent = `${res.count} of ${res.availableTotal} available`;
  $('#probeMs').textContent = `${elapsed.toFixed(1)} ms`;

  if (probeMarker) map.removeLayer(probeMarker);
  if (probeCircle) map.removeLayer(probeCircle);
  probeLines.forEach((l) => map.removeLayer(l));
  probeLines = [];

  probeMarker = L.marker([lat, lng], { icon: pinIcon('pickup', '◎') }).addTo(map).bindTooltip('Probe');
  probeCircle = L.circle([lat, lng], {
    radius: opts.radius, color: '#4f8cff', weight: 1, fillOpacity: 0.04, dashArray: '4 6',
  }).addTo(map);

  // Draw a line to each hit, fading with rank — makes the nearest-first
  // ordering obvious at a glance.
  res.drivers.forEach((driver, i) => {
    probeLines.push(L.polyline([[lat, lng], [driver.lat, driver.lng]], {
      color: '#4f8cff',
      weight: 2,
      opacity: Math.max(0.15, 1 - i / res.drivers.length),
    }).addTo(map));
  });

  const list = $('#results');
  list.innerHTML = '';
  if (!res.drivers.length) {
    list.innerHTML = '<div class="warn">no drivers in range</div>';
    return;
  }
  res.drivers.forEach((driver, i) => {
    const row = document.createElement('div');
    row.innerHTML =
      `<span class="t">${String(i + 1).padStart(2, ' ')}.</span> ` +
      `<span class="ok">${fmtDistance(driver.distanceMeters).padStart(9, ' ')}</span> ` +
      `<span class="t">${driver.driverId.slice(0, 8)}</span> ` +
      `<span class="info">${(driver.ageMs / 1000).toFixed(1)}s ago</span>`;
    list.appendChild(row);
  });
}

// ------------------------------------------------------------------ fleet

async function refreshFleet() {
  try {
    const centre = map.getCenter();
    const res = await api('GET',
      `/api/drivers/nearby?lat=${centre.lat}&lng=${centre.lng}&radius=50000&limit=100`);

    const seen = new Set();
    for (const driver of res.drivers) {
      seen.add(driver.driverId);
      const existing = markers.get(driver.driverId);
      if (existing) {
        glideMarker(existing, [driver.lat, driver.lng], 1800);
      } else {
        markers.set(driver.driverId,
          L.marker([driver.lat, driver.lng], { icon: dotIcon(false) })
            .addTo(map)
            .bindTooltip(`${driver.driverId.slice(0, 8)}`));
      }
    }
    for (const [id, marker] of markers) {
      if (!seen.has(id)) { map.removeLayer(marker); markers.delete(id); }
    }
  } catch { /* transient */ }
}

async function refreshHealth() {
  try {
    const h = await api('GET', '/health');
    const pill = $('#health');
    pill.textContent = h.ok ? 'healthy' : 'degraded';
    pill.className = `status-pill ${h.ok ? 'live' : 'error'}`;
    $('#available').textContent = h.availableDrivers ?? '—';
    $('#sockets').innerHTML =
      `${h.sockets?.total ?? 0} <small>(${h.sockets?.drivers ?? 0} drivers)</small>`;
    $('#pg').textContent = h.postgres;
    $('#rd').textContent = h.redis;
    $('#uptime').textContent = `${Math.floor(h.uptimeSeconds / 60)}m ${h.uptimeSeconds % 60}s`;
  } catch {
    const pill = $('#health');
    pill.textContent = 'unreachable';
    pill.className = 'status-pill error';
  }
}

refreshHealth();
refreshFleet();
setInterval(refreshHealth, 3000);
setInterval(refreshFleet, 2000);
