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
import { VoiceError, type VoiceService } from '../src/services/voice.js'

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
  asr: { enabled: true, threads: 4, python: '', modelDir: '', timeoutMs: 120000 },
  mock: { enabled: false, mergeWindowMs: 10, typingMs: 10, gapMs: 10 },
}

/** 假的转写：省得测试去装 230MB 模型。开头放个 X 就模拟没装好。 */
const voice: VoiceService = {
  ready: () => true,
  transcribe: async ({ buffer }) => {
    if (buffer[0] === 0x58) throw new VoiceError(503, 'asr_not_ready', '没装')
    if (buffer.length < 8) throw new VoiceError(400, 'bad_audio', '读不出来')
    return { text: '你好，我是测试', durationMs: 2300 }
  },
}

const auth = () => ({ cookie: `${SESSION_COOKIE}=${token}` })

function multipart(file: Buffer, filename: string, type: string) {
  const boundary = '----openchat-voice-boundary'
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

async function sendVoice(file: Buffer, query: string) {
  const form = multipart(file, 'voice.webm', 'audio/webm')
  return app.inject({
    method: 'POST',
    url: `/api/messages/voice${query}`,
    headers: { ...form.headers, ...auth() },
    payload: form.payload,
  })
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'openchat-voice-'))
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
  app = buildApp({ config, paths, db, voice })

  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-forwarded-for': '10.5.5.5' },
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

let voiceMessageId = ''

test('健康检查说转写就绪', async () => {
  const res = await app.inject({ method: 'GET', url: '/api/health' })
  assert.equal(res.json().asr, 'ready')
})

test('传一段录音 → 转写 → 只落文字和时长', async () => {
  const res = await sendVoice(Buffer.alloc(64, 1), '?clientId=v-1')
  assert.equal(res.statusCode, 200, res.body)
  const message = res.json().message
  voiceMessageId = message.id
  assert.equal(message.kind, 'voice')
  assert.equal(message.text, '你好，我是测试')
  assert.equal(message.voiceMs, 2300)
  assert.equal(message.sender, 'me')
})

test('同一个 clientId 重发不变成两条', async () => {
  const res = await sendVoice(Buffer.alloc(64, 1), '?clientId=v-1')
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().created, false)
  assert.equal(res.json().message.id, voiceMessageId)
})

test('缺 clientId 被拒', async () => {
  const res = await sendVoice(Buffer.alloc(64, 1), '')
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'client_id_required')
})

test('没收到音频被拒', async () => {
  const res = await app.inject({
    method: 'POST',
    url: '/api/messages/voice?clientId=v-empty',
    headers: { ...auth(), 'content-type': 'multipart/form-data; boundary=xx' },
    payload: Buffer.from('--xx--\r\n'),
  })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().code, 'no_file')
})

test('转写没装好时明确说', async () => {
  const res = await sendVoice(Buffer.from([0x58, 0x58, 0x58, 0x58, 0x58, 0x58, 0x58, 0x58]), '?clientId=v-2')
  assert.equal(res.statusCode, 503)
  assert.equal(res.json().code, 'asr_not_ready')
})

test('能引用一条再发语音', async () => {
  const res = await sendVoice(Buffer.alloc(64, 2), `?clientId=v-3&replyTo=${voiceMessageId}`)
  assert.equal(res.statusCode, 200, res.body)
  assert.equal(res.json().message.replyTo.id, voiceMessageId)
})
