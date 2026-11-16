import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import type { AppConfig, AppPaths } from '../src/config.js'
import { SESSION_COOKIE, checkPassword, hashToken } from '../src/auth.js'
import { openDatabase } from '../src/db.js'
import { buildApp } from '../src/app.js'

let workDir = ''
let paths: AppPaths
let app: FastifyInstance
let db: ReturnType<typeof openDatabase>

const config: AppConfig = {
  server: { host: '127.0.0.1', port: 0, publicUrl: '' },
  password: 'correct horse',
  peer: { name: '蓝色大肥鱼', avatar: '/peer.png' },
  dataDir: 'unused',
  session: { days: 30 },
  sticker: { maxBytes: 5 * 1024 * 1024, maxCount: 100 },
  attachment: { imageMaxBytes: 5 * 1024 * 1024, videoMaxBytes: 5 * 1024 * 1024, fileMaxBytes: 5 * 1024 * 1024 },
  mock: { enabled: false, mergeWindowMs: 10, typingMs: 10, gapMs: 10 },
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'openchat-test-'))
  paths = {
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
})

after(async () => {
  await app.close()
  db.close()
  rmSync(workDir, { recursive: true, force: true })
})

test('健康检查不需要登录', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(res.statusCode, 200)
  const body = res.json()
  assert.equal(body.ok, true)
  assert.equal(body.db, 'ok')
})

test('没登录访问 /api/auth/me 是 401', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/auth/me' })
  assert.equal(res.statusCode, 401)
  assert.equal(res.json().code, 'unauthorized')
})

test('密码不对是 401，连错五次会被锁', async () => {
  for (let i = 0; i < 5; i += 1) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { password: 'wrong' },
    })
    assert.equal(res.statusCode, i < 4 ? 401 : 429)
  }
  const locked = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { password: 'correct horse' },
  })
  assert.equal(locked.statusCode, 429)
})

test('密码对能登录，带着 cookie 能拿到会话信息', async () => {
  // 上一轮把 IP 锁住了；这里换个 X-Forwarded-For 绕过（trustProxy 开着）。
  const headers = { 'x-forwarded-for': '10.9.9.9' }
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers,
    payload: { password: 'correct horse' },
  })
  assert.equal(login.statusCode, 200)
  assert.equal(login.json().ok, true)

  const setCookie = login.headers['set-cookie']
  assert.ok(setCookie)
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie
  const token = String(raw).split(';')[0]?.split('=')[1]
  assert.ok(token)

  const me = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers,
    cookies: { [SESSION_COOKIE]: token },
  })
  assert.equal(me.statusCode, 200)
  const body = me.json()
  assert.equal(body.peer.name, '蓝色大肥鱼')
  assert.equal(body.conversation.lastSeq, 0)

  const logout = await app.inject({
    method: 'POST',
    url: '/api/auth/logout',
    headers,
    cookies: { [SESSION_COOKIE]: token },
  })
  assert.equal(logout.statusCode, 200)

  const after = await app.inject({
    method: 'GET',
    url: '/api/auth/me',
    headers,
    cookies: { [SESSION_COOKIE]: token },
  })
  assert.equal(after.statusCode, 401)
})

test('token 落库的是哈希，不是明文', () => {
  const rows = db.prepare('SELECT token_hash FROM auth_sessions').all() as { token_hash: string }[]
  for (const row of rows) assert.match(row.token_hash, /^[0-9a-f]{64}$/)
  assert.equal(hashToken('x').length, 64)
})

test('密码比对压平长度差', () => {
  assert.equal(checkPassword('abc', 'abc'), true)
  assert.equal(checkPassword('abc', 'abcd'), false)
  assert.equal(checkPassword('', 'abc'), false)
})

test('未知接口是 JSON 404', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/nope' })
  assert.equal(res.statusCode, 404)
  assert.equal(res.json().code, 'not_found')
})

test('没构建前端时页面路径给 503 提示', async () => {
  const res = await app.inject({ method: 'GET', url: '/' })
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().code, 'web_not_built')
})
