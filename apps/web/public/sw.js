/* OpenChat 的 Service Worker：只缓存「壳」，不碰 /api。 */

const CACHE = 'openchat-shell-v2'
const SHELL = '/'
const ASSET_URL = /\/assets\/[^"']+/g

const STATIC_URLS = [
  '/manifest.webmanifest',
  '/icons/apple-touch-icon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

async function precache() {
  const cache = await caches.open(CACHE)
  let html = ''
  try {
    const res = await fetch(SHELL, { cache: 'no-cache' })
    if (res.ok) {
      html = await res.text()
      await cache.put(
        SHELL,
        new Response(html, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      )
    }
  } catch {
    // 离线安装就只能等下回了
  }

  const urls = new Set(STATIC_URLS)
  for (const match of html.matchAll(ASSET_URL)) urls.add(match[0])

  await Promise.all(
    [...urls].map(async (url) => {
      try {
        const res = await fetch(url, { cache: 'no-cache' })
        if (res.ok) await cache.put(url, res)
      } catch {
        // 少了就少了，不拦着装
      }
    }),
  )
}

self.addEventListener('install', (event) => {
  event.waitUntil(precache().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys()
      await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
      await self.clients.claim()
    })(),
  )
})

function isStatic(url) {
  return (
    url.pathname.startsWith('/assets/') ||
    url.pathname.startsWith('/icons/') ||
    url.pathname === '/manifest.webmanifest' ||
    url.pathname === '/peer.png'
  )
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  // 接口、SSE、视频分片一律不缓存
  if (url.pathname.startsWith('/api/')) return
  if (request.headers.has('range')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        const cached = await cache.match(SHELL)
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 3500)
        try {
          // 网络优先，但最多等 3.5 秒；超时先拿缓存的壳把界面画出来。
          // 超时要 abort 掉那个请求，不能让它挂在后台占连接。
          const fresh = await fetch(request, { signal: controller.signal })
          if (fresh && fresh.ok) {
            cache.put(SHELL, fresh.clone())
            return fresh
          }
          return cached || fresh
        } catch {
          return cached || Response.error()
        } finally {
          clearTimeout(timer)
        }
      })(),
    )
    return
  }

  if (isStatic(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE)
        const cached = await cache.match(request)
        if (cached) return cached
        try {
          const res = await fetch(request)
          if (res.ok) cache.put(request, res.clone())
          return res
        } catch {
          return cached || Response.error()
        }
      })(),
    )
  }
})
