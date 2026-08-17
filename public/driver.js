import {
  api, store, openSocket, createMap, pinIcon, glideMarker, CENTER,
  $, log, toast, setPill, fmtDuration, fmtDistance,
} from './app-common.js';

const map = createMap('map');
const logEl = $('#log');

const PING_MS = 1500;   // how often we stream position while online
const TICK_MS = 200;    // auto-drive animation step

const state = {
  socket: null,
  online: false,
  position: { lat: CENTER[0], lng: CENTER[1] },
  marker: null,
  offer: null,
  offerTimer: null,
  job: null,            // active ride
  jobMarkers: {},
  autoDrive: false,
  speedKmh: 40,
};

// ------------------------------------------------------------------ auth

$('#login').onclick = () => authenticate('/api/auth/login');
$('#register').onclick = () => authenticate('/api/auth/register', {
  role: 'driver', vehicle: 'Sedan', plate: 'KA-01-WEB',
});

async function authenticate(path, extra = {}) {
  try {
    const email = $('#email').value.trim();
    const { token, user, driverId } = await api('POST', path, {
      email, password: $('#password').value, name: email.split('@')[0], ...extra,
    });
    if (user.role !== 'driver') throw new Error('This account is a rider — use the rider page.');

    store.token = token;
    store.user = user;
    store.driverId = driverId;
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
  $('#movement').classList.remove('hidden');
  $('#who').textContent = store.user?.email || '—';

  placeCar(state.position.lat, state.position.lng);
  connect();
  await restoreState();
}

// ------------------------------------------------------------------ socket

function connect() {
  state.socket = openSocket({
    onStatus: (status) => {
      const table = {
        open: ['connected', 'live'],
        closed: ['reconnecting…', 'waiting'],
        error: ['error', 'error'],
        unauthorized: ['signed out', 'error'],
      };
      const [text, kind] = table[status] || ['offline', 'off'];
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

    case 'ride:offer':
      showOffer(msg);
      break;

    case 'ride:offer_expired':
      if (state.offer?.ride.id === msg.rideId) {
        log(logEl, `offer expired${msg.reason ? ` (${msg.reason})` : ''}`, 'warn');
        hideOffer();
      }
      break;

    case 'ride:assigned':
      state.job = msg.ride;
      hideOffer();
      log(logEl, 'ride assigned — head to pickup', 'ok');
      toast('Ride assigned', 'ok');
      showJob(msg.ride);
      break;

    case 'ride:status':
      state.job = msg.ride;
      log(logEl, `ride ${msg.ride.status}`, 'info');
      if (['completed', 'cancelled'].includes(msg.ride.status)) {
        toast(`Ride ${msg.ride.status}`, msg.ride.status === 'completed' ? 'ok' : '');
        clearJob();
      } else {
        showJob(msg.ride);
      }
      break;

    case 'error':
      log(logEl, msg.message, 'err');
      break;
  }
}

// ------------------------------------------------------------------ online

$('#toggleOnline').onclick = async () => {
  try {
    if (state.online) {
      await api('POST', '/api/drivers/offline');
      state.online = false;
      setPill($('#avail'), 'offline', 'off');
      $('#toggleOnline').textContent = 'Go online';
      log(logEl, 'went offline', 'warn');
    } else {
      await api('POST', '/api/drivers/online', state.position);
      state.online = true;
      setPill($('#avail'), 'available', 'live');
      $('#toggleOnline').textContent = 'Go offline';
      log(logEl, 'online — streaming position', 'ok');
      pingPosition();
    }
  } catch (err) {
    toast(err.message, 'err');
    log(logEl, err.message, 'err');
  }
};

/**
 * Position stream.
 *
 * Runs unconditionally while online, including during a ride — this is the feed
 * the rider's map is drawing from. The server treats silence longer than
 * DRIVER_STALE_MS as a lost driver and stops offering them work, so this
 * interval is what keeps a driver dispatchable.
 */
setInterval(() => {
  if (state.online && state.socket?.ready) pingPosition();
}, PING_MS);

function pingPosition() {
  state.socket?.send({
    type: 'driver:location',
    lat: state.position.lat,
    lng: state.position.lng,
  });
  $('#posText').textContent = `${state.position.lat.toFixed(5)}, ${state.position.lng.toFixed(5)}`;
}

// ------------------------------------------------------------------ offers

function showOffer(msg) {
  state.offer = msg;
  $('#offerBox').classList.remove('hidden');
  $('#offerDistance').textContent = fmtDistance(msg.distanceMeters);
  $('#offerEta').textContent = fmtDuration(msg.etaSeconds);
  log(logEl, `offer: ride ${msg.ride.id.slice(0, 8)} · ${fmtDistance(msg.distanceMeters)} away`, 'info');
  toast('New ride offer', 'ok');

  // Count the offer window down visually. The bar running out is the same
  // OFFER_TIMEOUT_MS the dispatcher is waiting on before it moves to the next
  // driver — and the same window during which this driver is exclusively locked.
  const expiry = Date.now() + msg.expiresInMs;
  clearInterval(state.offerTimer);
  state.offerTimer = setInterval(() => {
    const left = Math.max(0, expiry - Date.now());
    $('#offerTimer').style.width = `${(left / msg.expiresInMs) * 100}%`;
    if (left === 0) { hideOffer(); log(logEl, 'offer timed out', 'warn'); }
  }, 100);

  showPickupPin(msg.ride);
}

function hideOffer() {
  clearInterval(state.offerTimer);
  state.offer = null;
  $('#offerBox').classList.add('hidden');
}

$('#accept').onclick = () => respond('driver:accept');
$('#reject').onclick = () => respond('driver:reject');

function respond(type) {
  if (!state.offer) return;
  state.socket?.send({ type, rideId: state.offer.ride.id });
  log(logEl, type === 'driver:accept' ? 'accepted' : 'declined', type === 'driver:accept' ? 'ok' : 'warn');
  hideOffer();
}

// ------------------------------------------------------------------ job

function showJob(ride) {
  $('#jobBox').classList.remove('hidden');
  setPill($('#jobStatus'), ride.status.replace('_', ' '), 'live');

  const inProgress = ride.status === 'in_progress';
  $('#startRide').classList.toggle('hidden', inProgress);
  $('#completeRide').classList.toggle('hidden', !inProgress);
  $('#jobTargetLabel').textContent = inProgress ? 'To dropoff' : 'To pickup';

  showPickupPin(ride);
  updateJobMetrics();
}

function showPickupPin(ride) {
  for (const [key, glyph] of [['pickup', '●'], ['dropoff', '■']]) {
    const point = ride[key];
    if (!point) continue;
    if (state.jobMarkers[key]) map.removeLayer(state.jobMarkers[key]);
    state.jobMarkers[key] = L.marker([point.lat, point.lng], {
      icon: pinIcon(key === 'pickup' ? 'pickup' : 'drop', glyph),
    }).addTo(map).bindTooltip(key === 'pickup' ? 'Pickup' : 'Dropoff');
  }
}

function clearJob() {
  state.job = null;
  $('#jobBox').classList.add('hidden');
  for (const key of Object.keys(state.jobMarkers)) {
    map.removeLayer(state.jobMarkers[key]);
    delete state.jobMarkers[key];
  }
}

$('#startRide').onclick = async () => {
  try {
    const { ride } = await api('POST', `/api/rides/${state.job.id}/start`);
    state.job = ride;
    showJob(ride);
    log(logEl, 'trip started', 'ok');
  } catch (err) { toast(err.message, 'err'); }
};

$('#completeRide').onclick = async () => {
  try {
    await api('POST', `/api/rides/${state.job.id}/complete`);
    log(logEl, 'trip completed', 'ok');
    clearJob();
  } catch (err) { toast(err.message, 'err'); }
};

function currentTarget() {
  if (!state.job) return null;
  return state.job.status === 'in_progress' ? state.job.dropoff : state.job.pickup;
}

function updateJobMetrics() {
  const target = currentTarget();
  if (!target) return;
  const metres = haversine(state.position, target);
  $('#jobDistance').textContent = fmtDistance(metres);
  $('#jobEta').textContent = fmtDuration(metres / ((state.speedKmh * 1000) / 3600));
}

// ------------------------------------------------------------------ movement

function placeCar(lat, lng) {
  state.position = { lat, lng };
  if (state.marker) {
    state.marker.setLatLng([lat, lng]);
  } else {
    state.marker = L.marker([lat, lng], { icon: pinIcon('car', '🚗'), draggable: true })
      .addTo(map).bindTooltip('You');
    state.marker.on('drag', (e) => {
      state.position = { lat: e.latlng.lat, lng: e.latlng.lng };
      updateJobMetrics();
    });
    state.marker.on('dragend', pingPosition);
    map.setView([lat, lng], 15);
  }
}

$('#recentre').onclick = () => map.setView([state.position.lat, state.position.lng], 15);

$('#speed').oninput = (e) => {
  state.speedKmh = Number(e.target.value);
  $('#speedLabel').textContent = state.speedKmh;
};

$('#autoDrive').onclick = () => {
  state.autoDrive = !state.autoDrive;
  $('#autoDrive').textContent = `Auto-drive: ${state.autoDrive ? 'on' : 'off'}`;
  log(logEl, `auto-drive ${state.autoDrive ? 'engaged' : 'disengaged'}`, 'info');
};

/**
 * Auto-drive: walk toward the current target at the selected speed.
 * Purely a demo convenience — it stands in for a real GPS feed so you can
 * watch the rider's map update without physically moving a phone.
 */
setInterval(() => {
  if (!state.autoDrive) return;
  const target = currentTarget();
  if (!target) return;

  const step = ((state.speedKmh * 1000) / 3600) * (TICK_MS / 1000);
  const remaining = haversine(state.position, target);

  if (remaining <= step) {
    placeCarSmooth(target.lat, target.lng);
    // Arrived: advance the trip automatically so the demo runs itself.
    if (state.job?.status === 'matched') $('#startRide').click();
    else if (state.job?.status === 'in_progress') $('#completeRide').click();
    return;
  }

  const next = moveToward(state.position, target, step);
  placeCarSmooth(next.lat, next.lng);
  updateJobMetrics();
}, TICK_MS);

function placeCarSmooth(lat, lng) {
  state.position = { lat, lng };
  if (state.marker) glideMarker(state.marker, [lat, lng], TICK_MS);
  else placeCar(lat, lng);
}

// ------------------------------------------------------------------ restore

async function restoreState() {
  try {
    const me = await api('GET', '/api/drivers/me');
    if (me.position) placeCar(me.position.lat, me.position.lng);

    if (me.driver?.is_online) {
      state.online = true;
      setPill($('#avail'), 'available', 'live');
      $('#toggleOnline').textContent = 'Go offline';
    }
    if (me.activeRide) {
      state.job = me.activeRide;
      showJob(me.activeRide);
      log(logEl, `resumed ride (${me.activeRide.status})`, 'info');
    }
  } catch (err) {
    log(logEl, `could not restore state: ${err.message}`, 'warn');
  }
}

// ------------------------------------------------------------------ geo maths

function haversine(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

function moveToward(from, to, metres) {
  const total = haversine(from, to);
  if (total === 0) return from;
  const t = metres / total;
  return { lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t };
}

// ------------------------------------------------------------------ boot

if (store.token && store.user?.role === 'driver') {
  onSignedIn().catch(() => { store.clear(); location.reload(); });
}
