import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { FastifyInstance } from 'fastify'
import type { AppConfig, AppPaths } from '../src/config.js'
import { SESSION_COOKIE } from '../src/auth.js'
import { openDatabase } from '../src/db.js'
import { buildApp } from '../src/app.js'

let workDir = ''
let app: FastifyInstance
let db: ReturnType<typeof openDatabase>
let bridge: Server
let streamRes: ServerResponse | null = null
let token = ''
const sent: string[] = []
const sentBodies: Array<Record<string, unknown>> = []

const config: AppConfig = {
  server: { host: '127.0.0.1', port: 0, publicUrl: '' },
  password: 'correct horse',
  peer: { name: '蓝色大肥鱼', avatar: '/peer.png' },
  dataDir: 'unused',
  session: { days: 30 },
  sticker: { maxBytes: 5 * 1024 * 1024, maxCount: 100 },
  attachment: { imageMaxBytes: 5 * 1024 * 1024, videoMaxBytes: 5 * 1024 * 1024, fileMaxBytes: 5 * 1024 * 1024 },
  media: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
  asr: { enabled: false, threads: 4, python: '', modelDir: '', timeoutMs: 120000 },
  dsh: { enabled: true, baseUrl: 'http://127.0.0.1:0', token: 'test-token', session: 'test-session', historyLimit: 10, mergeWindowMs: 50 },
  mock: { enabled: true, mergeWindowMs: 10, typingMs: 10, gapMs: 10 },
}

const auth = () => ({ cookie: `${SESSION_COOKIE}=${token}` })

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 4000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > deadline) throw new Error('等超时了')
    await sleep(80)
  }
}

async function list(): Promise<Array<{ sender: string; text: string | null; source: string }>> {
  const res = await app.inject({ method: 'GET', url: '/api/messages?limit=100', headers: auth() })
  return res.json().items
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'openchat-dsh-'))
  const paths: AppPaths = {
    root: workDir,
    configFile: join(workDir, 'config.json'),
    dataDir: workDir,
    dbFile: join(workDir, 'openchat.db'),
    stickersDir: join(workDir, 'stickers'),
    thumbsDir: join(workDir, 'thumbs'),
    filesDir: join(workDir, 'files'),
    fileThumbsDir: join(workDir, 'file-thumbs'),
    tmpDir: join(workDir, 'tmp'),
    asrDir: join(workDir, 'asr'),
    asrPython: join(workDir, 'python.exe'),
    asrModelDir: join(workDir, 'model'),
    asrScript: join(workDir, 'asr_cli.js'),
    webDist: join(workDir, 'no-web'),
  }

  bridge = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    if (url.pathname === '/history') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          items: [
            { id: 'd1', role: 'me', text: '以前问的一句', at: 1700000000000 },
            { id: 'd2', role: 'fish', text: '以前答的一句', at: 1700000001000 },
          ],
        }),
      )
      return
    }
    if (url.pathname === '/send' && req.method === 'POST') {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        let parsed: Record<string, unknown> = {}
        try {
          parsed = JSON.parse(body)
        } catch {
          parsed = {}
        }
        sent.push(String(parsed.text || ''))
        sentBodies.push(parsed)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }
    if (url.pathname === '/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('retry: 1000\n\n')
      res.write('event: hello\ndata: {"session":"test-session"}\n\n')
      streamRes = res
      return
    }
    res.writeHead(404)
    res.end()
  })

  await new Promise<void>((resolve) => bridge.listen(0, '127.0.0.1', resolve))
  const address = bridge.address()
  if (!address || typeof address === 'string') throw new Error('桥没拿到端口')
  config.dsh.baseUrl = `http://127.0.0.1:${address.port}`

  db = openDatabase(paths)
  app = buildApp({ config, paths, db })

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-forwarded-for': '10.7.7.7' },
    payload: { password: 'correct horse' },
  })
  const setCookie = res.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  token = String(raw).split(';')[0]?.split('=')[1] ?? ''
})

