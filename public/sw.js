/* Service Worker des Wind Cockpits.
 *
 * Zweck: am Strand mit schlechtem Netz trotzdem den letzten Datenstand zeigen.
 *  - Seiten + /api/*: erst Netz, bei Ausfall der zuletzt gespeicherte Stand. Das Dashboard
 *    zeigt dessen Alter ohnehin an (und färbt es ab 45 min gelb) — alte Daten sind also
 *    als solche erkennbar.
 *  - /_next/static/* + Icons: unveränderliche Dateien, direkt aus dem Cache.
 * Neue Version ausrollen: VERSION hochzählen, dann werden alte Caches verworfen. */
const VERSION = "v1";
const PAGES = `pages-${VERSION}`;
const ASSETS = `assets-${VERSION}`;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(PAGES).then((c) => c.add("/")).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== PAGES && k !== ASSETS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/_next/static/") || /^\/(icon-|apple-touch-icon)/.test(url.pathname)) {
    event.respondWith(cacheFirst(req));
  } else if (req.mode === "navigate" || url.pathname.startsWith("/api/")) {
    event.respondWith(networkFirst(req));
  }
});

async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(ASSETS)).put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(PAGES);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    // Die Anfrage-Optionen (cache: "no-store") dürfen den Treffer nicht verhindern.
    const hit = (await cache.match(req, { ignoreVary: true })) ?? (req.mode === "navigate" && (await cache.match("/")));
    if (hit) return hit;
    throw err;
  }
}
