import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify'
import cookie from '@fastify/cookie'
import fastifyStatic from '@fastify/static'
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

export const APP_VERSION = '0.1.0'

export interface AppDeps {
  config: AppConfig
  paths: AppPaths
  db: DatabaseSync
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
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store')
    return payload
  })

  app.get('/api/health', async (): Promise<HealthInfo> => {
    db.prepare('SELECT 1').get()
    return {
      ok: true,
      version: APP_VERSION,
      node: process.version,
      db: 'ok',
      asr: 'not_installed',
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
    if (kind !== 'text') {
      return fail(reply, 400, 'kind_not_ready', `P1 只会发文字，${kind} 还没做`)
    }

    const text = String(body.text ?? '').trim()
    if (!text) return fail(reply, 400, 'empty_message', '空消息不发')
    if (text.length > LIMITS.messageMaxChars) {
      return fail(reply, 400, 'too_long', `一条最多 ${LIMITS.messageMaxChars} 字`)
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
      kind: 'text',
      text,
      replyTo,
      source: 'web',
      clientId,
    })

    if (created) mock.note(text)
    return { ok: true, message, created }
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
