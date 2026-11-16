import { useEffect, useRef } from 'react'
import type { AttachmentInfo, MessageInfo, Sender } from '@openchat/shared'
import { formatClock, formatFull } from '../lib/time'
import { formatBytes, refLabel } from '../lib/preview'
import { FileIcon } from './icons'

export interface MessageRowProps {
  message: MessageInfo
  peer: { name: string; avatar: string }
  /** 0 不显示，1 时分秒，2 年月日时分秒 */
  timeLevel: number
  onCycleTime: (id: string) => void
  /** 右键 / 长按 */
  onQuote: (message: MessageInfo) => void
  /** 点图片或视频看大图 / 播放 */
  onOpenMedia: (attachment: AttachmentInfo) => void
  /** 图加载完再贴一次底 */
  onMediaLoad: () => void
}

function nameOf(sender: Sender, peer: { name: string }): string {
  return sender === 'me' ? '我' : peer.name
}

/** 缩略图大小：长边夹在 180–240 之间，保证比表情（132）明显大。 */
function thumbBox(w: number | null, h: number | null, max = 240, min = 180) {
  if (!w || !h) return { width: max, height: Math.round((max * 2) / 3) }
  const long = Math.max(w, h)
  const target = Math.min(max, Math.max(min, long))
  const k = target / long
  return { width: Math.round(w * k), height: Math.round(h * k) }
}

const LONG_PRESS_MS = 500

function PlayBadge() {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="27" fill="rgba(0,0,0,0.32)" stroke="#fff" strokeWidth="3" />
      <path d="M26.5 20.5v23l18-11.5z" fill="#fff" />
    </svg>
  )
}

export function MessageRow({
  message,
  peer,
  timeLevel,
  onCycleTime,
  onQuote,
  onOpenMedia,
  onMediaLoad,
}: MessageRowProps) {
  const isMe = message.sender === 'me'
  const sticker = message.kind === 'sticker' ? message.sticker : null
  const attachment = message.attachment
  const isImage = message.kind === 'image' && attachment !== null
  const isVideo = message.kind === 'video' && attachment !== null
  const mediaBox = attachment && (isImage || isVideo) ? thumbBox(attachment.w, attachment.h) : null

  const timeText =
    timeLevel === 1 ? formatClock(message.createdAt) : timeLevel === 2 ? formatFull(message.createdAt) : ''

  // 右键引用；手机长按引用；左键/单点不引用（图片单点是看原图）
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fired = useRef(false)
  const pointerType = useRef('')
  const startAt = useRef<{ x: number; y: number } | null>(null)

  const clearPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current)
      pressTimer.current = null
    }
  }

  useEffect(() => clearPress, [])

  const bubbleClass = [
    'bubble',
    sticker ? 'sticker-bubble' : '',
    isImage ? 'image-bubble' : '',
    isVideo ? 'video-bubble' : '',
    message.kind === 'file' ? 'file-bubble' : '',
  ]
    .filter(Boolean)
    .join(' ')

  const hint = isImage || isVideo ? '点开看大图 · 右键/长按引用' : '右键 / 长按引用'

  return (
    <div className={`msg ${isMe ? 'me' : 'fish'}`}>
      {isMe ? null : <img className="msg-avatar" src={peer.avatar} alt="" />}

      <div className="msg-body">
        <div className="msg-head">
          {isMe ? (
            <>
              {timeText ? <span className="msg-time">{timeText}</span> : null}
              <button
                className="msg-name"
                type="button"
                onClick={() => onCycleTime(message.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  onCycleTime(message.id)
                }}
              >
                我
              </button>
            </>
          ) : (
            <>
              <button
                className="msg-name"
                type="button"
                onClick={() => onCycleTime(message.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  onCycleTime(message.id)
                }}
              >
                {peer.name}
              </button>
              {timeText ? <span className="msg-time">{timeText}</span> : null}
            </>
          )}
        </div>

        <div
          className={bubbleClass}
          role="button"
          tabIndex={0}
          title={hint}
          onPointerDown={(e) => {
            pointerType.current = e.pointerType
            startAt.current = { x: e.clientX, y: e.clientY }
            fired.current = false
            if (e.pointerType === 'touch' || e.pointerType === 'pen') {
              clearPress()
              pressTimer.current = setTimeout(() => {
                fired.current = true
                onQuote(message)
              }, LONG_PRESS_MS)
            }
          }}
          onPointerMove={(e) => {
            const start = startAt.current
            if (!start) return
            if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) clearPress()
          }}
          onPointerUp={clearPress}
          onPointerCancel={clearPress}
          onPointerLeave={clearPress}
          onContextMenu={(e) => {
            e.preventDefault()
            clearPress()
            // 手机上长按也会触发 contextmenu，交给上面的计时器处理
            if (pointerType.current === 'touch' || pointerType.current === 'pen') return
            onQuote(message)
          }}
          onClick={() => {
            if (fired.current) {
              fired.current = false
              return
            }
            if ((isImage || isVideo) && attachment) onOpenMedia(attachment)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onQuote(message)
          }}
        >
          {message.replyTo ? (
            <div className="quote">
              <span className="quote-name">{nameOf(message.replyTo.sender, peer)}：</span>
              <span className="quote-text">{refLabel(message.replyTo)}</span>
            </div>
          ) : null}

          {sticker ? (
            <img
              className="sticker-img"
              src={sticker.fileUrl}
              width={sticker.w}
              height={sticker.h}
              alt="表情"
              onLoad={onMediaLoad}
            />
          ) : isImage && attachment ? (
            <img
              className="image-img"
              src={attachment.thumbUrl ?? attachment.fileUrl}
              style={mediaBox ?? undefined}
              alt={attachment.name}
              onLoad={onMediaLoad}
            />
          ) : isVideo && attachment ? (
            <div className="video-thumb" style={mediaBox ?? undefined}>
              {attachment.thumbUrl ? (
                <img
                  className="video-thumb-img"
                  src={attachment.thumbUrl}
                  alt={attachment.name}
                  onLoad={onMediaLoad}
                />
              ) : (
                <div className="video-fallback" />
              )}
              <span className="play-badge">
                <PlayBadge />
              </span>
            </div>
          ) : message.kind === 'file' && attachment ? (
            <a
              className="file-card"
              href={attachment.fileUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
            >
              <span className="file-icon">
                <FileIcon />
              </span>
              <span className="file-meta">
                <span className="file-name">{attachment.name}</span>
                <span className="file-size">{formatBytes(attachment.bytes)}</span>
              </span>
            </a>
          ) : (
            <div className="bubble-text">{message.text}</div>
          )}
        </div>
      </div>

      {isMe ? <div className="msg-avatar me-avatar">我</div> : null}
    </div>
  )
}
