/* ================================================================
   BusAlert v3 — App Logic with Live Map (Leaflet + Firebase)
   ================================================================ */

'use strict';

// ─── STATE ───────────────────────────────────────────────────────
const S = {
  db: null, fbOk: false,

  // Sleep mode
  sleepOn: false, sleepWid: null, home: null, sleptAlert: false,

  // Bus tracker
  trackOn: false, trackedId: null, trackAlerted: false,
  stopLoc: null, allBuses: {},

  // Driver
  driverOn: false, driverWid: null, driverBusId: null, driverUpdates: 0,
  savedBuses: [],


  // Map
  map: null,
  busMarker: null,
  stopMarker: null,
  stopCircle: null,
  busLatLng: null,       // last known bus position
  prevLatLng: null,      // for smooth animation
};

// ─── BOOT ─────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => {
    const sp = document.getElementById('splash');
    sp.classList.add('out');
    setTimeout(() => { sp.classList.add('hidden'); document.getElementById('app').classList.remove('hidden'); boot(); }, 500);
  }, 2200);
});

// ─── FIREBASE CONFIG (hardcoded — works on all devices automatically) ──────
const FIREBASE_CFG = {
  apiKey: "AIzaSyDPlNBmoYHUN8Ao-6j08Ez8HC0wnGWw2q8",
  authDomain: "bus-alert-3941d.firebaseapp.com",
  databaseURL: "https://bus-alert-3941d-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "bus-alert-3941d",
  storageBucket: "bus-alert-3941d.firebasestorage.app",
  messagingSenderId: "313411935231",
  appId: "1:313411935231:web:24d20abfcc5609d35525ca"
};

function boot() {
  loadLocal();
  reqNotifPerm();
  // Always connect using hardcoded config — no manual setup needed
  loadFbSdk(() => connectFb(FIREBASE_CFG));
}

// ─── PERSISTENCE ─────────────────────────────────────────────────
function ls(k) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch { return null; } }
function lsSave(k, v) { localStorage.setItem(k, JSON.stringify(v)); }
function lsGet(k) { return localStorage.getItem(k); }
function lsSet(k, v) { localStorage.setItem(k, v); }

function loadLocal() {
  const h = ls('ba_home'); if (h) { S.home = h; renderHomeCoord(); }
  const s = ls('ba_stop'); if (s) { S.stopLoc = s; renderStopCoord(); }
  const sr = lsGet('ba_sr'); if (sr) { q('#sleep-radius').value = sr; updateRadius('sleep'); }
  const tr = lsGet('ba_tr'); if (tr) { q('#track-radius').value = tr; updateRadius('track'); }
  const sb = ls('ba_saved_buses'); if (sb) { S.savedBuses = sb; renderSavedBuses(); }
}


// ─── FIREBASE ────────────────────────────────────────────────────
function loadFbSdk(cb) {
  if (window.firebase) { cb(); return; }
  const srcs = [
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.7.1/firebase-database-compat.js',
  ];
  let n = 0;
  srcs.forEach(src => {
    const t = document.createElement('script');
    t.src = src;
    t.onload = () => { if (++n === srcs.length) cb(); };
    t.onerror = () => showToast('❌ Could not load Firebase.');
    document.head.appendChild(t);
  });
}

function connectFb(cfg) {
  try {
    if (!window.firebase.apps?.length) window.firebase.initializeApp(cfg);
    S.db = window.firebase.database();
    S.fbOk = true;
    setStatus('Connected', true);
    showToast('🔥 Firebase ready!');
    startBusListener();
  } catch (e) { showToast('❌ Firebase: ' + e.message); }
}

function saveFirebase() {
  const apiKey = q('#cfg-key').value.trim();
  const authDomain = q('#cfg-domain').value.trim();
  const databaseURL = q('#cfg-db').value.trim();
  const projectId = q('#cfg-proj').value.trim();
  if (!apiKey || !databaseURL || !projectId) { showToast('⚠️ Fill all fields!'); return; }
  const cfg = { apiKey, authDomain, databaseURL, projectId };
  lsSave('ba_fb', cfg);
  closeModal();
  loadFbSdk(() => connectFb(cfg));
}

