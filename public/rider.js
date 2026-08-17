import {
  api, store, openSocket, createMap, pinIcon, dotIcon, glideMarker,
  $, log, toast, setPill, fmtDuration, fmtDistance,
} from './app-common.js';

const map = createMap('map');
const logEl = $('#log');

const state = {
  pickup: null,
  dropoff: null,
  ride: null,
  socket: null,
  markers: { pickup: null, dropoff: null, driver: null },
  nearby: new Map(),   // driverId -> marker, for the idle-driver dots
  routeLine: null,
};

// ------------------------------------------------------------------ auth

$('#login').onclick = () => authenticate('/api/auth/login');
$('#register').onclick = () => authenticate('/api/auth/register', { role: 'rider' });

async function authenticate(path, extra = {}) {
  try {
    const body = {
      email: $('#email').value.trim(),
      password: $('#password').value,
      name: $('#email').value.split('@')[0],
      ...extra,
    };
    const { token, user } = await api('POST', path, body);
    store.token = token;
    store.user = user;
    log(logEl, `signed in as ${user.email}`, 'ok');
    await onSignedIn();
  } catch (err) {
    toast(err.message, 'err');
    log(logEl, err.message, 'err');
  }
}

$('#logout').onclick = () => {
  state.socket?.close();
  store.clear();
  location.reload();
};

async function onSignedIn() {
  $('#auth').classList.add('hidden');
  $('#session').classList.remove('hidden');
  $('#request').classList.remove('hidden');
  $('#who').textContent = store.user?.email || '—';

  connect();
  await restoreActiveRide();
  refreshNearby();
  setInterval(refreshNearby, 5000);
}

// ------------------------------------------------------------------ socket

