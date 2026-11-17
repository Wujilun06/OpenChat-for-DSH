import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { AppConfig, AppPaths } from '../src/config.js'
import { SESSION_COOKIE } from '../src/auth.js'
import { openDatabase } from '../src/db.js'
import { buildApp } from '../src/app.js'

let workDir = ''
let app: FastifyInstance
let db: ReturnType<typeof openDatabase>
let token = ''
let base = ''

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
  mock: { enabled: false, mergeWindowMs: 10, typingMs: 10, gapMs: 10 },
}

const auth = () => ({ cookie: `${SESSION_COOKIE}=${token}` })

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'openchat-calls-'))
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
    asrScript: join(workDir, 'asr_cli.py'),
    webDist: join(workDir, 'no-web'),
  }
  db = openDatabase(paths)
  app = buildApp({ config, paths, db })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('没拿到端口')
  base = `http://127.0.0.1:${address.port}`

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-forwarded-for': '10.6.6.6' },
    payload: { password: 'correct horse' },
  })
  const setCookie = res.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  token = String(raw).split(';')[0]?.split('=')[1] ?? ''
})

after(async () => {
  await app.close()
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

test('状态接口说清楚现在不支持', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/calls/status', headers: auth() })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().supported, false)
  assert.equal(res.json().active, null)
})

test('发语音通话：落一条占位记录，回 501', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/calls',
    headers: auth(),
    payload: { kind: 'audio' },
  })
  assert.equal(res.statusCode, 501)
  const body = res.json()
  assert.equal(body.ok, false)
  assert.equal(body.code, 'call_not_implemented')
  assert.equal(body.call.kind, 'audio')
  assert.equal(body.call.state, 'unsupported')
  assert.equal(body.call.direction, 'outgoing')

  const row = db.prepare('SELECT kind, state FROM calls WHERE id = ?').get(body.call.id) as {
    kind: string
    state: string
  }
  assert.equal(row.kind, 'audio')
  assert.equal(row.state, 'unsupported')
})

test('发视频通话也一样', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/calls',
    headers: auth(),
    payload: { kind: 'video' },
  })
  assert.equal(res.statusCode, 501)
  assert.equal(res.json().call.kind, 'video')
})

test('不认识的类型被拒', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/calls',
    headers: auth(),
    payload: { kind: 'facetime' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'bad_call_kind')
})

test('没登录不能拨', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/calls', payload: { kind: 'audio' } })
  assert.equal(res.statusCode, 401)
})

function readSse(res: Response) {
  const reader = res.body?.getReader()
  if (!reader) throw new Error('没有 body')
  const decoder = new TextDecoder()
  let buffer = ''
  return {
    async until(marker: string, timeoutMs = 3000): Promise<string> {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (buffer.includes(marker)) return buffer
        const race = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(0, deadline - Date.now()))),
        ])
        if (race === null || race.done) break
        buffer += decoder.decode(race.value, { stream: true })
      }
      if (!buffer.includes(marker)) throw new Error(`等不到 ${marker}，收到：${buffer.slice(0, 300)}`)
      return buffer
    },
    async cancel() {
      try {
        await reader.cancel()
      } catch {
        // 已经关了
      }
    },
  }
}

test('拨号会推一条 call.state 给所有在线设备', async () => {
  const controller = new AbortController()
  const res = await fetch(`${base}/api/stream?since=0`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
    signal: controller.signal,
  })
  assert.equal(res.status, 200)
  const sse = readSse(res)
  await sse.until('event: hello')

  const post = await app.inject({
    method: 'POST',
    url: '/api/calls',
    headers: auth(),
    payload: { kind: 'audio' },
  })
  assert.equal(post.statusCode, 501)

  const got = await sse.until('event: call.state')
  assert.match(got, /"state":"unsupported"/)
  await sse.cancel()
  controller.abort()
})
