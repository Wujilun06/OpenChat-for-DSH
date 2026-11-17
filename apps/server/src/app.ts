import { createReadStream, existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
import multipart, { type MultipartFile } from '@fastify/multipart'
import type { DatabaseSync } from 'node:sqlite'
import type {
  ApiError,
  ConversationInfo,
  HealthInfo,
  LoginResult,
  MeResult,
  MessagesResult,
  PeerInfo,
} from '@openchat/shared'
import { LIMITS } from '@openchat/shared'
import type { AppConfig, AppPaths } from './config.js'
import {
  LoginGuard,
  SESSION_COOKIE,
  checkPassword,
  createSession,
  revokeSession,
  verifySession,
} from './auth.js'
import { Hub } from './services/hub.js'
import { createMessage, findMessage, listBefore, listSince } from './services/messages.js'
import { MockFish } from './services/mockFish.js'
import { createVoiceService, VoiceError, type VoiceService } from './services/voice.js'
import {
  AttachmentError,
  attachmentFilePath,
  attachmentThumbPath,
  createAttachment,
  getAttachmentInfo,
  getAttachmentRow,
  openAttachment,
} from './services/attachments.js'
import {
  StickerError,
  createSticker,
  getStickerRow,
  listStickers,
  liveStickerInfo,
  openStickerFile,
  softDeleteSticker,
  stickerFilePath,
  stickerThumbPath,
} from './services/stickers.js'

export const APP_VERSION = '0.1.0'

export interface AppDeps {
  config: AppConfig
  paths: AppPaths
  db: DatabaseSync
  /** 测试里塞假转写；平时不传，按配置自己建。 */
  voice?: VoiceService
}

interface ConversationRow {
  id: string
  kind: string
  title: string
  last_seq: number
}

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  const body: ApiError = { ok: false, code, message }
  return reply.code(status).send(body)
}

function fileTooLargeMessage(maxBytes: number): string {
  return `这张太大了，最多 ${Math.round(maxBytes / 1024 / 1024)} MB`
}

/**
 * 解析 `Range: bytes=…`（Safari 播视频必须）。
 * 拿不到范围返回 null，范围写得不对返回 'invalid'。
 */
function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return 'invalid'
  const startRaw = match[1] ?? ''
  const endRaw = match[2] ?? ''
  if (!startRaw && !endRaw) return 'invalid'

  let start: number
  let end: number
  if (!startRaw) {
    const suffix = Number(endRaw)
    if (!Number.isFinite(suffix) || suffix <= 0) return 'invalid'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(startRaw)
    end = endRaw ? Number(endRaw) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid'
  if (start < 0 || start >= size || end < start) return 'invalid'
  return { start, end: Math.min(end, size - 1) }
}

function peerOf(config: AppConfig): PeerInfo {
  return { name: config.peer.name, avatar: config.peer.avatar }
}

/**
 * 建一个 Fastify 实例。
 *
 * 不在这里 listen —— 测试直接用 app.inject()，进程入口在 index.ts。
 */
