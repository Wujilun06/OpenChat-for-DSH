/**
 * dsh-openchat-bridge —— 宿主侧的一层薄接口。
 *
 * 只干三件事：
 *   1. 把某一间 DSH 会话的历史读出来（给 OpenChat 初始化用）；
 *   2. 把一段文字投进那间会话（走 sessionController.prompt）；
 *   3. 把会话里新出的助手消息用 SSE 推出去（给 OpenChat 实时显示）。
 *
 * 不碰 QQ，不碰客户端，不依赖任何 @deepseek-ai 包：服务都从 ctx 上按名字取。
 * 配置在 ~/.dsh/openchat-bridge.json（第一次启动会自己生成）：
 *   { "port": 8788, "token": "...", "session": "bili-whale", "cwd": "..." }
 */

import { createServer } from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-openchat-bridge'
export const inject = []

const HOME = process.env.USERPROFILE || homedir()
const DSH_DIR = join(HOME, '.dsh')
const CFG_FILE = join(DSH_DIR, 'openchat-bridge.json')

function loadConfig() {
  try {
    if (existsSync(CFG_FILE)) {
      const parsed = JSON.parse(readFileSync(CFG_FILE, 'utf8'))
      if (parsed && typeof parsed === 'object') return parsed
    }
  } catch {
    // 坏了就重新生成一份
  }
  const fresh = {
    port: 8788,
    token: randomBytes(16).toString('hex'),
    session: '',
    cwd: '',
  }
  try {
    mkdirSync(DSH_DIR, { recursive: true })
    writeFileSync(CFG_FILE, JSON.stringify(fresh, null, 2))
  } catch {
    // 写不了就内存里用
  }
  return fresh
}

/** 从一条消息里只抠正文：reasoning / image / tool 都不要。 */
function textOf(message) {
  const content = message && message.content
  const segments = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
  return segments
    .filter((segment) => segment && segment.type === 'text')
    .map((segment) => String(segment.text ?? ''))
    .join('\n')
    .trim()
}

function idOf(message, event) {
  return String((message && message.id) || (event && event.id) || '')
}