function connect() {
  state.socket = openSocket({
    onStatus: (status) => {
      const map = {
        open: ['connected', 'live'],
        closed: ['reconnecting…', 'waiting'],
        error: ['error', 'error'],
        unauthorized: ['signed out', 'error'],
      };
      const [text, kind] = map[status] || ['offline', 'off'];
      setPill($('#conn'), text, kind);
      if (status === 'unauthorized') { store.clear(); location.reload(); }
    },
    onMessage: handleMessage,
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'connected':
      log(logEl, 'websocket connected', 'ok');
      break;

    case 'ride:matched':
      state.ride = msg.ride;
      log(logEl, `matched with ${msg.driver?.name || 'a driver'}`, 'ok');
      toast(`Matched with ${msg.driver?.name || 'a driver'}`, 'ok');
      showRide(msg.ride, msg.driver);
      break;

    case 'ride:no_drivers':
      log(logEl, 'no drivers available', 'warn');
      toast('No drivers available nearby', 'err');
      if (msg.attempts?.length) {
        log(logEl, `tried ${msg.attempts.length} driver(s): ${msg.attempts.map((a) => a.response).join(', ')}`, 'warn');
      }
      clearRide();
      break;

    /** The live-tracking payload — this is what moves the car on the map. */
    case 'driver:position': {
      if (!state.ride || msg.rideId !== state.ride.id) break;
      moveDriver(msg.lat, msg.lng);
      $('#eta').innerHTML = `${fmtDuration(msg.etaSeconds)}`;
      $('#distance').textContent = fmtDistance(msg.distanceMeters);
      $('#etaLabel').textContent = msg.heading === 'dropoff' ? 'ETA to dropoff' : 'ETA to pickup';
      break;
    }

    case 'ride:status':
      state.ride = msg.ride;
      log(logEl, `ride ${msg.ride.status}`, msg.ride.status === 'completed' ? 'ok' : 'info');
      updateStatusPill(msg.ride.status);

      if (msg.ride.status === 'in_progress') {
        toast('Trip started', 'ok');
        $('#etaLabel').textContent = 'ETA to dropoff';
      }
      if (['completed', 'cancelled'].includes(msg.ride.status)) {
        toast(`Ride ${msg.ride.status}`, msg.ride.status === 'completed' ? 'ok' : '');
        setTimeout(clearRide, 2500);
      }
      break;

    case 'error':
      log(logEl, msg.message, 'err');
      break;
  }
}

// ------------------------------------------------------------------ map input

map.on('click', (event) => {
  if (state.ride) return; // points are locked once a ride is live
  const point = { lat: +event.latlng.lat.toFixed(6), lng: +event.latlng.lng.toFixed(6) };

  if (!state.pickup) {
    state.pickup = point;
    state.markers.pickup = L.marker([point.lat, point.lng], { icon: pinIcon('pickup', '●') })
      .addTo(map).bindTooltip('Pickup');
    $('#pickupText').textContent = fmtPoint(point);
    $('#pickHint').innerHTML = 'Now click the map to set your <b>dropoff</b>.';
    refreshNearby();
  } else if (!state.dropoff) {
    state.dropoff = point;
    state.markers.dropoff = L.marker([point.lat, point.lng], { icon: pinIcon('drop', '■') })
      .addTo(map).bindTooltip('Dropoff');
    $('#dropoffText').textContent = fmtPoint(point);
    $('#pickHint').textContent = 'Ready to request.';
    $('#requestRide').disabled = false;
    drawRoute();
  }
});

$('#resetPoints').onclick = resetPoints;

function resetPoints() {
  for (const key of ['pickup', 'dropoff', 'driver']) {
    if (state.markers[key]) { map.removeLayer(state.markers[key]); state.markers[key] = null; }
  }
  if (state.routeLine) { map.removeLayer(state.routeLine); state.routeLine = null; }
  state.pickup = state.dropoff = null;
  $('#pickupText').textContent = $('#dropoffText').textContent = '—';
  $('#pickHint').innerHTML = 'Click the map to set your <b>pickup</b>.';
  $('#requestRide').disabled = true;
}

function drawRoute() {
  if (state.routeLine) map.removeLayer(state.routeLine);
  if (!state.pickup || !state.dropoff) return;
  state.routeLine = L.polyline(
    [[state.pickup.lat, state.pickup.lng], [state.dropoff.lat, state.dropoff.lng]],
    { color: '#4f8cff', weight: 2, opacity: .5, dashArray: '6 8' }
  ).addTo(map);
}

// ------------------------------------------------------------------ actions

$('#requestRide').onclick = async () => {
  $('#requestRide').disabled = true;
  try {
    const { ride } = await api('POST', '/api/rides', {
      pickup: state.pickup,
      dropoff: state.dropoff,
    });
    state.ride = ride;
    log(logEl, `ride requested — searching for a driver`, 'info');
    showRide(ride, null);
  } catch (err) {
    toast(err.message, 'err');
    log(logEl, err.message, 'err');
    $('#requestRide').disabled = false;
  }
};

$('#cancelRide').onclick = async () => {
  if (!state.ride) return;
  try {
    await api('POST', `/api/rides/${state.ride.id}/cancel`);
    log(logEl, 'ride cancelled', 'warn');
    clearRide();
  } catch (err) {
    toast(err.message, 'err');
  }
};

// ------------------------------------------------------------------ ride ui

function showRide(ride, driver) {
  $('#request').classList.add('hidden');
  $('#ride').classList.remove('hidden');
  updateStatusPill(ride.status);

  if (driver) {
    $('#driverName').textContent = driver.name;
    $('#driverVehicle').textContent = `${driver.vehicle} · ${driver.plate}`;
    if (driver.position) moveDriver(driver.position.lat, driver.position.lng);
  }

  // Make sure the pickup/dropoff pins exist even after a page reload.
  if (!state.markers.pickup) {
    state.pickup = ride.pickup;
    state.markers.pickup = L.marker([ride.pickup.lat, ride.pickup.lng], { icon: pinIcon('pickup', '●') })
      .addTo(map).bindTooltip('Pickup');
    $('#pickupText').textContent = fmtPoint(ride.pickup);
  }
  if (!state.markers.dropoff) {
    state.dropoff = ride.dropoff;
    state.markers.dropoff = L.marker([ride.dropoff.lat, ride.dropoff.lng], { icon: pinIcon('drop', '■') })
      .addTo(map).bindTooltip('Dropoff');
    $('#dropoffText').textContent = fmtPoint(ride.dropoff);
  }
  drawRoute();
}

function updateStatusPill(status) {
  const kinds = {
    requested: 'waiting', matched: 'live', in_progress: 'live',
    completed: 'off', cancelled: 'off', no_drivers: 'error',
  };
  setPill($('#rideStatus'), status.replace('_', ' '), kinds[status] || 'off');
}

function clearRide() {
  state.ride = null;
  $('#ride').classList.add('hidden');
  $('#request').classList.remove('hidden');
  $('#driverName').textContent = 'searching…';
  $('#driverVehicle').textContent = '—';
  $('#eta').textContent = $('#distance').textContent = '—';
  resetPoints();
}

function moveDriver(lat, lng) {
  if (!state.markers.driver) {
    state.markers.driver = L.marker([lat, lng], { icon: pinIcon('car', '🚗') })
      .addTo(map).bindTooltip('Your driver');
    map.panTo([lat, lng]);
  } else {
    glideMarker(state.markers.driver, [lat, lng]);
  }
}

async function restoreActiveRide() {
  try {
    const { ride, driver } = await api('GET', '/api/rides/active');
    if (!ride) return;
    state.ride = ride;
    log(logEl, `resumed active ride (${ride.status})`, 'info');
    showRide(ride, driver);
  } catch { /* nothing to resume */ }
}

// ------------------------------------------------------------------ nearby

/**
 * Idle-driver dots. Purely informational, but it makes the geospatial layer
 * visible: you can watch the fleet move and see which drivers are candidates
 * before ever requesting a ride.
 */
async function refreshNearby() {
  const centre = state.pickup || { lat: map.getCenter().lat, lng: map.getCenter().lng };
  try {
    const res = await api('GET', `/api/drivers/nearby?lat=${centre.lat}&lng=${centre.lng}&radius=6000&limit=60`);
    $('#nearbyCount').textContent = `${res.count} within 6 km`;

    const seen = new Set();
    for (const driver of res.drivers) {
      seen.add(driver.driverId);
      const existing = state.nearby.get(driver.driverId);
      if (existing) {
        glideMarker(existing, [driver.lat, driver.lng], 1200);
      } else {
        state.nearby.set(driver.driverId,
          L.marker([driver.lat, driver.lng], { icon: dotIcon(false), interactive: false }).addTo(map));
      }
    }
    for (const [id, marker] of state.nearby) {
      if (!seen.has(id)) { map.removeLayer(marker); state.nearby.delete(id); }
    }
  } catch { /* ignore transient failures */ }
}

const fmtPoint = (p) => `${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`;

// ------------------------------------------------------------------ boot

if (store.token && store.user) {
  onSignedIn().catch(() => { store.clear(); location.reload(); });
}