after(async () => {
  await app.close()
  db.close()
  await new Promise<void>((resolve) => bridge.close(() => resolve()))
  rmSync(workDir, { recursive: true, force: true })
})

test('启动时把 DSH 历史导进来（按 id 去重）', async () => {
  const items = await waitFor(async () => {
    const rows = await list()
    return rows.length >= 2 ? rows : null
  })
  assert.equal(items.length, 2)
  assert.equal(items[0]!.text, '以前问的一句')
  assert.equal(items[0]!.sender, 'me')
  assert.equal(items[1]!.text, '以前答的一句')
  assert.equal(items[1]!.sender, 'fish')
  assert.equal(items[0]!.source, 'import')
})

test('2 秒窗口合并后只发一次给 DSH', async () => {
  await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(),
    payload: { clientId: 'w1', kind: 'text', text: '第一句' },
  })
  await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(),
    payload: { clientId: 'w2', kind: 'text', text: '第二句' },
  })

  await waitFor(async () => (sent.length >= 1 ? true : null), 3000)
  assert.equal(sent.length, 1)
  assert.match(sent[0]!, /第一句/)
  assert.match(sent[0]!, /第二句/)
})

test('DSH 的回话会以 fish 身份出现，重复事件不重复写', async () => {
  await waitFor(async () => (streamRes ? true : null), 3000)

  const event = 'event: assistant\ndata: {"id":"a1","text":"收到啦","at":1700000010000}\n\n'
  streamRes!.write(event)
  streamRes!.write(event)

  const items = await waitFor(async () => {
    const rows = await list()
    return rows.some((row) => row.text === '收到啦') ? rows : null
  }, 4000)

  const hits = items.filter((row) => row.text === '收到啦')
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.sender, 'fish')
  assert.equal(hits[0]!.source, 'dsh')
})

test('开着 DSH 时假鱼不再插话', async () => {
  await sleep(400)
  const items = await list()
  assert.equal(items.some((row) => row.text && row.text.includes('占位回答')), false)
})

function multipart(file: Buffer, filename: string, type: string) {
  const boundary = '----openchat-dsh-boundary'
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${type}\r\n\r\n`,
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    payload: Buffer.concat([head, file, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  }
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('图片消息会带着 base64 送进 DSH', async () => {
  const form = multipart(PNG_1X1, 'dot.png', 'image/png')
  const uploaded = await app.inject({
    method: 'POST',
    url: '/api/attachments',
    headers: { ...form.headers, ...auth() },
    payload: form.payload,
  })
  assert.equal(uploaded.statusCode, 200, uploaded.body)
  const attachmentId = uploaded.json().attachment.id

  const posted = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(),
    payload: { clientId: 'img-1', kind: 'image', attachmentId },
  })
  assert.equal(posted.statusCode, 200, posted.body)

  const body = await waitFor(async () => {
    const hit = sentBodies.find((entry) => Array.isArray(entry.images) && entry.images.length > 0)
    return hit || null
  }, 4000)
  const images = body.images as Array<{ data?: string; mediaType?: string }>
  assert.equal(images.length, 1)
  assert.ok((images[0]!.data || '').length > 10)
})

test('文件消息会把本地路径告诉 DSH', async () => {
  const form = multipart(Buffer.from('hello file'), 'notes.txt', 'text/plain')
  const uploaded = await app.inject({
    method: 'POST',
    url: '/api/attachments',
    headers: { ...form.headers, ...auth() },
    payload: form.payload,
  })
  const attachmentId = uploaded.json().attachment.id

  const posted = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(),
    payload: { clientId: 'file-1', kind: 'file', attachmentId },
  })
  assert.equal(posted.statusCode, 200, posted.body)

  const body = await waitFor(async () => {
    const hit = sentBodies.find((entry) => Array.isArray(entry.files) && entry.files.length > 0)
    return hit || null
  }, 4000)
  const files = body.files as Array<{ path?: string }>
  assert.match(String(files[0]!.path || ''), /\.txt$/)
})
