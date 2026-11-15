import { useCallback, useEffect, useRef, useState } from 'react'
import type { MeResult } from '@openchat/shared'
import { MicIcon, PhoneIcon, PlusIcon, SmileIcon, VideoIcon } from './icons'

export function ChatShell({ me, onLogout }: { me: MeResult; onLogout: () => void }) {
  const [draft, setDraft] = useState('')
  const [toast, setToast] = useState('')
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
    }
  }, [])

  const flash = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current) clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(''), 1800)
  }, [])

  const send = useCallback(() => {
    if (!draft.trim()) return
    flash('发送功能在 P1 接通')
  }, [draft, flash])

  return (
    <div className="chat">
      <header className="chat-header">
        <h1 className="chat-title">{me.peer.name}</h1>
        <div className="chat-actions">
          <button className="icon-btn" type="button" title="语音通话（预留）" onClick={() => {}}>
            <PhoneIcon />
          </button>
          <button className="icon-btn" type="button" title="视频通话（预留）" onClick={() => {}}>
            <VideoIcon />
          </button>
        </div>
      </header>

      <main className="messages">
        <div className="empty">
          <img className="empty-avatar" src={me.peer.avatar} alt="" />
          <p className="empty-title">还没有消息</p>
          <p className="empty-hint">P0 只搭好了壳，聊天在 P1 接通</p>
          <button className="link" type="button" onClick={() => void onLogout()}>
            退出登录
          </button>
        </div>
      </main>

      <footer className="composer">
        <button className="tool" type="button" disabled title="语音消息（P3）">
          <MicIcon />
        </button>
        <input
          className="text"
          value={draft}
          placeholder="发送在 P1 接通"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send()
            }
          }}
        />
        <button className="tool" type="button" disabled title="表情（P2）">
          <SmileIcon />
        </button>
        <button className="tool" type="button" disabled title="更多（还没做）">
          <PlusIcon />
        </button>
        <button
          className="send"
          type="button"
          disabled={draft.trim().length === 0}
          onClick={send}
        >
          发送
        </button>
      </footer>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  )
}