function openModal() { q('#fb-modal').classList.remove('hidden'); }
function closeModal() { q('#fb-modal').classList.add('hidden'); }

// ─── REAL-TIME BUS LISTENER ──────────────────────────────────────
function startBusListener() {
  if (!S.db) return;
  S.db.ref('buses').on('value', snap => {
    S.allBuses = snap.val() || {};

    // update tracked bus on map
    if (S.trackOn && S.trackedId && S.allBuses[S.trackedId]?.location) {
      const loc = S.allBuses[S.trackedId].location;
      moveBusOnMap(loc.lat, loc.lon);
      updateTrackInfo(loc);
    }

    // refresh search list if open
    const q2 = q('#route-search').value.trim();
    if (q2.length > 0) renderBusList(q2);
  });
}

// ─── TAB SWITCH ──────────────────────────────────────────────────
function switchTab(tab) {
  ['sleep', 'find', 'driver'].forEach(t => {
    q(`#panel-${t}`).classList.toggle('hidden', t !== tab);
    q(`#panel-${t}`).classList.toggle('active', t === tab);
    q(`#tab-${t}`).classList.toggle('active', t === tab);
  });
  // Init map lazily when Find Bus tab first opened
  if (tab === 'find' && S.trackOn && !S.map) initMap();
}

// ─── SEARCH ──────────────────────────────────────────────────────
function onSearch() {
  const val = q('#route-search').value.trim();
  q('#search-x').style.opacity = val ? '1' : '0';
  if (!val) { q('#bus-list').classList.add('hidden'); q('#bus-empty').classList.remove('hidden'); return; }
  if (!S.fbOk) { openModal(); return; }
  renderBusList(val);
}

function clearSearch() {
  q('#route-search').value = '';
  q('#search-x').style.opacity = '0';
  q('#bus-list').classList.add('hidden');
  q('#bus-empty').classList.remove('hidden');
}

function renderBusList(query) {
  const ql = query.toLowerCase();
  const list = q('#bus-list'), empty = q('#bus-empty');
  const matches = Object.entries(S.allBuses).filter(([, b]) => {
    if (!b.active || !b.location?.timestamp) return false;

    // Only show if updated in the last 15 minutes
    const isStale = (Date.now() - b.location.timestamp) > 15 * 60 * 1000;
    if (isStale) return false;

    return (b.route || '').toLowerCase().includes(ql)
      || (b.busNumber || '').toLowerCase().includes(ql)
      || (b.stops || []).some(s => s.toLowerCase().includes(ql));
  });

  if (!matches.length) {
    list.classList.add('hidden');
    empty.classList.remove('hidden');
    empty.innerHTML = `<div class="empty-ico">🚌</div><p>No live buses for "<b>${esc(query)}</b>".<br>Driver may not have started yet.</p>`;
    return;
  }
  empty.classList.add('hidden');
  list.classList.remove('hidden');

  list.innerHTML = matches.map(([id, b]) => {
    const stops = b.stops || [];
    const chips = stops.map(s => `<span class="bc-chip${s.toLowerCase().includes(ql) ? ' hl' : ''}">${esc(s)}</span>`).join('');
    return `
      <div class="bus-card" onclick="startTracking('${id}')">
        <div class="bc-top">
          <span class="bc-num">🚌 ${esc(b.busNumber || '--')}</span>
          <span class="bc-live"><span class="live-dot"></span>LIVE</span>
        </div>
        <div class="bc-route">📍 ${esc(b.route || '--')}</div>
        <div class="bc-stops">${chips}</div>
        <div class="bc-footer">
          <span class="bc-time">⏱ ${timeAgo(b.location?.timestamp)}</span>
          <button class="bc-track-btn" onclick="event.stopPropagation();startTracking('${id}')">
            ${S.trackedId === id && S.trackOn ? '📡 Tracking' : '▶ Track This'}
          </button>
        </div>
      </div>`;
  }).join('');
}