export function buildApp(deps: AppDeps, options: { logger?: boolean } = {}): FastifyInstance {
  const { config, paths, db } = deps
  const guard = new LoginGuard()
  const sweepTimer = setInterval(() => guard.sweep(), 5 * 60 * 1000)
  sweepTimer.unref()

  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
  })

  app.register(cookie)
  app.register(multipart, {
    limits: {
      fileSize: Math.max(
        config.sticker.maxBytes,
        config.attachment.imageMaxBytes,
        config.attachment.videoMaxBytes,
        config.attachment.fileMaxBytes,
      ),
      files: 1,
      fieldSize: 1024,
    },
  })

  const conversationOf = (): ConversationInfo => {
    const row = db
      .prepare('SELECT id, kind, title, last_seq FROM conversations ORDER BY created_at LIMIT 1')
      .get() as ConversationRow | undefined
    if (!row) throw new Error('数据库里没有会话，seed 没跑成功')
    return {
      id: row.id,
      kind: 'dm',
      title: row.title,
      peer: peerOf(config),
      lastSeq: Number(row.last_seq),
    }
  }

  const sessionOf = (req: FastifyRequest) => {
    const token = req.cookies[SESSION_COOKIE]
    return verifySession(db, token)
  }

  const requireSession = (req: FastifyRequest, reply: FastifyReply) => {
    const session = sessionOf(req)
    if (!session) {
      fail(reply, 401, 'unauthorized', '还没登录')
      return null
    }
    return session
  }

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'same-origin')
    // 表情图片自己带了 immutable 缓存头，别被这里盖成 no-store。
    if (req.url.startsWith('/api/') && !reply.getHeader('cache-control')) {
      reply.header('cache-control', 'no-store')
    }
    return payload
  })

  app.get('/api/health', async (): Promise<HealthInfo> => {
    db.prepare('SELECT 1').get()
    return {
      ok: true,
      version: APP_VERSION,
      node: process.version,
      db: 'ok',
      asr: voice.ready() ? 'ready' : 'not_installed',
      time: Date.now(),
    }
  })

  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { password?: unknown }
    const password = String(body.password ?? '')
    const ip = req.ip

    const retryAfter = guard.retryAfter(ip)
    if (retryAfter !== null) {
      reply.header('retry-after', String(retryAfter))
      return fail(reply, 429, 'locked', `试太多次了，等 ${retryAfter} 秒再来`)
    }

    if (!checkPassword(password, config.password)) {
      const locked = guard.recordFail(ip)
      if (locked !== null) {
        reply.header('retry-after', String(locked))
        return fail(reply, 429, 'locked', `错太多次了，等 ${locked} 秒再来`)
      }
      return fail(reply, 401, 'bad_password', '密码不对')
    }

    guard.recordSuccess(ip)
    const issued = createSession(
      db,
      config.session.days,
      req.headers['user-agent'] ?? null,
      ip,
    )
    reply.setCookie(SESSION_COOKIE, issued.token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: req.protocol === 'https',
      maxAge: config.session.days * 24 * 60 * 60,
    })
    const result: LoginResult = { ok: true, expiresAt: issued.expiresAt }
    return result
  })

  app.post('/api/auth/logout', async (req, reply) => {
    revokeSession(db, req.cookies[SESSION_COOKIE])
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return { ok: true }
  })

  app.get('/api/auth/me', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    const result: MeResult = {
      ok: true,
      peer: peerOf(config),
      conversation: conversationOf(),
      expiresAt: session.expiresAt,
    }
    return result
  })

  // ── 会话、消息、推送 ───────────────────────────────────────────────
  const convId = (db
    .prepare('SELECT id FROM conversations ORDER BY created_at LIMIT 1')
    .get() as { id: string } | undefined)?.id
  if (!convId) throw new Error('数据库里没有会话，seed 没跑成功')

  const hub = new Hub()
  const mock = new MockFish({ db, hub, convId, config: config.mock })
  const voice = deps.voice ?? createVoiceService(paths, config)

  const parseLimit = (raw: unknown, fallback: number): number => {
    const n = Number(raw)
    if (!Number.isFinite(n)) return fallback
    return Math.min(200, Math.max(1, Math.trunc(n)))
  }

  app.get('/api/conversation', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    return { ok: true, conversation: conversationOf() }
  })

  app.get('/api/messages', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    const query = (req.query ?? {}) as Record<string, unknown>
    const limit = parseLimit(query.limit, 50)

    if (query.since !== undefined) {
      const since = Number(query.since)
      if (!Number.isFinite(since) || since < 0) {
        return fail(reply, 400, 'bad_since', 'since 不是个数字')
      }
      const result = listSince(db, convId, Math.trunc(since), limit)
      const body: MessagesResult = { ok: true, items: result.items, hasMore: result.hasMore }
      return body
    }

    let before: number | null = null
    if (query.before !== undefined) {
      const parsed = Number(query.before)
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return fail(reply, 400, 'bad_before', 'before 不是个数字')
      }
      before = Math.trunc(parsed)
    }

    const result = listBefore(db, convId, before, limit)
    const body: MessagesResult = { ok: true, items: result.items, hasMore: result.hasMore }
    return body
  })

  app.post('/api/messages', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply

    const body = (req.body ?? {}) as Record<string, unknown>
    const clientId = String(body.clientId ?? '').trim()
    if (!clientId) return fail(reply, 400, 'client_id_required', '要给一个 clientId，重发才不会变成两条')

    const kind = String(body.kind ?? 'text')
    const allowed = ['text', 'sticker', 'image', 'video', 'file']
    if (!allowed.includes(kind)) {
      return fail(reply, 400, 'kind_not_ready', `${kind} 还没做，现在能发文字、表情、图片、视频、文件`)
    }

    let text: string | null = null
    let stickerId: string | null = null
    let attachmentId: string | null = null

    if (kind === 'text') {
      text = String(body.text ?? '').trim()
      if (!text) return fail(reply, 400, 'empty_message', '空消息不发')
      if (text.length > LIMITS.messageMaxChars) {
        return fail(reply, 400, 'too_long', `一条最多 ${LIMITS.messageMaxChars} 字`)
      }
    } else if (kind === 'sticker') {
      stickerId = String(body.stickerId ?? '').trim()
      if (!stickerId) return fail(reply, 400, 'sticker_required', '表情消息要带 stickerId')
      if (!liveStickerInfo(db, stickerId)) {
        return fail(reply, 400, 'bad_sticker', '这个表情不在了')
      }
    } else {
      attachmentId = String(body.attachmentId ?? '').trim()
      if (!attachmentId) return fail(reply, 400, 'attachment_required', '附件消息要带 attachmentId')
      const attachment = getAttachmentInfo(db, attachmentId)
      if (!attachment) return fail(reply, 400, 'bad_attachment', '这个附件不在了')
      if (attachment.kind !== kind) {
        return fail(reply, 400, 'attachment_kind_mismatch', `这是 ${attachment.kind}，不是 ${kind}`)
      }
    }

    let replyTo: string | null = null
    if (body.replyTo !== undefined && body.replyTo !== null && body.replyTo !== '') {
      replyTo = String(body.replyTo)
      if (!findMessage(db, replyTo)) {
        return fail(reply, 400, 'bad_reply_to', '引用的那条消息不在了')
      }
    }

    const { message, created } = createMessage(db, hub, {
      convId,
      sender: 'me',
      kind: kind as 'text' | 'sticker' | 'image' | 'video' | 'file',
      text,
      stickerId,
      attachmentId,
      replyTo,
      source: 'web',
      clientId,
    })

    if (created) mock.note(kind === 'text' ? (text ?? '') : `[${kind}]`)
    return { ok: true, message, created }
  })

  // ── 表情 ───────────────────────────────────────────────────────────
  app.get('/api/stickers', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    return { ok: true, items: listStickers(db), maxCount: config.sticker.maxCount }
  })

  app.post('/api/stickers', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    if (!req.isMultipart()) return fail(reply, 400, 'bad_upload', '要用 multipart 传文件')

    let part: MultipartFile | undefined
    try {
      part = await req.file()
    } catch (error) {
      return fail(reply, 413, 'file_too_large', fileTooLargeMessage(config.sticker.maxBytes))
    }
    if (!part) return fail(reply, 400, 'no_file', '没收到文件')

    let buffer: Buffer
    try {
      buffer = await part.toBuffer()
    } catch (error) {
      const code = String((error as { code?: string })?.code ?? '')
      if (code === 'FST_REQ_FILE_TOO_LARGE') {
        return fail(reply, 413, 'file_too_large', fileTooLargeMessage(config.sticker.maxBytes))
      }
      return fail(reply, 400, 'bad_upload', `文件没传完：${String((error as Error).message)}`)
    }

    try {
      const sticker = await createSticker(
        db,
        paths,
        { maxBytes: config.sticker.maxBytes, maxCount: config.sticker.maxCount },
        { buffer, filename: part.filename },
      )
      return { ok: true, sticker }
    } catch (error) {
      if (error instanceof StickerError) return fail(reply, error.status, error.code, error.message)
      throw error
    }
  })

  app.delete('/api/stickers/:id', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    const id = String((req.params as { id?: string }).id ?? '')
    if (!softDeleteSticker(db, id)) {
      return fail(reply, 404, 'sticker_not_found', '没有这个表情')
    }
    return { ok: true }
  })

  app.get('/api/stickers/:id/thumb', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    const row = getStickerRow(db, String((req.params as { id?: string }).id ?? ''))
    if (!row) return fail(reply, 404, 'sticker_not_found', '没有这个表情')
    const thumb = stickerThumbPath(paths, row)
    if (!thumb) {
      const file = stickerFilePath(paths, row)
      if (!file) return fail(reply, 404, 'file_missing', '文件不在了')
      return reply
        .header('content-type', row.mime)
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(openStickerFile(file))
    }
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(openStickerFile(thumb))
  })

  app.get('/api/stickers/:id/file', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    const row = getStickerRow(db, String((req.params as { id?: string }).id ?? ''))
    if (!row) return fail(reply, 404, 'sticker_not_found', '没有这个表情')
    const file = stickerFilePath(paths, row)
    if (!file) return fail(reply, 404, 'file_missing', '文件不在了')
    return reply
      .header('content-type', row.mime)
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(openStickerFile(file))
  })

  // ── 附件（图片 / 视频 / 文件）─────────────────────────────────────
  app.post('/api/attachments', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    if (!req.isMultipart()) return fail(reply, 400, 'bad_upload', '要用 multipart 传文件')

    let part: MultipartFile | undefined
    try {
      part = await req.file()
    } catch {
      return fail(reply, 413, 'file_too_large', '这个文件太大了')
    }
    if (!part) return fail(reply, 400, 'no_file', '没收到文件')

    let buffer: Buffer
    try {
      buffer = await part.toBuffer()
    } catch (error) {
      const code = String((error as { code?: string })?.code ?? '')
      if (code === 'FST_REQ_FILE_TOO_LARGE') {
        return fail(reply, 413, 'file_too_large', '这个文件太大了')
      }
      return fail(reply, 400, 'bad_upload', `文件没传完：${String((error as Error).message)}`)
    }

    try {
      const attachment = await createAttachment(db, paths, config.attachment, config.media, {
        buffer,
        filename: part.filename,
        mime: part.mimetype,
      })
      return { ok: true, attachment }
    } catch (error) {
      if (error instanceof AttachmentError) return fail(reply, error.status, error.code, error.message)
      throw error
    }
  })

  app.get('/api/attachments/:id/thumb', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    const row = getAttachmentRow(db, String((req.params as { id?: string }).id ?? ''))
    if (!row) return fail(reply, 404, 'attachment_not_found', '没有这个附件')
    const thumb = attachmentThumbPath(paths, row)
    if (!thumb) return fail(reply, 404, 'thumb_missing', '这个附件没有缩略图')
    return reply
      .header('content-type', 'image/png')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(createReadStream(thumb))
  })

  app.get('/api/attachments/:id/file', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    const row = getAttachmentRow(db, String((req.params as { id?: string }).id ?? ''))
    if (!row) return fail(reply, 404, 'attachment_not_found', '没有这个附件')
    const file = attachmentFilePath(paths, row)
    if (!file) return fail(reply, 404, 'file_missing', '文件不在了')

    const size = statSync(file).size
    const disposition = row.kind === 'file' ? 'attachment' : 'inline'
    reply
      .header('content-type', row.mime)
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('content-disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(row.name)}`)

    const range = parseRange(req.headers.range, size)
    if (range === 'invalid') {
      return reply.code(416).header('content-range', `bytes */${size}`).send()
    }
    if (range) {
      return reply
        .code(206)
        .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
        .header('content-length', String(range.end - range.start + 1))
        .send(openAttachment(file, range))
    }
    return reply.header('content-length', String(size)).send(openAttachment(file))
  })

  // ── 通话（P4 占位：接口和状态留好，不做实时）──────────────────────
  app.get('/api/calls/status', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    return { ok: true, supported: false, active: null }
  })

  app.post('/api/calls', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply

    const body = (req.body ?? {}) as Record<string, unknown>
    const kind = String(body.kind ?? 'audio')
    if (kind !== 'audio' && kind !== 'video') {
      return fail(reply, 400, 'bad_call_kind', '只认 audio / video')
    }

    const now = Date.now()
    const id = crypto.randomUUID()
    db.prepare(
      `INSERT INTO calls (id, kind, direction, state, created_at, ended_at)
       VALUES (?, ?, 'outgoing', 'unsupported', ?, NULL)`,
    ).run(id, kind, now)

    const call = {
      id,
      kind: kind as 'audio' | 'video',
      direction: 'outgoing' as const,
      state: 'unsupported' as const,
      createdAt: now,
      endedAt: null,
    }
    hub.publish({ type: 'call.state', data: call })

    return reply.code(501).send({
      ok: false,
      code: 'call_not_implemented',
      message: '通话还没做（P4 占位：接口和事件已经留好）',
      call,
    })
  })

  // ── 语音消息：上传录音 → 转写 → 只存文字和时长 ──────────────────
  app.post('/api/messages/voice', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    if (!req.isMultipart()) return fail(reply, 400, 'bad_upload', '要用 multipart 传音频')

    const query = (req.query ?? {}) as Record<string, unknown>
    const clientId = String(query.clientId ?? '').trim()
    if (!clientId) {
      return fail(reply, 400, 'client_id_required', '要给一个 clientId，重发才不会变成两条')
    }

    let replyTo: string | null = null
    if (query.replyTo) {
      replyTo = String(query.replyTo)
      if (!findMessage(db, replyTo)) {
        return fail(reply, 400, 'bad_reply_to', '引用的那条消息不在了')
      }
    }

    let part: MultipartFile | undefined
    try {
      part = await req.file()
    } catch {
      return fail(reply, 413, 'audio_too_large', '录音太大了')
    }
    if (!part) return fail(reply, 400, 'no_file', '没收到音频')

    let buffer: Buffer
    try {
      buffer = await part.toBuffer()
    } catch (error) {
      const code = String((error as { code?: string })?.code ?? '')
      if (code === 'FST_REQ_FILE_TOO_LARGE') {
        return fail(reply, 413, 'audio_too_large', '录音太大了')
      }
      return fail(reply, 400, 'bad_upload', `音频没传完：${String((error as Error).message)}`)
    }

    try {
      const result = await voice.transcribe({ buffer, mime: part.mimetype })
      const { message, created } = createMessage(db, hub, {
        convId,
        sender: 'me',
        kind: 'voice',
        text: result.text,
        voiceMs: result.durationMs,
        replyTo,
        source: 'web',
        clientId,
      })
      if (created) mock.note('[语音]')
      return { ok: true, message, created }
    } catch (error) {
      if (error instanceof VoiceError) return fail(reply, error.status, error.code, error.message)
      throw error
    }
  })

  app.post('/api/typing', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply
    const body = (req.body ?? {}) as Record<string, unknown>
    hub.publish({ type: 'typing.changed', data: { who: 'me', on: Boolean(body.on) } })
    return { ok: true }
  })

  /**
   * SSE。
   *
   * 连上先给 hello，再把 since 之后的消息补一遍，然后转实时。
   * 每 25 秒一个 ping，别让中间的反代把空闲连接掐掉。
   */
  app.get('/api/stream', async (req, reply) => {
    const session = requireSession(req, reply)
    if (!session) return reply

    const query = (req.query ?? {}) as Record<string, unknown>
    const sinceRaw = Number(query.since ?? 0)
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.trunc(sinceRaw) : 0

    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    raw.write('retry: 3000\n\n')

    const send = (event: { type: string; data: unknown }) => {
      raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`)
    }

    const conversation = conversationOf()
    send({ type: 'hello', data: { convId, lastSeq: conversation.lastSeq, serverTime: Date.now() } })

    // 补历史：最多补 5 页，多了让客户端自己翻
    let cursor = since
    for (let page = 0; page < 5; page += 1) {
      const batch = listSince(db, convId, cursor, 200)
      for (const message of batch.items) {
        send({ type: 'message.created', data: message })
        cursor = message.seq
      }
      if (!batch.hasMore) break
    }

    const off = hub.add(send)
    const ping = setInterval(() => {
      try {
        send({ type: 'ping', data: { t: Date.now() } })
      } catch {
        // 写不进去就靠 close 收拾
      }
    }, 25_000)

    let closed = false
    const cleanup = () => {
      if (closed) return
      closed = true
      clearInterval(ping)
      off()
      try {
        raw.end()
      } catch {
        // 已经断了
      }
    }
    req.raw.on('close', cleanup)
    req.raw.on('error', cleanup)
    raw.on('error', cleanup)
  })

  // ── 静态文件（构建后的前端）───────────────────────────────────────
  const hasWeb = existsSync(resolve(paths.webDist, 'index.html'))
  if (hasWeb) {
    app.register(fastifyStatic, {
      root: paths.webDist,
      prefix: '/',
      index: ['index.html'],
      wildcard: true,
    })
  }

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return fail(reply, 404, 'not_found', '没有这个接口')
    }
    if (req.method !== 'GET') return fail(reply, 404, 'not_found', '没有这个路径')
    if (!hasWeb) {
      return fail(
        reply,
        503,
        'web_not_built',
        '前端还没构建。先跑一次 npm run build，或者用 npm run dev 开发。',
      )
    }
    // SPA：任何前端路径都回 index.html
    return reply.sendFile('index.html')
  })

  app.addHook('onClose', async () => {
    clearInterval(sweepTimer)
    mock.stop()
  })

  return app
}