export function apply(ctx) {
  const config = loadConfig()
  const token = String(config.token || '')
  const port = Number(config.port) || 8788
  const defaultSession = String(config.session || '')
  const defaultCwd = String(config.cwd || '')

  const sinks = new Set()

  function publish(event) {
    for (const sink of sinks) {
      try {
        sink(event)
      } catch {
        sinks.delete(sink)
      }
    }
  }

  // 只推助手说的话和轮次结束；用户在那边的原话不进网页（避免和网页自己发的那条重复）
  ctx.effect(() => {
    const off = ctx.on('session/event', (session, event) => {
      try {
        const sessionId = String((session && session.id) || '')
        const type = String((event && event.type) || '')
        const data = (event && event.data) || {}

        if (type === 'assistant/message') {
          if (data.interrupted) return
          const text = textOf(data.message)
          if (!text) return
          publish({
            type: 'assistant',
            session: sessionId,
            data: {
              id: idOf(data.message, event),
              text,
              turn: data.turn ?? null,
              at: Number(event && event.time) || Date.now(),
            },
          })
          return
        }

        if (type === 'turn/end') {
          publish({
            type: 'turn-end',
            session: sessionId,
            data: { turn: data.turn ?? null, reason: (data.reason && data.reason.kind) || null },
          })
        }
      } catch {
        // 事件里出什么事都不能影响宿主
      }
    })
    return () => {
      try {
        off?.()
      } catch {
        // 已经摘掉了
      }
    }
  }, 'openchat-bridge: 盯会话事件')

  function candidateIds(id) {
    const raw = String(id || '').trim()
    if (!raw) return []
    return [raw, raw.startsWith('session-') ? raw.slice('session-'.length) : `session-${raw}`]
  }

  function findAgent(id) {
    let agents = null
    try {
      agents = ctx.get?.('agents')
    } catch {
      agents = null
    }
    if (!agents || typeof agents.get !== 'function') return null
    for (const candidate of candidateIds(id)) {
      try {
        const agent = agents.get(candidate)
        if (agent) return agent
      } catch {
        // 继续试下一个
      }
    }
    return null
  }

  /** 会话没开就先开一下（sessionController.create 对已存在的会话是复用）。 */
  async function ensureSession(id) {
    const sessionId = String(id || defaultSession || '').trim()
    if (!sessionId) return null
    const live = findAgent(sessionId)
    if (live) return live
    try {
      const controller = ctx.get?.('sessionController')
      if (controller && typeof controller.create === 'function') {
        await controller.create({
          sessionId,
          ...(defaultCwd ? { cwd: defaultCwd } : {}),
        })
      }
    } catch {
      return null
    }
    return findAgent(sessionId)
  }

  function snapshotEvents(id) {
    const sessionId = String(id || defaultSession || '')
    for (const candidate of candidateIds(sessionId)) {
      try {
        const session = ctx.get?.('sessions')?.get?.(candidate)
        if (session && typeof session.snapshotEvents === 'function') {
          const events = session.snapshotEvents()
          if (Array.isArray(events)) return events
        }
      } catch {
        // 继续
      }
    }
    return []
  }

  async function readEvents(id) {
    let events = snapshotEvents(id)
    if (events.length) return events
    const sessionId = String(id || defaultSession || '')
    try {
      const query = ctx.get?.('sessionQuery')
      if (query && typeof query.readSession === 'function') {
        const snapshot = await query.readSession(sessionId)
        if (snapshot && Array.isArray(snapshot.events)) return snapshot.events
      }
    } catch {
      // 退到空
    }
    return []
  }

  async function history(id, limit) {
    const sessionId = String(id || defaultSession || '').trim()
    if (!sessionId) return []
    await ensureSession(sessionId)
    const events = await readEvents(sessionId)
    const items = []

    for (const event of events) {
      const type = String((event && event.type) || '')
      if (type !== 'user/message' && type !== 'assistant/message') continue
      const data = (event && event.data) || {}
      if (type === 'assistant/message' && data.interrupted) continue
      const message = data.message
      const text = textOf(message)
      if (!text) continue
      const idValue = idOf(message, event)
      if (!idValue) continue
      items.push({
        id: idValue,
        role: type === 'assistant/message' ? 'fish' : 'me',
        text,
        at: Number(event && event.time) || Date.now(),
        turn: data.turn ?? null,
      })
    }

    const count = Math.max(1, Math.min(2000, Number(limit) || 200))
    return items.slice(-count)
  }

  async function send(id, text) {
    const sessionId = String(id || defaultSession || '').trim()
    if (!sessionId) {
      const error = new Error('没配置会话（~/.dsh/openchat-bridge.json 的 session）')
      error.status = 400
      error.code = 'no_session'
      throw error
    }
    await ensureSession(sessionId)

    let controller = null
    try {
      controller = ctx.get?.('sessionController')
    } catch {
      controller = null
    }
    if (!controller || typeof controller.prompt !== 'function') {
      const error = new Error('宿主没有 sessionController')
      error.status = 500
      error.code = 'no_controller'
      throw error
    }

    const content = [{ type: 'text', text }]
    try {
      // mode: queue —— 她正在忙的时候排队，不打断
      await controller.prompt({ sessionId, content, mode: 'queue' })
    } catch (first) {
      if (typeof controller.create !== 'function') throw first
      await controller.create({ sessionId, ...(defaultCwd ? { cwd: defaultCwd } : {}) })
      await controller.prompt({ sessionId, content, mode: 'queue' })
    }
    return true
  }

  function listSessions() {
    const out = []
    try {
      const list = ctx.get?.('sessions')?.list?.() || []
      const titles = ctx.get?.('sessionTitle')
      for (const session of list) {
        let title = ''
        try {
          const snapshot = titles && typeof titles.get === 'function' ? titles.get(session) : undefined
          title = String((snapshot && snapshot.title) || '')
        } catch {
          // 没标题就算了
        }
        out.push({ id: String(session.id), title })
      }
    } catch {
      // 空列表
    }
    return out
  }

  function readBody(req) {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 1_000_000) req.destroy()
      })
      req.on('end', () => {
        try {
          resolve(JSON.parse(body || '{}'))
        } catch {
          resolve({})
        }
      })
    })
  }

  function sendJson(res, status, payload) {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(JSON.stringify(payload))
  }

  function authorized(req, url) {
    if (!token) return true
    const header = String(req.headers['x-openchat-token'] || '')
    const query = String(url.searchParams.get('token') || '')
    return header === token || query === token
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          version: '0.1.0',
          session: defaultSession,
          sessions: listSessions(),
        })
      }

      if (!authorized(req, url)) {
        return sendJson(res, 401, { ok: false, code: 'unauthorized', message: 'token 不对' })
      }

      if (req.method === 'GET' && url.pathname === '/sessions') {
        return sendJson(res, 200, { ok: true, items: listSessions() })
      }

      if (req.method === 'GET' && url.pathname === '/history') {
        const items = await history(url.searchParams.get('session') || '', url.searchParams.get('limit'))
        return sendJson(res, 200, { ok: true, items })
      }

      if (req.method === 'POST' && url.pathname === '/send') {
        const body = await readBody(req)
        const text = String(body.text || '').trim()
        if (!text) return sendJson(res, 400, { ok: false, code: 'empty', message: '空消息' })
        await send(String(body.session || ''), text)
        return sendJson(res, 200, { ok: true })
      }

      if (req.method === 'GET' && url.pathname === '/stream') {
        const sessionId = String(url.searchParams.get('session') || defaultSession || '')
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
        })
        res.write('retry: 3000\n\n')

        const write = (eventName, data) => {
          if (sessionId && data.session && data.session !== sessionId) return
          res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`)
        }
        write('hello', { session: sessionId, at: Date.now() })

        const sink = (event) => write(event.type, { ...event.data, session: event.session })
        sinks.add(sink)

        const ping = setInterval(() => {
          try {
            res.write(`event: ping\ndata: {"t":${Date.now()}}\n\n`)
          } catch {
            // 断了会走 cleanup
          }
        }, 25_000)

        let closed = false
        const cleanup = () => {
          if (closed) return
          closed = true
          clearInterval(ping)
          sinks.delete(sink)
          try {
            res.end()
          } catch {
            // 已经关了
          }
        }
        req.on('close', cleanup)
        res.on('error', cleanup)
        return
      }

      return sendJson(res, 404, { ok: false, code: 'not_found', message: '没这个接口' })
    } catch (error) {
      const status = Number(error && error.status) || 500
      return sendJson(res, status, {
        ok: false,
        code: String((error && error.code) || 'error'),
        message: String((error && error.message) || error),
      })
    }
  })

  server.on('error', (error) => {
    console.error('[openchat-bridge] http 服务出问题：' + String((error && error.message) || error))
  })

  ctx.effect(() => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`[openchat-bridge] 听在 127.0.0.1:${port}（会话 ${defaultSession || '没配'}）`)
    })
    return () => {
      try {
        server.close()
      } catch {
        // 没起来
      }
    }
  }, 'openchat-bridge: http 服务')
}
