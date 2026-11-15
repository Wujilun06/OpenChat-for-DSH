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
  PeerInfo,
} from '@openchat/shared'
import type { AppConfig, AppPaths } from './config.js'
import {
  LoginGuard,
  SESSION_COOKIE,
  checkPassword,
  createSession,
  revokeSession,
  verifySession,
} from './auth.js'

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
  })

  return app
}
