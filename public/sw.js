// CARGA+ — service worker mínimo, só para tornar a app instalável.
// v2: NUNCA guarda nada em cache — vai sempre buscar tudo à rede, para
// garantir que vês sempre a versão mais recente da app, e apaga qualquer
// cache antiga que tenha ficado de versões anteriores.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.map((n) => caches.delete(n))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
