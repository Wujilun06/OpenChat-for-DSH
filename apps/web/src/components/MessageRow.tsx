import type { MessageInfo, Sender } from '@openchat/shared'
import { formatClock, formatFull } from '../lib/time'

export interface MessageRowProps {
  message: MessageInfo
  peer: { name: string; avatar: string }
  /** 0 只显示时钟，1 显示完整时间，2 不显示 */
  timeLevel: number
  onCycleTime: (id: string) => void
  onQuote: (message: MessageInfo) => void
}

function nameOf(sender: Sender, peer: { name: string }): string {
  return sender === 'me' ? '我' : peer.name
}

export function MessageRow({
  message,
  peer,
  timeLevel,
  onCycleTime,
  onQuote,
}: MessageRowProps) {
  const isMe = message.sender === 'me'
  const timeText =
    timeLevel === 0 ? formatClock(message.createdAt) : timeLevel === 1 ? formatFull(message.createdAt) : ''

  const cycle = () => onCycleTime(message.id)

  return (
    <div className={`msg ${isMe ? 'me' : 'fish'}`}>
      {isMe ? null : <img className="msg-avatar" src={peer.avatar} alt="" />}

      <div className="msg-body">
        <div className="msg-head">
          {isMe ? (
            <>
              {timeText ? <span className="msg-time">{timeText}</span> : null}
              <button className="msg-name" type="button" onClick={cycle} onContextMenu={(e) => {
                e.preventDefault()
                cycle()
              }}>
                我
              </button>
            </>
          ) : (
            <>
              <button className="msg-name" type="button" onClick={cycle} onContextMenu={(e) => {
                e.preventDefault()
                cycle()
              }}>
                {peer.name}
              </button>
              {timeText ? <span className="msg-time">{timeText}</span> : null}
            </>
          )}
        </div>

        <div
          className="bubble"
          role="button"
          tabIndex={0}
          title="点一下引用这条"
          onClick={() => onQuote(message)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') onQuote(message)
          }}
        >
          {message.replyTo ? (
            <div className="quote">
              <span className="quote-name">{nameOf(message.replyTo.sender, peer)}：</span>
              <span className="quote-text">{message.replyTo.text ?? '[表情]'}</span>
            </div>
          ) : null}
          <div className="bubble-text">{message.text}</div>
        </div>
      </div>

      {isMe ? <div className="msg-avatar me-avatar">我</div> : null}
    </div>
  )
}
