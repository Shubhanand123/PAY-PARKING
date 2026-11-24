// PARKAR offline copy. The app opens straight from the copy saved on this POS (fast, and works with no internet);
// a newer version is fetched quietly in the background and is used from the next open.
// Only the app's own files are kept here. Tickets and payments always go to the server.
const CACHE = 'parkar-app-v2'
const SHELL = './'

self.addEventListener('install', event => {
  event.waitUntil(refreshShell().catch(() => {}).then(() => self.skipWaiting()))
})
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()) })

/** Fetch the latest page and every file it needs; switch to it only when all of them are saved. */
async function refreshShell() {
  const response = await fetch(SHELL, { cache: 'no-store' })
  if (!response.ok) return
  const html = await response.clone().text()
  const files = [...html.matchAll(/(?:src|href)="(\.?\/?assets\/[^"]+)"/g)].map(m => new URL(m[1], self.registration.scope).href)
  const cache = await caches.open(CACHE)
  await Promise.all(files.map(async url => { if (!(await cache.match(url, { ignoreVary: true }))) await cache.add(url) }))
  await cache.put(SHELL, response)
}

self.addEventListener('fetch', event => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return // server, Razorpay, fonts: never cached here
  if (url.pathname.endsWith('/app-version.json') || url.pathname.endsWith('/sw.js')) return // always fresh

  if (request.mode === 'navigate') {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE)
      const saved = await cache.match(SHELL)
      const update = refreshShell().catch(() => {})
      if (saved) { event.waitUntil(update); return saved }
      await update
      return (await cache.match(SHELL)) ?? fetch(request)
    })())
    return
  }

  // Files with a fixed name (scripts, styles, logo, plate-reading model): saved copy first.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE)
    const saved = await cache.match(request, { ignoreVary: true, ignoreSearch: false })
    if (saved) return saved
    const response = await fetch(request)
    if (response.ok) cache.put(request, response.clone())
    return response
  })())
})
