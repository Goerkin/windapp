/* Service Worker des Wind Cockpits.
 *
 * Zweck: am Strand mit schlechtem Netz trotzdem den letzten Datenstand zeigen.
 *  - Seiten + /api/*: erst Netz, bei Ausfall der zuletzt gespeicherte Stand. Kommt das Netz
 *    nicht binnen NET_TIMEOUT_MS, gibt es sofort den gespeicherten Stand; die Anfrage läuft
 *    weiter und legt ihre Antwort für das nächste Öffnen ab. Ohne diese Frist hinge die App
 *    bei schwachem Netz, bis der Browser aufgibt (oft 30 s und mehr). Das Dashboard
 *    zeigt dessen Alter ohnehin an (und färbt es ab 45 min gelb) — alte Daten sind also
 *    als solche erkennbar.
 *  - /_next/static/* + Icons: unveränderliche Dateien, direkt aus dem Cache.
 * Neue Version ausrollen: VERSION hochzählen, dann werden alte Caches verworfen. */
const VERSION = "v1";
const NET_TIMEOUT_MS = 3500;
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
  // Die Anfrage-Optionen (cache: "no-store") dürfen den Treffer nicht verhindern.
  const cached = async () =>
    (await cache.match(req, { ignoreVary: true })) ?? (req.mode === "navigate" ? await cache.match("/") : undefined);

  const net = fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  });
  // Spätes Netz-Ergebnis nicht als unbehandelten Fehler liegen lassen.
  net.catch(() => {});

  let timer;
  const slow = new Promise((resolve) => {
    timer = setTimeout(resolve, NET_TIMEOUT_MS);
  });
  try {
    const first = await Promise.race([net, slow]);
    if (first) return first;
    // Netz zu langsam: gespeicherten Stand zeigen, falls es einen gibt — sonst weiter warten.
    return (await cached()) ?? (await net);
  } catch (err) {
    const hit = await cached();
    if (hit) return hit;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
