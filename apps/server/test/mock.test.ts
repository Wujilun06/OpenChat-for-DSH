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

const config: AppConfig = {
  server: { host: '127.0.0.1', port: 0, publicUrl: '' },
  password: 'correct horse',
  peer: { name: '蓝色大肥鱼', avatar: '/peer.png' },
  dataDir: 'unused',
  session: { days: 30 },
  sticker: { maxBytes: 5 * 1024 * 1024, maxCount: 100 },
  attachment: { imageMaxBytes: 5 * 1024 * 1024, videoMaxBytes: 5 * 1024 * 1024, fileMaxBytes: 5 * 1024 * 1024 },
  media: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
  mock: { enabled: true, mergeWindowMs: 80, typingMs: 10, gapMs: 5 },
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'openchat-mock-'))
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

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-forwarded-for': '10.2.2.2' },
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

test('2 秒窗口内连发两句，只回一轮', async () => {
  const headers = { cookie: `${SESSION_COOKIE}=${token}` }
  const one = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers,
    payload: { clientId: 'm-1', kind: 'text', text: '第一句' },
  })
  const two = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers,
    payload: { clientId: 'm-2', kind: 'text', text: '第二句' },
  })
  assert.equal(one.statusCode, 200)
  assert.equal(two.statusCode, 200)

  await sleep(500)

  const list = await app.inject({
    method: 'GET',
    url: '/api/messages?limit=50',
    headers,
  })
  const items = list.json().items as Array<{ sender: string; source: string; text: string }>
  const fish = items.filter((m) => m.sender === 'fish')

  // 2 句人话 + 一轮回答（回答不再带「收到：…」那种回声）
  assert.equal(items.length, 3, `应该是 2 句人话 + 1 段回答，实际 ${items.length}`)
  assert.equal(fish.length, 1)
  assert.equal(fish[0]?.source, 'mock')
  assert.equal(fish[0]?.text, '这条是占位回答，接上 DSH 以后就换成真的了。')
})

test('回答是一个一个落库的，seq 跟着往下走', async () => {
  const list = await app.inject({
    method: 'GET',
    url: '/api/messages?limit=50',
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  })
  const items = list.json().items as Array<{ sender: string; createdAt: number; seq: number }>
  const fish = items.filter((m) => m.sender === 'fish')
  assert.equal(fish.length, 1)
  assert.ok(Number(fish[0]?.seq) > Number(items[1]?.seq))
  assert.ok(Number(fish[0]?.createdAt) >= Number(items[1]?.createdAt))
})