// ─── START TRACKING ──────────────────────────────────────────────
function startTracking(busId) {
  if (!S.fbOk) { openModal(); return; }
  if (S.trackOn && S.trackedId === busId) { showMapView(); return; }
  if (S.trackOn) stopTrackingInner(true);

  S.trackOn = true;
  S.trackAlerted = false;
  S.trackedId = busId;

  const bus = S.allBuses[busId] || {};
  setStatus('Tracking Bus', true);
  showToast(`📡 Tracking: ${bus.busNumber || busId}`);

  // Show map view
  showMapView();

  // Update panel info
  q('#map-bus-num').textContent = 'Bus ' + (bus.busNumber || '--');
  q('#map-bus-route').textContent = bus.route || '--';

  // Init map
  setTimeout(() => {
    initMap();
    // If bus already has a location, draw it immediately
    if (bus.location) {
      moveBusOnMap(bus.location.lat, bus.location.lon);
      updateTrackInfo(bus.location);
    }
    // Draw stop if already set
    if (S.stopLoc) drawStopMarker(S.stopLoc.lat, S.stopLoc.lon);
  }, 100);
}

function stopTracking() {
  stopTrackingInner(false);
  showSearchView();
}

function stopTrackingInner(silent) {
  S.trackOn = false;
  S.trackedId = null;
  S.trackAlerted = false;
  if (!silent) setStatus('Idle', false);
  hideMapAlert();
}

// ─── MAP ─────────────────────────────────────────────────────────
function initMap() {
  if (S.map) return; // already init'd

  S.map = L.map('live-map', { zoomControl: true, attributionControl: false }).setView([12.9716, 77.5946], 13);

  // Clean map tile — OpenStreetMap
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
  }).addTo(S.map);

  // Re-invalidate on show (fixes gray tiles)
  setTimeout(() => S.map.invalidateSize(), 200);
}

// Custom bus icon
function busIcon() {
  return L.divIcon({
    className: '',
    html: `<div class="bus-marker-icon">🚌</div>`,
    iconSize: [36, 36],
    iconAnchor: [18, 18],
  });
}

