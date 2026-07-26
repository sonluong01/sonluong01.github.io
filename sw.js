/* Tủ sách — offline app-shell cache */
const CACHE = 'reader-v12';
// Vỏ app + catalog. Chương sách (books/<dir>/*.html?v=rev) được cache lazily khi
// tải lần đầu (xem fetch handler); rev mới = URL mới nên không cần bump CACHE.
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.json',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png', 'icons/maskable-512.png',
  'books/library.json'
];

// cache each asset on its own: one 404 must not abort the whole install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(a => c.add(a))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const save = (req, res) => {
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
  }
  return res;
};

// cache-first, fall back to network, then update the cache
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;                // leave cross-origin alone

  // catalog: network-first, nếu không sách mới thêm trên server sẽ không bao giờ hiện
  if (url.pathname.endsWith('/library.json')) {
    e.respondWith(fetch(req).then(res => save(req, res)).catch(() => caches.match(req)));
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => save(req, res)).catch(() =>
      // offline and not cached — serve the shell for navigations, else fail cleanly
      req.mode === 'navigate' ? caches.match('index.html') : Response.error()
    ))
  );
});
