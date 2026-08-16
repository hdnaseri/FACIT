
const CACHE_NAME = 'facit-cache-v14.2.1';
const DEBUG = false;
const URLS_TO_CACHE = [
  '/',
  'index.html',
  'manifest.json',
  'tailwind.css',
  'api-utils.js',
  'vendor/fontawesome/css/all.min.css',
  'vendor/fontawesome/webfonts/fa-brands-400.woff2',
  'vendor/fontawesome/webfonts/fa-regular-400.woff2',
  'vendor/fontawesome/webfonts/fa-solid-900.woff2',
  'vendor/fontawesome/webfonts/fa-brands-400.woff',
  'vendor/fontawesome/webfonts/fa-regular-400.woff',
  'vendor/fontawesome/webfonts/fa-solid-900.woff',
  'vendor/fontawesome/webfonts/fa-brands-400.ttf',
  'vendor/fontawesome/webfonts/fa-regular-400.ttf',
  'vendor/fontawesome/webfonts/fa-solid-900.ttf',
  'vendor/chartjs/chart.umd.min.js',
  'icons/FACIT.png',
  'icons/icon-192x192.png',
  'icons/icon-512x512.png'
];

// Install a service worker
self.addEventListener('install', event => {
  if (DEBUG) console.log('🔧 Service Worker installing, cache:', CACHE_NAME);
  
  // Perform install steps
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        if (DEBUG) console.log('📦 Opened cache:', CACHE_NAME);
        return Promise.all(URLS_TO_CACHE.map(u => cache.add(u).catch(() => {})));
      })
  );
  // Force the waiting service worker to become the active service worker immediately
  self.skipWaiting();
});

// Cache and return requests
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = req.url;
  if (req.method !== 'GET') {
    event.respondWith(fetch(req));
    return;
  }
  const pathName = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  })();
  const isSameOrigin = (() => {
    try {
      return new URL(url).origin === self.location.origin;
    } catch {
      return false;
    }
  })();

  if (!isSameOrigin) return;

  // Never cache version.json or sw.js; they control update logic.
  if (isSameOrigin && (pathName === '/version.json' || pathName === '/sw.js')) {
    event.respondWith(fetch(req));
    return;
  }

  // Never cache Firebase/Google API calls (auth tokens, firestore, etc.)
  if (
    url.includes('firestore.googleapis.com') ||
    url.includes('identitytoolkit.googleapis.com') ||
    url.includes('securetoken.googleapis.com') ||
    url.includes('firebaseinstallations.googleapis.com') ||
    url.includes('/__/')
  ) {
    event.respondWith(fetch(req));
    return;
  }

  // Always fetch FontAwesome fresh to avoid icon loading issues
  if (url.includes('font-awesome')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cached = await cache.match(req);

      const fetchPromise = fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque') && req.method === 'GET') {
          cache.put(req, res.clone());
        }
        return res;
      });

      if (cached) {
        event.waitUntil(fetchPromise.catch(() => {}));
        return cached;
      }

      return fetchPromise;
    })());
    return;
  }

  // Network-first for navigations/HTML to ensure UI updates
  const accept = req.headers.get('accept') || '';
  if (req.mode === 'navigate' || accept.includes('text/html')) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          cache.put('index.html', res.clone());
        }
        return res;
      } catch (e) {
        const cached = (await cache.match('index.html')) || (await cache.match('/'));
        if (cached) return cached;
        throw e;
      }
    })());
    return;
  }

  // Cache-first for other requests (static assets, APIs fallback)
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = isSameOrigin
      ? await cache.match(req, { ignoreSearch: true })
      : await cache.match(req);

    const fetchPromise = fetch(req).then(res => {
      if (res && (res.ok || res.type === 'opaque') && req.method === 'GET') {
        let cacheKey = req;
        if (isSameOrigin) {
          try {
            const u = new URL(req.url);
            cacheKey = new Request(u.origin + u.pathname, { method: 'GET' });
          } catch {
          }
        }
        cache.put(cacheKey, res.clone());
      }
      return res;
    });

    if (cached) {
      event.waitUntil(fetchPromise.catch(() => {}));
      return cached;
    }

    return fetchPromise;
  })());
});

// Update a service worker - حذف تمام کش‌های قدیمی
self.addEventListener('activate', event => {
  if (DEBUG) console.log('🚀 Service Worker activating, current cache:', CACHE_NAME);
  
  event.waitUntil(
    caches.keys().then(cacheNames => {
      if (DEBUG) console.log('📋 Found caches:', cacheNames);
      
      return Promise.all(
        cacheNames.map(cacheName => {
          // حذف هر کشی که نام آن با CACHE_NAME فعلی متفاوت است
          if (cacheName !== CACHE_NAME) {
            if (DEBUG) console.log('🗑️ Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
          if (DEBUG) console.log('✅ Keeping current cache:', CACHE_NAME);
        })
      );
    }).then(() => {
      if (DEBUG) console.log('✅ All old caches deleted, claiming clients');
      // Take control of all pages immediately
      return self.clients.claim();
    })
  );
});

// Listen for skip waiting message from the page
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    if (DEBUG) console.log('⏭️ Skip waiting message received');
    self.skipWaiting();
  }
});