// Custom stop icon
function stopIcon() {
  return L.divIcon({
    className: '',
    html: `<div class="stop-marker-icon">🏠</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

// Move bus smoothly on map (Zomato-style animation)
function moveBusOnMap(lat, lon) {
  if (!S.map) return;
  const newLatLng = L.latLng(lat, lon);

  if (!S.busMarker) {
    // First time — place marker
    S.busMarker = L.marker([lat, lon], { icon: busIcon(), zIndexOffset: 100 }).addTo(S.map);
    S.map.setView([lat, lon], 15, { animate: true });
  } else {
    // Smooth animate to new position
    animateMarker(S.busMarker, S.busMarker.getLatLng(), newLatLng, 2000);
  }

  S.busLatLng = newLatLng;

  // Pan map to keep bus visible
  const bounds = S.map.getBounds();
  if (!bounds.contains(newLatLng)) {
    S.map.panTo(newLatLng, { animate: true, duration: 1.5 });
  }
}

// Smooth marker animation (linear interpolation)
function animateMarker(marker, from, to, durationMs) {
  const startTime = performance.now();
  function frame(now) {
    const t = Math.min((now - startTime) / durationMs, 1);
    const lat = from.lat + (to.lat - from.lat) * easeInOut(t);
    const lon = from.lng + (to.lng - from.lng) * easeInOut(t);
    marker.setLatLng([lat, lon]);
    if (t < 1) requestAnimationFrame(frame);
    else marker.setLatLng(to);
  }
  requestAnimationFrame(frame);
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
}

// Draw student's stop marker
function drawStopMarker(lat, lon) {
  if (!S.map) return;
  const radius = parseFloat(q('#track-radius').value) * 1000; // metres

  if (S.stopMarker) {
    S.stopMarker.setLatLng([lat, lon]);
    S.stopCircle.setLatLng([lat, lon]).setRadius(radius);
  } else {
    S.stopMarker = L.marker([lat, lon], { icon: stopIcon() }).addTo(S.map);
    S.stopCircle = L.circle([lat, lon], {
      radius,
      color: '#dc2626', fillColor: '#fca5a5',
      fillOpacity: 0.15, weight: 2, dashArray: '6,4',
    }).addTo(S.map);
  }

  // Fit map to show both bus and stop
  if (S.busMarker) {
    try {
      S.map.fitBounds(L.latLngBounds([S.busMarker.getLatLng(), [lat, lon]]).pad(0.3));
    } catch (e) { }
  } else {
    S.map.setView([lat, lon], 14, { animate: true });
  }
}

// ─── SHOW/HIDE MAP VIEW vs SEARCH VIEW ───────────────────────────
function showMapView() {
  q('#search-view').classList.add('hidden');
  q('#map-view').classList.remove('hidden');
  // map needs to know its size after being shown
  setTimeout(() => { if (S.map) S.map.invalidateSize(); }, 200);
}

function showSearchView() {
  q('#map-view').classList.add('hidden');
  q('#search-view').classList.remove('hidden');
  // clear map
  if (S.map) { S.map.remove(); S.map = null; S.busMarker = null; S.stopMarker = null; S.stopCircle = null; }
  q('#track-alert').classList.add('hidden');
}

// ─── TRACK INFO UPDATE ───────────────────────────────────────────
function updateTrackInfo(busLoc) {
  const t = timeAgo(busLoc.timestamp);
  q('#map-status-hint').textContent = `📡 Bus GPS updated ${t}`;

  if (!S.stopLoc) {
    q('#map-dist-val').textContent = '--';
    q('#map-eta-val').textContent = '--';
    return;
  }

  const dist = getDistance(busLoc.lat, busLoc.lon, S.stopLoc.lat, S.stopLoc.lon);
  q('#map-dist-val').textContent = dist < 10 ? dist.toFixed(2) : Math.round(dist);

  // Estimate ETA (assume avg bus speed ~30 km/h)
  const etaMin = Math.round((dist / 30) * 60);
  q('#map-eta-val').textContent = etaMin < 1 ? '<1' : etaMin;

  const radius = parseFloat(q('#track-radius').value);
  if (dist <= radius && !S.trackAlerted) triggerTrackAlert(dist);
}

function triggerTrackAlert(dist) {
  S.trackAlerted = true;
  q('#map-alert').classList.remove('hidden');
  q('#track-alert').classList.remove('hidden');
  if (q('#track-vibe').checked) doVibrate();
  if (q('#track-sound').checked) doSound();
  sendNotif('🚌 Bus is Near!', `Your bus is ${dist.toFixed(1)} km from your stop — get ready!`);
}

function hideMapAlert() {
  q('#map-alert').classList.add('hidden');
  q('#track-alert').classList.add('hidden');
}

// ─── STOP LOCATION ───────────────────────────────────────────────
function setStopFromGPS() {
  const btn = q('#btn-set-stop');
  btn.disabled = true; btn.innerHTML = '⏳ Getting GPS...';
  getPos(pos => {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    S.stopLoc = { lat, lon };
    lsSave('ba_stop', { lat, lon });
    renderStopCoord();
    if (S.map) drawStopMarker(lat, lon);
    // Update circle radius if already drawn
    if (S.stopCircle) S.stopCircle.setRadius(parseFloat(q('#track-radius').value) * 1000);
    btn.disabled = false; btn.innerHTML = '<span class="pill-ico">📍</span> Set My Stop Location';
    showToast(`✅ Stop set (±${Math.round(accuracy)}m)`);
    S.trackAlerted = false;
  }, err => {
    btn.disabled = false; btn.innerHTML = '<span class="pill-ico">📍</span> Set My Stop Location';
    showToast('❌ GPS: ' + err);
  });
}

function renderStopCoord() {
  if (!S.stopLoc) return;
  q('#stop-coord-text').textContent = `Stop: ${S.stopLoc.lat.toFixed(5)}, ${S.stopLoc.lon.toFixed(5)}`;
  q('#stop-coord-tag').classList.remove('hidden');
}

// ─── SLEEP MODE ──────────────────────────────────────────────────
function setHomeFromGPS() {
  const btn = q('#btn-set-home');
  btn.disabled = true; btn.innerHTML = '⏳ Getting GPS...';
  getPos(pos => {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;
    S.home = { lat, lon };
    lsSave('ba_home', { lat, lon });
    renderHomeCoord();
    btn.disabled = false; btn.innerHTML = '<span class="pill-ico">📍</span> Set My Home Location';
    showToast(`✅ Home saved (±${Math.round(accuracy)}m)`);
  }, err => {
    btn.disabled = false; btn.innerHTML = '<span class="pill-ico">📍</span> Set My Home Location';
    showToast('❌ GPS: ' + err);
  });
}

function renderHomeCoord() {
  if (!S.home) return;
  q('#home-coord-text').textContent = `Home: ${S.home.lat.toFixed(5)}, ${S.home.lon.toFixed(5)}`;
  q('#home-coord-tag').classList.remove('hidden');
}

function toggleSleepMode() { S.sleepOn ? stopSleep() : startSleep(); }

function startSleep() {
  if (!S.home) { showToast('⚠️ Set home location first!'); return; }
  S.sleepOn = true; S.sleptAlert = false;
  q('#btn-sleep').classList.add('stop-mode');
  q('#sleep-btn-label').innerHTML = '⏹ &nbsp;Stop Sleep Mode';
  q('#sleep-meter').classList.remove('hidden');
  q('#sleep-alert').classList.add('hidden');
  setStatus('Sleep Mode ON', true);
  reqWakeLock();
  showToast('😴 Sleep Mode ON — sweet dreams!');
  S.sleepWid = watchPos(onSleepPos, err => showToast('GPS: ' + err));
}

function stopSleep() {
  S.sleepOn = false;
  if (S.sleepWid) { navigator.geolocation.clearWatch(S.sleepWid); S.sleepWid = null; }
  releaseWakeLock();
  q('#btn-sleep').classList.remove('stop-mode');
  q('#sleep-btn-label').innerHTML = '😴 &nbsp;Start Sleep Mode';
  q('#sleep-meter').classList.add('hidden');
  q('#sleep-alert').classList.add('hidden');
  setStatus('Idle', false);
  showToast('⏹ Sleep Mode stopped.');
}

function onSleepPos(pos) {
  const { latitude: lat, longitude: lon } = pos.coords;
  const radius = parseFloat(q('#sleep-radius').value);
  const dist = getDistance(lat, lon, S.home.lat, S.home.lon);
  q('#sleep-dist-val').textContent = dist < 10 ? dist.toFixed(2) : Math.round(dist);
  const pct = Math.max(5, Math.min(100, (1 - dist / Math.max(dist * 2, radius * 6)) * 100));
  q('#sleep-dist-bar').style.width = pct + '%';
  q('#sleep-dist-hint').textContent = dist <= radius
    ? '🔴 YOU ARE IN THE ALERT ZONE!'
    : `🟢 ${(dist - radius).toFixed(2)} km until ${radius}km alert zone`;
  if (dist <= radius && !S.sleptAlert) triggerSleepAlert();
}

function triggerSleepAlert() {
  S.sleptAlert = true;
  q('#sleep-alert').classList.remove('hidden');
  if (q('#sleep-vibe').checked) doVibrate();
  if (q('#sleep-sound').checked) doSound();
  sendNotif('🔔 Wake Up!', 'You are near your home stop — get off the bus!');
}

// ─── DRIVER MODE ─────────────────────────────────────────────────
function toggleDriver() { S.driverOn ? stopDriver() : startDriver(); }

function startDriver() {
  const num = q('#driver-bus-num').value.trim();
  const route = q('#driver-route').value.trim();
  const stops = q('#driver-stops').value.trim().split(',').map(s => s.trim()).filter(Boolean);
  if (!num || !route) { showToast('⚠️ Enter bus number and route!'); return; }
  if (!S.fbOk) { openModal(); return; }

  // Save profile if checked
  if (q('#driver-save-check').checked) {
    saveBusProfile(num, route, stops);
  }

  S.driverBusId = 'bus_' + num.replace(/\s+/g, '_').toUpperCase() + '_' + Date.now();

  S.driverUpdates = 0;

  S.db.ref(`buses/${S.driverBusId}`).set({ busNumber: num, route, stops, active: true, location: null, startedAt: Date.now() })
    .then(() => {
      S.driverOn = true;
      q('#driver-form').classList.add('hidden');
      q('#driver-live-card').classList.remove('hidden');
      q('#dlc-busnum').textContent = 'Bus ' + num;
      q('#dlc-route').textContent = route;
      q('#btn-driver').classList.add('stop-mode');
      q('#driver-btn-label').innerHTML = '🔴 &nbsp;Stop Sharing';
      setStatus('Driver Live 🟢', true);
      showToast(`🟢 LIVE: Bus ${num}`);
      S.driverWid = watchPos(onDriverPos, err => showToast('GPS: ' + err));
    }).catch(e => showToast('❌ Firebase: ' + e.message));
}

function stopDriver() {
  S.driverOn = false;
  if (S.driverWid) { navigator.geolocation.clearWatch(S.driverWid); S.driverWid = null; }
  if (S.db && S.driverBusId) S.db.ref(`buses/${S.driverBusId}`).update({ active: false, endedAt: Date.now() });
  q('#driver-form').classList.remove('hidden');
  q('#driver-live-card').classList.add('hidden');
  q('#btn-driver').classList.remove('stop-mode');
  q('#driver-btn-label').innerHTML = '🟢 &nbsp;Go Live — Share Location';
  setStatus('Idle', false);
  showToast('⏹ Location sharing stopped.');
}

let _lastMoved, _lastLat, _lastLon;
function onDriverPos(pos) {
  if (!S.driverOn) return;
  const { latitude: lat, longitude: lon, accuracy } = pos.coords;
  const now = Date.now();

  // Auto-Stop check (Parked for > 20 mins)
  const moved = getDistance(lat, lon, _lastLat || lat, _lastLon || lon) > 0.05; // 50m
  if (moved || !_lastMoved) {
    _lastMoved = now; _lastLat = lat; _lastLon = lon;
  } else if (now - _lastMoved > 20 * 60 * 1000) {
    showToast('⏹ Auto-stop: Bus stationary for 20m.');
    stopDriver(); return;
  }

  S.driverUpdates++;
  q('#dlc-updates').textContent = S.driverUpdates;
  q('#dlc-accuracy').textContent = Math.round(accuracy);
  q('#dlc-time').textContent = new Date().toLocaleTimeString();
  q('#dlc-coords').textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
  S.db.ref(`buses/${S.driverBusId}/location`).set({ lat, lon, accuracy, timestamp: now });
}

// ─── GEO HELPERS ─────────────────────────────────────────────────
function getPos(ok, fail) {
  if (!navigator.geolocation) { fail('Geolocation not supported'); return; }
  navigator.geolocation.getCurrentPosition(ok, e => fail(e.message), { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 });
}
function watchPos(ok, fail) {
  if (!navigator.geolocation) return null;
  return navigator.geolocation.watchPosition(ok, e => fail(e.message), { enableHighAccuracy: true, timeout: 30000, maximumAge: 3000 });
}
function getDistance(la1, lo1, la2, lo2) {
  const R = 6371, dL = toR(la2 - la1), dO = toR(lo2 - lo1);
  const a = Math.sin(dL / 2) ** 2 + Math.cos(toR(la1)) * Math.cos(toR(la2)) * Math.sin(dO / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function toR(d) { return d * Math.PI / 180; }

// ─── ALERT HELPERS ───────────────────────────────────────────────
function doVibrate() { navigator.vibrate?.([600, 150, 600, 150, 600, 200, 1000]); }
function doSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [[880, 0, .3], [1108, .35, .3], [1320, .7, .55], [880, 1.3, .3], [1320, 2, .7]].forEach(([f, t, d]) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(.5, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(.001, ctx.currentTime + t + d);
      o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + d);
    });
  } catch (e) { }
}
function sendNotif(title, body) {
  if (Notification?.permission === 'granted') {
    try { new Notification(title, { body, requireInteraction: true }); } catch (e) { }
  }
}
function reqNotifPerm() {
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
}

// ─── WAKE LOCK ───────────────────────────────────────────────────
let _wl = null;
async function reqWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { _wl = await navigator.wakeLock.request('screen'); } catch (e) { }
}
function releaseWakeLock() { _wl?.release(); _wl = null; }

// ─── UI UTILS ────────────────────────────────────────────────────
function q(sel) { return document.querySelector(sel); }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function timeAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  return Math.floor(s / 3600) + 'h ago';
}

function updateRadius(type) {
  const v = q(`#${type}-radius`).value;
  q(`#${type}-radius-val`).textContent = parseFloat(v).toFixed(1) + ' km';
  lsSet(type === 'sleep' ? 'ba_sr' : 'ba_tr', v);
  // Update stop circle if shown
  if (type === 'track' && S.stopCircle) S.stopCircle.setRadius(parseFloat(v) * 1000);
}

function setStatus(txt, on) {
  q('#status-label').textContent = txt;
  q('#status-pip').className = 'status-pip' + (on ? ' on' : '');
}

let _tt;
function showToast(msg) {
  const el = q('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.classList.add('show');
  clearTimeout(_tt);
  _tt = setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.classList.add('hidden'), 400); }, 3500);
}

