// Service worker del portal (/login). Solo guarda la "cáscara" de la página para que abra rápido
// y sin internet muestre el aviso de conexión. NUNCA guarda /api/*: saldos, cobros y pagos
// siempre se piden en vivo al servidor.
const CACHE = "cuadra-portal-v12";
// v12: entrada en dos paneles en laptop, sin textos de demo.
// v11: el botón de aprobación dice solo "Aprobar".
// v10: el encabezado dice solo "Cuadra" (sin el nombre de la tienda).
// v9: slogan nuevo en la bienvenida.
// v8: botón de letra grande solo con ícono; "Salir de mi cuenta" lleva a la bienvenida.
// v7: sin la leyenda de proyecto independiente en la entrada.
// v6: la bienvenida no repite el logo en el encabezado.
// v5: contorno blanco más marcado en el logo.
// v4: logo nuevo (libreta con broche) e íconos.
// v3: aviso de conexión compartido (/assets/red.js).
// v2: diseño nuevo. La hoja de estilos, las tipografías y los íconos también van en la cáscara.
const SHELL = [
  "/login", "/logo.svg", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png",
  "/assets/cuadra.css", "/assets/icons.svg", "/assets/red.js",
  "/assets/fonts/montserrat-latin-wght-normal.woff2", "/assets/fonts/noto-sans-latin-wght-normal.woff2",
];

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
