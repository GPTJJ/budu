const CACHE_NAME = 'budu-shell-v19'
const APP_SHELL = [
  '/',
  '/manifest.webmanifest',
  '/favicon-capybara.png',
  '/apple-touch-icon.png',
  '/app-icon-capybara-192.png',
  '/app-icon-capybara-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    // 网络优先：部署新版本后打开即用新版；离线时回退本地壳。
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put('/', copy))
          }
          return response
        })
        .catch(() => caches.match('/')),
    )
    return
  }

  // 只缓存真正的静态资源。SPA 回退会用 200 + text/html 掩盖 404，
  // 若把它当资源缓存下来，图片/脚本一旦曾经缺失就会永久坏掉。
  const cacheable = (response) => {
    if (!response.ok) return false
    if ((response.headers.get('content-type') || '').includes('text/html')) return false
    return url.pathname.startsWith('/assets/') || url.pathname.startsWith('/mp-images/') || /\.(?:png|jpe?g|webp|svg|ico|css|js|woff2?)$/i.test(url.pathname)
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (cacheable(response)) {
            const copy = response.clone()
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
          }
          return response
        }),
    ),
  )
})
