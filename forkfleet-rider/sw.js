/**
 * ForkFleet Rider — Service Worker
 * Handles: offline caching, push notifications, background sync
 */

const CACHE_NAME    = 'forkfleet-rider-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Sans:wght@300;400;500&family=DM+Mono:wght@400;500&display=swap',
];

// ── Install: cache static assets ──────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Only cache same-origin assets — Google Fonts may fail in strict CSP
      return cache.addAll(STATIC_ASSETS.filter(u => u.startsWith('/')));
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: clean old caches ────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: network-first for API, cache-first for static ─────────────────────

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API requests — network only, no caching
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ success: false, message: 'Offline — no network' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // Static assets — cache first, network fallback
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Don't cache non-2xx or opaque responses
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const toCache = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, toCache));
        return response;
      });
    }).catch(() => caches.match('/index.html'))
  );
});

// ── Push Notifications ────────────────────────────────────────────────────────

self.addEventListener('push', (event) => {
  let data = { title: 'ForkFleet Rider', body: 'You have a new delivery request', orderId: null };
  try { data = event.data.json(); } catch {}

  const options = {
    body:    data.body,
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-72.png',
    vibrate: [200, 100, 200, 100, 200],
    tag:     data.orderId || 'forkfleet-rider',
    renotify: true,
    requireInteraction: true,   // keeps notification visible until user acts
    data:    { orderId: data.orderId, url: '/?tab=delivery' },
    actions: [
      { action: 'accept',  title: 'Accept', icon: '/icons/icon-96.png' },
      { action: 'decline', title: 'Decline' },
    ],
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Handle notification action clicks
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const action  = event.action;
  const orderId = event.notification.data?.orderId;

  if (action === 'accept') {
    // Post message to app to accept the job
    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
        if (clients.length) {
          clients[0].postMessage({ type: 'ACCEPT_JOB', orderId });
          clients[0].focus();
        } else {
          self.clients.openWindow(`/?action=accept&orderId=${orderId}`);
        }
      })
    );
  } else {
    // Open the app
    event.waitUntil(
      self.clients.matchAll({ type: 'window' }).then(clients => {
        if (clients.length) clients[0].focus();
        else self.clients.openWindow('/');
      })
    );
  }
});

// ── Background Sync — queue location updates when offline ─────────────────────

const locationQueue = [];

self.addEventListener('sync', (event) => {
  if (event.tag === 'rider-location-sync') {
    event.waitUntil(flushLocationQueue());
  }
});

async function flushLocationQueue() {
  const queue = [...locationQueue];
  locationQueue.length = 0;

  for (const loc of queue) {
    try {
      await fetch('/api/v1/riders/location', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(loc),
      });
    } catch {
      locationQueue.push(loc);  // re-queue on failure
    }
  }
}

// Receive location from main thread when offline
self.addEventListener('message', (event) => {
  if (event.data?.type === 'QUEUE_LOCATION') {
    locationQueue.push(event.data.payload);
  }
});
