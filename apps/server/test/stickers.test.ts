import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomFillSync } from 'node:crypto'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import type { AppConfig, AppPaths } from '../src/config.js'
import { SESSION_COOKIE } from '../src/auth.js'
import { openDatabase } from '../src/db.js'
import { buildApp } from '../src/app.js'

const GIF_BASE64 =
  'R0lGODlhCAAIAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAACAAIAAAIDwABCBxIsKDBgwgTKkwYEAAh+QQBCgABACwAAAAACAAIAIEAAP8AAAAAAAAAAAAIDwABCBxIsKDBgwgTKkwYEAA7'

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
  sticker: { maxBytes: 64 * 1024, maxCount: 3 },
  attachment: { imageMaxBytes: 64 * 1024, videoMaxBytes: 64 * 1024, fileMaxBytes: 64 * 1024 },
  mock: { enabled: false, mergeWindowMs: 10, typingMs: 10, gapMs: 10 },
}

const auth = () => ({ cookie: `${SESSION_COOKIE}=${token}` })

async function png(width = 8, height = 8, color = { r: 255, g: 0, b: 0 }) {
  return sharp({ create: { width, height, channels: 3, background: color } })
    .png()
    .toBuffer()
}

async function noisyPng(size = 220) {
  const raw = Buffer.alloc(size * size * 3)
  randomFillSync(raw)
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .png()
    .toBuffer()
}

function multipart(file: Buffer, filename = 'x.png', type = 'image/png') {
  const boundary = '----openchat-test-boundary'
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

async function upload(file: Buffer, filename: string, type: string) {
  const form = multipart(file, filename, type)
  return app.inject({
    method: 'POST',
    url: '/api/stickers',
    headers: { ...form.headers, ...auth() },
    payload: form.payload,
  })
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'openchat-sticker-'))
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
    headers: { 'x-forwarded-for': '10.3.3.3' },
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

let redId = ''
let gifId = ''

test('传一张 png：落库、出缩略图', async () => {
  const res = await upload(await png(), 'red.png', 'image/png')
  assert.equal(res.statusCode, 200, res.body)
  const sticker = res.json().sticker
  redId = sticker.id
  assert.equal(sticker.animated, false)
  assert.equal(sticker.w, 8)
  assert.equal(sticker.h, 8)
  assert.equal(sticker.thumbUrl, `/api/stickers/${sticker.id}/thumb`)
  assert.equal(sticker.fileUrl, `/api/stickers/${sticker.id}/file`)
})

test('列表、缩略图、原图都能取', async () => {
  const list = await app.inject({ method: 'GET', url: '/api/stickers', headers: auth() })
  assert.equal(list.statusCode, 200)
  assert.equal(list.json().items.length, 1)
  assert.equal(list.json().maxCount, 3)

  const thumb = await app.inject({
    method: 'GET',
    url: `/api/stickers/${redId}/thumb`,
    headers: auth(),
  })
  assert.equal(thumb.statusCode, 200)
  assert.match(String(thumb.headers['content-type']), /image\/png/)
  assert.match(String(thumb.headers['cache-control']), /immutable/)

  const file = await app.inject({
    method: 'GET',
    url: `/api/stickers/${redId}/file`,
    headers: auth(),
  })
  assert.equal(file.statusCode, 200)
  assert.match(String(file.headers['content-type']), /image\/png/)
})

test('同一张图再传一次不重复占位', async () => {
  const again = await upload(await png(), 'red-again.png', 'image/png')
  assert.equal(again.statusCode, 200)
  assert.equal(again.json().sticker.id, redId)

  const count = db
    .prepare('SELECT COUNT(*) AS n FROM stickers WHERE deleted_at IS NULL')
    .get() as { n: number }
  assert.equal(Number(count.n), 1)
})

test('gif 认得出来是动图，缩略图还是静态 png', async () => {
  const res = await upload(Buffer.from(GIF_BASE64, 'base64'), 'spin.gif', 'image/gif')
  assert.equal(res.statusCode, 200, res.body)
  const sticker = res.json().sticker
  gifId = sticker.id
  assert.equal(sticker.animated, true)

  const thumb = await app.inject({
    method: 'GET',
    url: `/api/stickers/${gifId}/thumb`,
    headers: auth(),
  })
  assert.equal(thumb.statusCode, 200)
  assert.match(String(thumb.headers['content-type']), /image\/png/)
})

test('不是图片的文件被拒', async () => {
  const res = await upload(Buffer.from('这不是图片'), 'fake.png', 'image/png')
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'bad_image')
})

test('超过单张大小被拒', async () => {
  const res = await upload(await noisyPng(), 'big.png', 'image/png')
  assert.equal(res.statusCode, 413)
  assert.equal(res.json().code, 'file_too_large')
})

test('到上限就收不下了', async () => {
  const green = await upload(await png(8, 8, { r: 0, g: 255, b: 0 }), 'green.png', 'image/png')
  assert.equal(green.statusCode, 200)

  const blue = await upload(await png(8, 8, { r: 0, g: 0, b: 255 }), 'blue.png', 'image/png')
  assert.equal(blue.statusCode, 409)
  assert.equal(blue.json().code, 'sticker_limit')
})

let stickerMessageId = ''

test('能发一条表情消息', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(),
    payload: { clientId: 'sticker-msg-1', kind: 'sticker', stickerId: redId },
  })
  assert.equal(res.statusCode, 200, res.body)
  const message = res.json().message
  stickerMessageId = message.id
  assert.equal(message.kind, 'sticker')
  assert.equal(message.text, null)
  assert.equal(message.sticker.id, redId)
})

test('发一个不存在的表情被拒', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(),
    payload: { clientId: 'sticker-msg-2', kind: 'sticker', stickerId: 'nope' },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'bad_sticker')
})

test('软删之后面板里没了，历史消息照显', async () => {
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/stickers/${redId}`,
    headers: auth(),
  })
  assert.equal(del.statusCode, 200)

  const list = await app.inject({ method: 'GET', url: '/api/stickers', headers: auth() })
  assert.equal(list.json().items.length, 2)

  const again = await app.inject({
    method: 'DELETE',
    url: `/api/stickers/${redId}`,
    headers: auth(),
  })
  assert.equal(again.statusCode, 404)

  const file = await app.inject({
    method: 'GET',
    url: `/api/stickers/${redId}/file`,
    headers: auth(),
  })
  assert.equal(file.statusCode, 200)

  const messages = await app.inject({
    method: 'GET',
    url: '/api/messages?limit=50',
    headers: auth(),
  })
  const found = messages
    .json()
    .items.find((m: { id: string }) => m.id === stickerMessageId)
  assert.ok(found)
  assert.equal(found.sticker.id, redId)
})

test('删掉的表情不能再发', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(),
    payload: { clientId: 'sticker-msg-3', kind: 'sticker', stickerId: redId },
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'bad_sticker')
})

test('删了再传同一张会复活', async () => {
  const res = await upload(await png(), 'red-back.png', 'image/png')
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().sticker.id, redId)
  const list = await app.inject({ method: 'GET', url: '/api/stickers', headers: auth() })
  assert.ok(list.json().items.some((s: { id: string }) => s.id === redId))
})
