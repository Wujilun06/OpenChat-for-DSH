import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { AppConfig } from '../config.js'
import type { Hub } from './hub.js'
import { createMessage } from './messages.js'

/**
 * 接 DSH 的那半边。
 *
 * 真正的会话读写由 `dsh-openchat-bridge` 插件（宿主侧）负责；
 * 这里只做四件事：导入历史、把网页发的话送进去、听助手的新消息、断线重连。
 */

const BRIDGE_FILE = join(process.env.USERPROFILE || homedir(), '.dsh', 'openchat-bridge.json')

interface BridgeFile {
  token?: string
  session?: string
}

export interface DshBridge {
  enabled: boolean
  start(): void
  stop(): void
  /** 用户发了一条文字：进合并窗口，窗口结束再一起送过去。 */
  queue(text: string): void
}

interface HistoryItem {
  id?: string
  role?: string
  text?: string
  at?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readBridgeFile(): BridgeFile {
  try {
    if (!existsSync(BRIDGE_FILE)) return {}
    const parsed = JSON.parse(readFileSync(BRIDGE_FILE, 'utf8')) as BridgeFile
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function createDshBridge(deps: {
  config: AppConfig
  db: DatabaseSync
  hub: Hub
  convId: string
}): DshBridge {
  const { config, db, hub, convId } = deps
  const settings = config.dsh

  let stopped = false
  let streamAbort: AbortController | null = null
  let mergeTimer: ReturnType<typeof setTimeout> | null = null
  let pending: string[] = []

  function resolved() {
    const file = readBridgeFile()
    return {
      baseUrl: settings.baseUrl.replace(/\/+$/, ''),
      token: settings.token || String(file.token || ''),
      session: settings.session || String(file.session || ''),
    }
  }

  async function call(path: string, init: RequestInit = {}, timeoutMs = 10_000) {
    const { baseUrl, token, session } = resolved()
    const url = new URL(baseUrl + path)
    if (!url.searchParams.has('session')) url.searchParams.set('session', session)

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const headers: Record<string, string> = {
        ...(init.headers as Record<string, string> | undefined),
        'x-openchat-token': token,
      }
      const res = await fetch(url, { ...init, headers, signal: controller.signal })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        items?: unknown
        message?: string
      }
      if (!res.ok || body.ok === false) {
        throw new Error(String(body.message || `桥返回 ${res.status}`))
      }
      return body
    } finally {
      clearTimeout(timer)
    }
  }

  function addMessage(item: HistoryItem, source: 'import' | 'dsh'): boolean {
    const id = String(item?.id || '')
    const text = String(item?.text || '').trim()
    const role = item?.role === 'me' ? 'me' : 'fish'
    if (!id || !text) return false
    try {
      const { created } = createMessage(db, hub, {
        convId,
        sender: role,
        kind: 'text',
        text,
        source,
        clientId: `dsh:${id}`,
        createdAt: typeof item.at === 'number' ? item.at : undefined,
      })
      return created
    } catch (error) {
      console.error('[dsh] 写消息失败：', (error as Error).message)
      return false
    }
  }

  async function importHistory(): Promise<void> {
    const { session } = resolved()
    if (!session) {
      console.warn('[dsh] 桥里还没有会话 id，先不导历史')
      return
    }
    try {
      const body = await call(`/history?limit=${settings.historyLimit}`)
      const items = Array.isArray(body.items) ? (body.items as HistoryItem[]) : []
      let added = 0
      for (const item of items) {
        if (addMessage(item, 'import')) added += 1
      }
      console.log(`[dsh] 历史读到 ${items.length} 条，新写进 ${added} 条`)
    } catch (error) {
      console.warn('[dsh] 读历史失败：', (error as Error).message)
    }
  }

  function handleSse(raw: string): void {
    let eventName = ''
    const dataLines: string[] = []
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim()
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    }
    if (!eventName || dataLines.length === 0) return

    let data: HistoryItem & { turn?: number | null }
    try {
      data = JSON.parse(dataLines.join('\n')) as HistoryItem & { turn?: number | null }
    } catch {
      return
    }

    if (eventName === 'assistant') {
      addMessage(
        { id: data.id, role: 'fish', text: data.text, at: data.at },
        'dsh',
      )
      hub.publish({ type: 'typing.changed', data: { who: 'fish', on: false } })
      return
    }
    if (eventName === 'turn-end') {
      hub.publish({ type: 'typing.changed', data: { who: 'fish', on: false } })
    }
  }

  async function streamLoop(): Promise<void> {
    let lastWarn = ''
    let lastWarnAt = 0

    while (!stopped) {
      const { baseUrl, token, session } = resolved()
      if (!session) {
        await sleep(3000)
        continue
      }

      streamAbort = new AbortController()
      try {
        const res = await fetch(`${baseUrl}/stream?session=${encodeURIComponent(session)}`, {
          headers: { 'x-openchat-token': token },
          signal: streamAbort.signal,
        })
        if (!res.ok || !res.body) throw new Error(`桥的 stream 返回 ${res.status}`)
        console.log('[dsh] 已接上会话事件流')
        lastWarn = ''

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!stopped) {
          const { value, done } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let cut = buffer.indexOf('\n\n')
          while (cut >= 0) {
            const raw = buffer.slice(0, cut)
            buffer = buffer.slice(cut + 2)
            handleSse(raw)
            cut = buffer.indexOf('\n\n')
          }
        }
      } catch (error) {
        if (!stopped) {
          const message = (error as Error).message
          const now = Date.now()
          // 桥没起来的时候每 5 秒重试一次，别把日志刷爆
          if (message !== lastWarn || now - lastWarnAt > 60_000) {
            console.warn('[dsh] 事件流断了：', message)
            lastWarn = message
            lastWarnAt = now
          }
        }
      }

      if (stopped) break
      await sleep(5000)
    }
  }

  async function flush(): Promise<void> {
    const text = pending.join('\n').trim()
    pending = []
    if (!text) return

    hub.publish({ type: 'typing.changed', data: { who: 'fish', on: true } })
    try {
      await call(
        '/send',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text }),
        },
        15_000,
      )
    } catch (error) {
      hub.publish({ type: 'typing.changed', data: { who: 'fish', on: false } })
      try {
        createMessage(db, hub, {
          convId,
          sender: 'fish',
          kind: 'system',
          text: `（没送到 DSH：${(error as Error).message}）`,
          source: 'dsh',
        })
      } catch {
        // 连错误消息都写不进去就算了
      }
    }
  }

  function queue(text: string): void {
    if (!settings.enabled) return
    const clean = String(text || '').trim()
    if (!clean) return
    pending.push(clean)
    if (mergeTimer) clearTimeout(mergeTimer)
    mergeTimer = setTimeout(() => {
      mergeTimer = null
      void flush()
    }, settings.mergeWindowMs)
  }

  function start(): void {
    if (!settings.enabled) return
    // 等宿主把监听挂完再导，别在启动那一刻抢
    setTimeout(() => void importHistory(), 800)
    void streamLoop()
  }

  function stop(): void {
    stopped = true
    if (mergeTimer) clearTimeout(mergeTimer)
    mergeTimer = null
    try {
      streamAbort?.abort()
    } catch {
      // 已经断了
    }
  }

  return { enabled: settings.enabled, start, stop, queue }
}
