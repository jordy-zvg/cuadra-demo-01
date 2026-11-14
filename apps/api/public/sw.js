// Service worker del portal (/login). Solo guarda la "cáscara" de la página para que abra rápido
// y sin internet muestre el aviso de conexión. NUNCA guarda /api/*: saldos, cobros y pagos
// siempre se piden en vivo al servidor.
const CACHE = "cuadra-portal-v2";
const SHELL = ["/login", "/logo.svg", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const isPortal = url.pathname === "/login" || url.pathname === "/portal";
  if (!isPortal && !SHELL.includes(url.pathname) && !url.pathname.startsWith("/icons/")) return; // lo demás, directo a la red

  // Red primero (así siempre llega la versión nueva); si no hay internet, lo guardado.
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(isPortal ? "/login" : req, copy));
        }
        return res;
      })
      .catch(() => caches.match(isPortal ? "/login" : req).then((r) => r || Response.error())),
  );
});
