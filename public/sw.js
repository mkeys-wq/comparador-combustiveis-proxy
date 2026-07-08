// CARGA+ — service worker mínimo, só para tornar a app instalável.
// Não faz cache agressivo (os dados dos postos têm de vir sempre em direto).

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  self.clients.claim();
});

// Passthrough simples — deixa tudo ir direto à rede.
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
});
