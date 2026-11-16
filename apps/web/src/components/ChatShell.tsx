import { useCallback, useEffect, useRef, useState } from 'react'
import type { AttachmentInfo, MeResult, MessageInfo, StickerInfo } from '@openchat/shared'
import { ApiError, api } from '../api'
import { MessageRow } from './MessageRow'
import { PendingVoiceRow } from './PendingVoiceRow'
import { StickerPanel } from './StickerPanel'
import { PlusMenu } from './PlusMenu'
import { MediaViewer } from './MediaViewer'
import { refLabel } from '../lib/preview'
import { formatDuration } from '../lib/time'
import { CloseIcon, MicIcon, MoreIcon, PlusIcon, SmileIcon } from './icons'

export function ChatShell({ me, onLogout }: { me: MeResult; onLogout: () => void }) {
  const [messages, setMessages] = useState<MessageInfo[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [draft, setDraft] = useState('')
  const [replyTo, setReplyTo] = useState<MessageInfo | null>(null)
  const [fishTyping, setFishTyping] = useState(false)
  const [connected, setConnected] = useState(false)
  const [sending, setSending] = useState(false)
  const [toast, setToast] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)
  const [timeLevels, setTimeLevels] = useState<Record<string, number>>({})
  const [stickerOpen, setStickerOpen] = useState(false)
  const [stickers, setStickers] = useState<StickerInfo[]>([])
  const [stickerMax, setStickerMax] = useState(100)
  const [stickersLoading, setStickersLoading] = useState(false)
  const [stickerError, setStickerError] = useState('')
  const [plusOpen, setPlusOpen] = useState(false)
  const [viewer, setViewer] = useState<AttachmentInfo | null>(null)
  const [recording, setRecording] = useState(false)
  const [recordMs, setRecordMs] = useState(0)
  const [asrReady, setAsrReady] = useState<boolean | null>(null)
  const [pendingVoice, setPendingVoice] = useState<{ voiceMs: number } | null>(null)

  const lastSeqRef = useRef(me.conversation.lastSeq)
  const stickRef = useRef(true)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastTypingPing = useRef(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const recordStartRef = useRef(0)
  const cancelledRef = useRef(false)

  const flash = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 2000)
  }, [])

  const clearToast = useCallback(() => {
    if (toastTimer.current) {
      clearTimeout(toastTimer.current)
      toastTimer.current = null
    }
    setToast('')
  }, [])

  const scrollToBottom = useCallback((smooth = false) => {
    const el = listRef.current
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [])

  const append = useCallback((incoming: MessageInfo[]) => {
    if (!incoming.length) return
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id))
      const add = incoming.filter((m) => !seen.has(m.id))
      if (!add.length) return prev
      return [...prev, ...add].sort((a, b) => a.seq - b.seq)
    })
    const max = incoming.reduce((n, m) => Math.max(n, m.seq), lastSeqRef.current)
    lastSeqRef.current = max
  }, [])

  /** 断线之后把漏掉的补回来。 */
  const catchUp = useCallback(
    async (target: number) => {
      let since = lastSeqRef.current
      for (let page = 0; page < 20 && since < target; page += 1) {
        const res = await api.messages({ since, limit: 200 }).catch(() => null)
        if (!res) return
        append(res.items)
        const last = res.items.length ? res.items[res.items.length - 1]!.seq : since
        if (last <= since) break
        since = last
        if (!res.hasMore) break
      }
    },
    [append],
  )

  // 第一次进来：读最近 50 条
  useEffect(() => {
    let alive = true
    api
      .messages({ limit: 50 })
      .then((res) => {
        if (!alive) return
        setMessages(res.items)
        setHasMore(res.hasMore)
        const last = res.items.length ? res.items[res.items.length - 1]!.seq : 0
        lastSeqRef.current = Math.max(last, me.conversation.lastSeq)
        requestAnimationFrame(() => scrollToBottom())
      })
      .catch((err: unknown) => {
        if (alive) flash(err instanceof ApiError ? err.message : '读不到消息')
      })
    return () => {
      alive = false
    }
  }, [flash, me.conversation.lastSeq, scrollToBottom])

  // SSE：断了自己重连，带 since 补消息
  useEffect(() => {
    let es: EventSource | null = null
    let stopped = false
    let attempt = 0
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const listen = (name: string, fn: (data: unknown) => void) => {
      es?.addEventListener(name, (event) => {
        try {
          fn(JSON.parse((event as MessageEvent).data))
        } catch {
          // 坏包丢掉
        }
      })
    }

    const open = () => {
      if (stopped) return
      es = new EventSource(`/api/stream?since=${lastSeqRef.current}`)
      es.onopen = () => {
        attempt = 0
        setConnected(true)
      }
      es.onerror = () => {
        setConnected(false)
        es?.close()
        es = null
        if (stopped) return
        const delay = Math.min(15_000, 800 * 2 ** attempt)
        attempt += 1
        retryTimer = setTimeout(open, delay)
      }

      listen('hello', (data) => {
        const hello = data as { lastSeq?: number }
        if (typeof hello.lastSeq === 'number' && hello.lastSeq > lastSeqRef.current) {
          void catchUp(hello.lastSeq)
        }
      })
      listen('message.created', (data) => {
        const message = data as MessageInfo
        // 真消息到了，占位那条就撤掉（SSE 有时比 HTTP 响应先到）
        if (message.sender === 'me' && message.kind === 'voice') setPendingVoice(null)
        append([message])
      })
      listen('message.updated', (data) => {
        const change = data as { id: string; changes: Partial<MessageInfo> }
        setMessages((prev) => prev.map((m) => (m.id === change.id ? { ...m, ...change.changes } : m)))
      })
      listen('message.deleted', (data) => {
        const gone = data as { id: string }
        setMessages((prev) => prev.filter((m) => m.id !== gone.id))
      })
      listen('typing.changed', (data) => {
        const typing = data as { who?: string; on?: boolean }
        if (typing.who === 'fish') setFishTyping(Boolean(typing.on))
      })
    }

    open()

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !es) {
        attempt = 0
        open()
      }
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      stopped = true
      if (retryTimer) clearTimeout(retryTimer)
      document.removeEventListener('visibilitychange', onVisible)
      es?.close()
    }
  }, [append, catchUp])

  // 新消息贴着底
  useEffect(() => {
    if (stickRef.current) scrollToBottom()
  }, [messages.length, scrollToBottom])

  // 转写占位一出现也贴着底
  useEffect(() => {
    if (!pendingVoice) return
    stickRef.current = true
    scrollToBottom()
  }, [pendingVoice, scrollToBottom])

  // 输入框跟着长
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(120, el.scrollHeight)}px`
  }, [draft])

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
      if (typingTimer.current) clearTimeout(typingTimer.current)
    }
  }, [])

  // 转写装没装好，决定麦克风能不能点
  useEffect(() => {
    let alive = true
    api
      .health()
      .then((health) => {
        if (alive) setAsrReady(health.asr === 'ready')
      })
      .catch(() => {
        if (alive) setAsrReady(null)
      })
    return () => {
      alive = false
    }
  }, [])

  // 离开页面把录音停掉、麦克风放开
  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current)
      cancelledRef.current = true
      try {
        recorderRef.current?.stop()
      } catch {
        // 已经停了
      }
      streamRef.current?.getTracks().forEach((track) => track.stop())
    }
  }, [])

  useEffect(() => {
    if (!menuOpen) return
    const close = () => setMenuOpen(false)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [menuOpen])

  const onDraftChange = (value: string) => {
    setDraft(value)
    const now = Date.now()
    if (value.trim() && now - lastTypingPing.current > 1000) {
      lastTypingPing.current = now
      void api.typing(true).catch(() => {})
    }
    if (typingTimer.current) clearTimeout(typingTimer.current)
    typingTimer.current = setTimeout(() => {
      void api.typing(false).catch(() => {})
    }, 2500)
  }

  const send = async () => {
    const text = draft.trim()
    if (!text || sending) return
    setSending(true)
    try {
      const res = await api.sendMessage({
        clientId: crypto.randomUUID(),
        kind: 'text',
        text,
        replyTo: replyTo?.id ?? null,
      })
      append([res.message])
      setDraft('')
      setReplyTo(null)
      stickRef.current = true
      scrollToBottom()
    } catch (err) {
      flash(err instanceof ApiError ? err.message : '没发出去')
    } finally {
      setSending(false)
    }
  }

  const loadOlder = async () => {
    if (!hasMore || loadingOlder) return
    const first = messages[0]
    if (!first) return
    setLoadingOlder(true)
    try {
      const res = await api.messages({ before: first.seq, limit: 50 })
      const el = listRef.current
      const beforeHeight = el?.scrollHeight ?? 0
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id))
        const add = res.items.filter((m) => !seen.has(m.id))
        return [...add, ...prev].sort((a, b) => a.seq - b.seq)
      })
      setHasMore(res.hasMore)
      requestAnimationFrame(() => {
        const next = listRef.current
        if (next) next.scrollTop = next.scrollHeight - beforeHeight
      })
    } catch {
      flash('翻不到更早的了')
    } finally {
      setLoadingOlder(false)
    }
  }

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    stickRef.current = distance < 80
    if (el.scrollTop < 40) void loadOlder()
  }

  const cycleTime = (id: string) => {
    setTimeLevels((prev) => ({ ...prev, [id]: ((prev[id] ?? 0) + 1) % 3 }))
  }

  const previewOf = (message: MessageInfo) =>
    refLabel({
      id: message.id,
      sender: message.sender,
      kind: message.kind,
      text: message.text,
      stickerId: message.sticker?.id ?? null,
    })

  const loadStickers = useCallback(async () => {
    setStickersLoading(true)
    setStickerError('')
    try {
      const res = await api.stickers()
      setStickers(res.items)
      setStickerMax(res.maxCount)
    } catch (err) {
      setStickerError(err instanceof ApiError ? err.message : '读不到表情')
    } finally {
      setStickersLoading(false)
    }
  }, [])

  useEffect(() => {
    if (stickerOpen) void loadStickers()
  }, [stickerOpen, loadStickers])

  const pickSticker = async (sticker: StickerInfo) => {
    if (sending) return
    setSending(true)
    try {
      const res = await api.sendMessage({
        clientId: crypto.randomUUID(),
        kind: 'sticker',
        stickerId: sticker.id,
        replyTo: replyTo?.id ?? null,
      })
      append([res.message])
      setReplyTo(null)
      setStickerOpen(false)
      stickRef.current = true
      scrollToBottom()
    } catch (err) {
      flash(err instanceof ApiError ? err.message : '没发出去')
    } finally {
      setSending(false)
    }
  }

  const uploadSticker = async (file: File) => {
    setStickerError('')
    try {
      await api.uploadSticker(file)
      await loadStickers()
    } catch (err) {
      setStickerError(err instanceof ApiError ? err.message : '传不上去')
    }
  }

  const removeSticker = async (id: string) => {
    setStickerError('')
    try {
      await api.deleteSticker(id)
      await loadStickers()
    } catch (err) {
      setStickerError(err instanceof ApiError ? err.message : '删不掉')
    }
  }

  const sendAttachment = async (file: File) => {
    setPlusOpen(false)
    if (sending) return
    setSending(true)
    flash('正在上传…')
    try {
      const uploaded = await api.uploadAttachment(file)
      const res = await api.sendMessage({
        clientId: crypto.randomUUID(),
        kind: uploaded.attachment.kind,
        attachmentId: uploaded.attachment.id,
        replyTo: replyTo?.id ?? null,
      })
      append([res.message])
      setReplyTo(null)
      stickRef.current = true
      scrollToBottom()
      clearToast()
    } catch (err) {
      flash(err instanceof ApiError ? err.message : '传不上去')
    } finally {
      setSending(false)
    }
  }

  const pickAudioMime = (): string => {
    const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac']
    if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
      return ''
    }
    return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? ''
  }

  const stopRecordTimer = () => {
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current)
      recordTimerRef.current = null
    }
  }

  const uploadVoice = async (blob: Blob, durationMs: number) => {
    if (sending) return
    setSending(true)
    setPendingVoice({ voiceMs: durationMs })
    try {
      const res = await api.sendVoice(blob, {
        clientId: crypto.randomUUID(),
        replyTo: replyTo?.id ?? null,
      })
      append([res.message])
      setReplyTo(null)
      stickRef.current = true
      scrollToBottom()
    } catch (err) {
      flash(err instanceof ApiError ? err.message : '转写失败')
    } finally {
      setPendingVoice(null)
      setSending(false)
    }
  }

  const stopRecording = (send: boolean) => {
    const recorder = recorderRef.current
    if (!recorder) return
    cancelledRef.current = !send
    stopRecordTimer()
    if (recorder.state !== 'inactive') recorder.stop()
    else setRecording(false)
  }

  const cancelRecording = () => stopRecording(false)

  const startRecording = async () => {
    if (recording || sending) return
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      flash('要 https 或 localhost 才能用麦克风')
      return
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      flash('这个浏览器不支持录音')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = pickAudioMime()
      const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)

      streamRef.current = stream
      recorderRef.current = recorder
      chunksRef.current = []
      cancelledRef.current = false

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const type = recorder.mimeType || mime || 'audio/webm'
        const blob = new Blob(chunksRef.current, { type })
        const durationMs = Math.max(0, Date.now() - recordStartRef.current)
        chunksRef.current = []
        stream.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        recorderRef.current = null
        stopRecordTimer()
        setRecording(false)
        if (cancelledRef.current) return
        if (blob.size < 1200) {
          flash('太短了，多说两句')
          return
        }
        void uploadVoice(blob, durationMs)
      }

      recorder.start()
      setRecording(true)
      setRecordMs(0)
      recordStartRef.current = Date.now()
      recordTimerRef.current = setInterval(() => {
        const ms = Date.now() - recordStartRef.current
        setRecordMs(ms)
        if (ms >= 60_000) stopRecording(true)
      }, 200)
    } catch (error) {
      const name = String((error as { name?: string })?.name ?? '')
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        flash('这台机器没有麦克风（或没插）')
      } else if (name === 'NotAllowedError' || name === 'SecurityError') {
        flash('麦克风被浏览器拦了，点地址栏左边的锁放行一下')
      } else if (name === 'NotReadableError' || name === 'TrackStartError') {
        flash('麦克风被别的程序占着')
      } else {
        flash(`打不开麦克风：${name || '未知错误'}`)
      }
    }
  }

  return (
    <div className="chat">
      <header className="chat-header">
        <h1 className={`chat-title${fishTyping ? ' typing' : ''}`}>
          {fishTyping ? '对方正在输入…' : me.peer.name}
        </h1>
        <div className="chat-actions">
          <button
            className="icon-btn"
            type="button"
            title="更多"
            aria-label="更多"
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
          >
            <MoreIcon />
          </button>
        </div>
        {menuOpen ? (
          <div className="chat-menu" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={() => void onLogout()}>
              退出登录
            </button>
          </div>
        ) : null}
      </header>

      {connected ? null : <div className="conn-banner">连接断了，正在重连…</div>}

      <main className="messages" ref={listRef} onScroll={onScroll}>
        {loadingOlder ? <div className="older-hint">翻历史…</div> : null}

        {messages.length === 0 ? (
          <div className="empty">
            <img className="empty-avatar" src={me.peer.avatar} alt="" />
            <p className="empty-title">还没有消息</p>
            <p className="empty-hint">说句话试试</p>
          </div>
        ) : (
          messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              peer={me.peer}
              timeLevel={timeLevels[message.id] ?? 0}
              onCycleTime={cycleTime}
              onQuote={setReplyTo}
              onOpenMedia={(attachment) => setViewer(attachment)}
              onMediaLoad={() => {
                if (stickRef.current) scrollToBottom()
              }}
            />
          ))
        )}

        {pendingVoice ? <PendingVoiceRow voiceMs={pendingVoice.voiceMs} /> : null}
      </main>

      <footer className="composer">
        {replyTo ? (
          <div className="reply-bar">
            <span className="reply-text">
              回复 {replyTo.sender === 'me' ? '我' : me.peer.name}：{previewOf(replyTo)}
            </span>
            <button className="reply-close" type="button" aria-label="取消引用" onClick={() => setReplyTo(null)}>
              <CloseIcon width={16} height={16} />
            </button>
          </div>
        ) : null}

        {recording ? (
          <div className="record-bar">
            <span className="record-dot" />
            <span className="record-time">{formatDuration(recordMs)} / 1:00</span>
            <button className="record-cancel" type="button" onClick={cancelRecording}>
              取消
            </button>
            <button className="record-send" type="button" onClick={() => stopRecording(true)}>
              发送
            </button>
          </div>
        ) : (
          <div className="composer-row">
          <button
            className="tool"
            type="button"
            disabled={sending || asrReady === false}
            title={asrReady === false ? '转写还没装好' : '不说话就点一下开始录'}
            aria-label="语音消息"
            onClick={() => void startRecording()}
          >
            <MicIcon />
          </button>
          <textarea
            ref={inputRef}
            className="text"
            rows={1}
            value={draft}
            placeholder="发消息…"
            maxLength={4000}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
              }
            }}
          />
          <button
            className="tool"
            type="button"
            title="表情"
            aria-label="表情"
            onClick={() => {
              setPlusOpen(false)
              setStickerOpen((v) => !v)
            }}
          >
            <SmileIcon />
          </button>
          <button
            className="tool"
            type="button"
            title="更多"
            aria-label="更多功能"
            onClick={() => {
              setStickerOpen(false)
              setPlusOpen((v) => !v)
            }}
          >
            <PlusIcon />
          </button>
          <button className="send" type="button" disabled={!draft.trim() || sending} onClick={() => void send()}>
            发送
          </button>
          </div>
        )}
      </footer>

      {plusOpen ? (
        <PlusMenu
          onPickFile={(file) => void sendAttachment(file)}
          onSticker={() => {
            setPlusOpen(false)
            setStickerOpen(true)
          }}
          onCall={() => {
            setPlusOpen(false)
            flash('通话还没做（P4）')
          }}
          onClose={() => setPlusOpen(false)}
        />
      ) : null}

      {stickerOpen ? (
        <StickerPanel
          items={stickers}
          maxCount={stickerMax}
          loading={stickersLoading}
          error={stickerError}
          onPick={(sticker) => void pickSticker(sticker)}
          onUpload={(file) => void uploadSticker(file)}
          onDelete={(id) => void removeSticker(id)}
          onClose={() => setStickerOpen(false)}
        />
      ) : null}

      {viewer ? <MediaViewer attachment={viewer} onClose={() => setViewer(null)} /> : null}

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