// ─── SAVED BUS PROFILES logic ──────────────────────────────────────
function saveBusProfile(num, route, stops) {
  const exists = S.savedBuses.findIndex(b => b.num === num && b.route === route);
  const profile = { num, route, stops };
  if (exists > -1) S.savedBuses[exists] = profile;
  else S.savedBuses.unshift(profile);
  if (S.savedBuses.length > 5) S.savedBuses.pop();
  lsSave('ba_saved_buses', S.savedBuses);
  renderSavedBuses();
}

function renderSavedBuses() {
  const list = q('#saved-buses-list');
  const section = q('#saved-buses-section');
  if (!S.savedBuses.length) { section?.classList.add('hidden'); return; }
  section?.classList.remove('hidden');
  list.innerHTML = S.savedBuses.map((b, i) => `
    <div class="saved-pill" onclick="useSavedBus(${i})">
      🚌 ${esc(b.num)}
      <span class="del-saved" onclick="event.stopPropagation();deleteSavedBus(${i})">✕</span>
    </div>
  `).join('');
}

function useSavedBus(idx) {
  const b = S.savedBuses[idx];
  if (!b) return;
  q('#driver-bus-num').value = b.num;
  q('#driver-route').value = b.route;
  q('#driver-stops').value = b.stops.join(', ');
  showToast(`📝 Loaded: Bus ${b.num}`);
}

