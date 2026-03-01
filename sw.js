/* =============================================
   BusAlert — Service Worker
   Enables: App install + Offline support
   ============================================= */

const CACHE = 'busAlert-v3';
const FILES = [
    '/',
    '/index.html',
    '/style.css',
    '/app.js',
    '/manifest.json',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
    'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// Install — cache all core files
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(cache => cache.addAll(FILES)).then(() => self.skipWaiting())
    );
});

// Activate — clean old caches
self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// Fetch — serve from cache, fallback to network
self.addEventListener('fetch', e => {
    // Skip non-GET and Firebase/map tile requests (always need fresh data)
    if (e.request.method !== 'GET') return;
    const url = e.request.url;
    if (url.includes('firebaseio.com') || url.includes('tile.openstreetmap')) return;

    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
            // Cache new responses for app files
            if (res.ok && (url.includes(self.location.origin) || url.includes('fonts.googleapis') || url.includes('unpkg.com'))) {
                const clone = res.clone();
                caches.open(CACHE).then(c => c.put(e.request, clone));
            }
            return res;
        })).catch(() => {
            // Offline fallback — return index.html for navigation requests
            if (e.request.mode === 'navigate') return caches.match('/index.html');
        })
    );
});

// Periodic Sync / Background Keep-Alive
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'bus-location-push') {
        // Keeps background worker from going completely dormant
    }
});
