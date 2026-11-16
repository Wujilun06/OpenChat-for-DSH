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
let base = ''
let token = ''

const config: AppConfig = {
  server: { host: '127.0.0.1', port: 0, publicUrl: '' },
  password: 'correct horse',
  peer: { name: '蓝色大肥鱼', avatar: '/peer.png' },
  dataDir: 'unused',
  session: { days: 30 },
  sticker: { maxBytes: 5 * 1024 * 1024, maxCount: 100 },
  mock: { enabled: false, mergeWindowMs: 10, typingMs: 10, gapMs: 10 },
}

function auth(tokenValue = token) {
  return { cookie: `${SESSION_COOKIE}=${tokenValue}` }
}

async function login(): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-forwarded-for': '10.1.1.1' },
    payload: { password: 'correct horse' },
  })
  assert.equal(res.statusCode, 200, res.body)
  const setCookie = res.headers['set-cookie']
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  const pair = String(raw).split(';')[0] ?? ''
  return pair.split('=')[1] ?? ''
}

async function send(payload: Record<string, unknown>, tokenValue = token) {
  return app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(tokenValue),
    payload,
  })
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'openchat-msg-'))
  const paths: AppPaths = {
    root: workDir,
    configFile: join(workDir, 'config.json'),
    dataDir: workDir,
    dbFile: join(workDir, 'openchat.db'),
    stickersDir: join(workDir, 'stickers'),
    thumbsDir: join(workDir, 'thumbs'),
    webDist: join(workDir, 'no-web'),
  }
  db = openDatabase(paths)
  app = buildApp({ config, paths, db })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address()
  if (!address || typeof address === 'string') throw new Error('没拿到端口')
  base = `http://127.0.0.1:${address.port}`
  token = await login()
})

after(async () => {
  await app.close()
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

test('没登录不能读也不能发', async () => {
  const read = await app.inject({ method: 'GET', url: '/api/messages' })
  assert.equal(read.statusCode, 401)
  const write = await app.inject({
    method: 'POST',
    url: '/api/messages',
    payload: { clientId: 'x', kind: 'text', text: 'hi' },
  })
  assert.equal(write.statusCode, 401)
})

test('发一条文字，seq 从 1 开始', async () => {
  const res = await send({ clientId: 'c-1', kind: 'text', text: '第一条' })
  assert.equal(res.statusCode, 200, res.body)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.created, true)
  assert.equal(body.message.sender, 'me')
  assert.equal(body.message.source, 'web')
  assert.equal(body.message.seq, 1)
  assert.equal(body.message.text, '第一条')
  assert.equal(body.message.replyTo, null)
})

test('同一个 clientId 重发不会变两条', async () => {
  const again = await send({ clientId: 'c-1', kind: 'text', text: '第一条' })
  assert.equal(again.statusCode, 200)
  const body = again.json()
  assert.equal(body.created, false)
  assert.equal(body.message.seq, 1)

  const rows = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
  assert.equal(Number(rows.n), 1)
})

test('空消息、太长、缺 clientId 都拒', async () => {
  const empty = await send({ clientId: 'c-empty', kind: 'text', text: '   ' })
  assert.equal(empty.statusCode, 400)
  assert.equal(empty.json().code, 'empty_message')

  const tooLong = await send({ clientId: 'c-long', kind: 'text', text: '字'.repeat(4001) })
  assert.equal(tooLong.statusCode, 400)
  assert.equal(tooLong.json().code, 'too_long')

  const noId = await send({ kind: 'text', text: 'hi' })
  assert.equal(noId.statusCode, 400)
  assert.equal(noId.json().code, 'client_id_required')
})

test('引用回复能带出被引用的那条', async () => {
  const res = await send({
    clientId: 'c-quote',
    kind: 'text',
    text: '这条是引用',
    replyTo: 'c-1',
  })
  // c-1 是 clientId，不是消息 id —— 引用要的是消息 id，所以应该被拒
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'bad_reply_to')

  const first = await app.inject({
    method: 'GET',
    url: '/api/messages',
    headers: auth(),
  })
  const firstId = first.json().items[0].id

  const quoted = await send({
    clientId: 'c-quote-2',
    kind: 'text',
    text: '这条是引用',
    replyTo: firstId,
  })
  assert.equal(quoted.statusCode, 200, quoted.body)
  const body = quoted.json()
  assert.equal(body.message.replyTo.id, firstId)
  assert.equal(body.message.replyTo.text, '第一条')
})

test('翻历史分页和 since 补齐', async () => {
  for (let i = 0; i < 5; i += 1) {
    const res = await send({ clientId: `c-page-${i}`, kind: 'text', text: `第 ${i} 条` })
    assert.equal(res.statusCode, 200)
  }

  const latest = await app.inject({
    method: 'GET',
    url: '/api/messages?limit=2',
    headers: auth(),
  })
  const page = latest.json()
  assert.equal(page.items.length, 2)
  assert.equal(page.hasMore, true)
  assert.ok(page.items[1].seq > page.items[0].seq)

  const before = page.items[0].seq
  const older = await app.inject({
    method: 'GET',
    url: `/api/messages?limit=2&before=${before}`,
    headers: auth(),
  })
  const olderBody = older.json()
  assert.equal(olderBody.items.length, 2)
  assert.ok(olderBody.items[1].seq < before)

  const since = await app.inject({
    method: 'GET',
    url: `/api/messages?since=${before}`,
    headers: auth(),
  })
  const sinceBody = since.json()
  assert.ok(sinceBody.items.every((m: { seq: number }) => m.seq > before))
})

test('打字状态接口能用', async () => {
  const on = await app.inject({
    method: 'POST',
    url: '/api/typing',
    headers: auth(),
    payload: { on: true },
  })
  assert.equal(on.statusCode, 200)
  assert.equal(on.json().ok, true)
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
        if (race === null) break
        if (race.done) break
        buffer += decoder.decode(race.value, { stream: true })
      }
      if (!buffer.includes(marker)) throw new Error(`等不到 ${marker}，收到：${buffer.slice(0, 300)}`)
      return buffer
    },
    async cancel(): Promise<void> {
      try {
        await reader.cancel()
      } catch {
        // 已经关了
      }
    },
  }
}

test('SSE 连上先 hello，再收到新消息', async () => {
  const head = await app.inject({ method: 'GET', url: '/api/messages?limit=1', headers: auth() })
  const headSeq: number = head.json().items[0].seq

  const controller = new AbortController()
  const res = await fetch(`${base}/api/stream?since=${headSeq}`, {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
    signal: controller.signal,
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/)

  const sse = readSse(res)
  const hello = await sse.until('event: hello')
  assert.match(hello, /"convId":"c-main"/)
  assert.match(hello, new RegExp(`"lastSeq":${headSeq}`))

  const sent = await send({ clientId: 'c-sse', kind: 'text', text: '推送这条' })
  assert.equal(sent.statusCode, 200)

  const created = await sse.until('event: message.created')
  assert.match(created, /推送这条/)
  await sse.cancel()
  controller.abort()
})

test('SSE 没登录是 401', async () => {
  const res = await fetch(`${base}/api/stream?since=0`)
  assert.equal(res.status, 401)
})