function deleteSavedBus(idx) {
  S.savedBuses.splice(idx, 1);
  lsSave('ba_saved_buses', S.savedBuses);
  renderSavedBuses();
}

// ─── SERVICE WORKER + PWA INSTALL ────────────────────────────────

let _installPrompt = null;

// Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js')
      .then(reg => console.log('✅ SW registered', reg.scope))
      .catch(err => console.log('SW error:', err));
  });
}

// Catch the install prompt (Android Chrome)
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  _installPrompt = e;
  // Show the install banner after 3 seconds
  setTimeout(() => {
    const banner = q('#install-banner');
    if (banner) banner.classList.remove('hidden');
  }, 3000);
});

// User tapped "Install App"
function doInstall() {
  if (_installPrompt) {
    _installPrompt.prompt();
    _installPrompt.userChoice.then(result => {
      if (result.outcome === 'accepted') {
        showToast('🎉 BusAlert installed!');
      }
      _installPrompt = null;
      dismissInstall();
    });
  } else {
    // iOS fallback — show manual instructions
    showToast('On iPhone: tap Share → "Add to Home Screen"');
    dismissInstall();
  }
}

function dismissInstall() {
  const banner = q('#install-banner');
  if (banner) banner.classList.add('hidden');
}

// Hide banner if already installed
window.addEventListener('appinstalled', () => {
  dismissInstall();
  showToast('✅ BusAlert is installed as an app!');
});
