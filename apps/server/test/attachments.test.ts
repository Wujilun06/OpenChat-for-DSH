import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
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
  attachment: { imageMaxBytes: 64 * 1024, videoMaxBytes: 64 * 1024, fileMaxBytes: 64 * 1024 },
  media: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
  asr: { enabled: false, threads: 4, python: '', modelDir: '', timeoutMs: 120000 },
  dsh: { enabled: false, baseUrl: 'http://127.0.0.1:8788', token: '', session: '', historyLimit: 200, mergeWindowMs: 2000 },
  mock: { enabled: false, mergeWindowMs: 10, typingMs: 10, gapMs: 10 },
}

const auth = () => ({ cookie: `${SESSION_COOKIE}=${token}` })

function multipart(file: Buffer, filename: string, type: string) {
  const boundary = '----openchat-attach-boundary'
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
    url: '/api/attachments',
    headers: { ...form.headers, ...auth() },
    payload: form.payload,
  })
}

async function png(width = 20, height = 10) {
  return sharp({ create: { width, height, channels: 3, background: { r: 30, g: 120, b: 200 } } })
    .png()
    .toBuffer()
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'openchat-attach-'))
  const paths: AppPaths = {
    root: workDir,
    configFile: join(workDir, 'config.json'),
    dataDir: workDir,
    dbFile: join(workDir, 'openchat.db'),
    stickersDir: join(workDir, 'stickers'),
    thumbsDir: join(workDir, 'thumbs'),
    filesDir: join(workDir, 'files'),
    fileThumbsDir: join(workDir, 'file-thumbs'),
    webDist: join(workDir, 'no-web'),
  }
  db = openDatabase(paths)
  app = buildApp({ config, paths, db })

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-forwarded-for': '10.4.4.4' },
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

let imageId = ''
let videoId = ''
let fileId = ''

test('传图片：认得宽高，出缩略图', async () => {
  const res = await upload(await png(), 'photo.png', 'image/png')
  assert.equal(res.statusCode, 200, res.body)
  const attachment = res.json().attachment
  imageId = attachment.id
  assert.equal(attachment.kind, 'image')
  assert.equal(attachment.w, 20)
  assert.equal(attachment.h, 10)
  assert.equal(attachment.name, 'photo.png')
  assert.equal(attachment.thumbUrl, `/api/attachments/${imageId}/thumb`)
})

test('缩略图和原图都能取', async () => {
  const thumb = await app.inject({
    method: 'GET',
    url: `/api/attachments/${imageId}/thumb`,
    headers: auth(),
  })
  assert.equal(thumb.statusCode, 200)
  assert.match(String(thumb.headers['content-type']), /image\/png/)

  const file = await app.inject({
    method: 'GET',
    url: `/api/attachments/${imageId}/file`,
    headers: auth(),
  })
  assert.equal(file.statusCode, 200)
  assert.match(String(file.headers['content-type']), /image\/png/)
  assert.equal(file.headers['accept-ranges'], 'bytes')
})

test('Range 请求回 206（Safari 播视频要用）', async () => {
  const res = await app.inject({
    method: 'GET',
    url: `/api/attachments/${imageId}/file`,
    headers: { ...auth(), range: 'bytes=0-9' },
  })
  assert.equal(res.statusCode, 206)
  assert.match(String(res.headers['content-range']), /^bytes 0-9\/\d+$/)
  assert.equal(Number(res.headers['content-length']), 10)
})

test('传视频和普通文件', async () => {
  const video = await upload(Buffer.from('not-really-an-mp4-but-fine'), 'clip.mp4', 'video/mp4')
  assert.equal(video.statusCode, 200, video.body)
  videoId = video.json().attachment.id
  assert.equal(video.json().attachment.kind, 'video')

  const doc = await upload(Buffer.from('hello openchat'), 'notes.txt', 'text/plain')
  assert.equal(doc.statusCode, 200, doc.body)
  fileId = doc.json().attachment.id
  assert.equal(doc.json().attachment.kind, 'file')

  const download = await app.inject({
    method: 'GET',
    url: `/api/attachments/${fileId}/file`,
    headers: auth(),
  })
  assert.equal(download.statusCode, 200)
  assert.match(String(download.headers['content-disposition']), /^attachment;/)
})

test('同一张图传两次只存一份', async () => {
  const again = await upload(await png(), 'photo-again.png', 'image/png')
  assert.equal(again.statusCode, 200)
  assert.equal(again.json().attachment.id, imageId)
})

test('假图片和超大文件被拒', async () => {
  const bad = await upload(Buffer.from('这不是图片'), 'fake.png', 'image/png')
  assert.equal(bad.statusCode, 400)
  assert.equal(bad.json().code, 'bad_image')

  const huge = Buffer.alloc(70 * 1024, 7)
  const tooBig = await upload(huge, 'huge.bin', 'application/octet-stream')
  assert.equal(tooBig.statusCode, 413)
  assert.equal(tooBig.json().code, 'file_too_large')
})

test('能发图片 / 视频 / 文件消息', async () => {
  const imageMsg = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(),
    payload: { clientId: 'att-1', kind: 'image', attachmentId: imageId },
  })
  assert.equal(imageMsg.statusCode, 200, imageMsg.body)
  assert.equal(imageMsg.json().message.kind, 'image')
  assert.equal(imageMsg.json().message.attachment.id, imageId)
  assert.equal(imageMsg.json().message.text, null)

  const videoMsg = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(),
    payload: { clientId: 'att-2', kind: 'video', attachmentId: videoId },
  })
  assert.equal(videoMsg.statusCode, 200, videoMsg.body)

  const fileMsg = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(),
    payload: { clientId: 'att-3', kind: 'file', attachmentId: fileId },
  })
  assert.equal(fileMsg.statusCode, 200, fileMsg.body)
})

test('类型对不上、没有附件 id 都被拒', async () => {
  const mismatch = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(),
    payload: { clientId: 'att-4', kind: 'video', attachmentId: imageId },
  })
  assert.equal(mismatch.statusCode, 400)
  assert.equal(mismatch.json().code, 'attachment_kind_mismatch')

  const missing = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(),
    payload: { clientId: 'att-5', kind: 'image' },
  })
  assert.equal(missing.statusCode, 400)
  assert.equal(missing.json().code, 'attachment_required')

  const ghost = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: auth(),
    payload: { clientId: 'att-6', kind: 'image', attachmentId: 'nope' },
  })
  assert.equal(ghost.statusCode, 400)
  assert.equal(ghost.json().code, 'bad_attachment')
})
