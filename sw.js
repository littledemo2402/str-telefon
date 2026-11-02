// STR Rapoarte pe telefon: aplicația (paginile ei) se ține pe telefon, ca să pornească și fără semnal.
// Fișele nu trec pe aici (stau în IndexedDB); GitHub și cheie.json se cer mereu din rețea.
const VERSIUNE = 'str-tel-2';
const APLICATIA = ['./', 'index.html', 'app.js', 'fisa.js', 'style.css', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSIUNE).then(c => c.addAll(APLICATIA)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== VERSIUNE).map(x => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.endsWith('cheie.json')) return;
  // întâi rețeaua (versiunea nouă a aplicației), altfel ce e pe telefon
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const c = r.clone(); caches.open(VERSIUNE).then(x => x.put(e.request, c)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});
