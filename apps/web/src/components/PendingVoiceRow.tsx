import { MicIcon } from './icons'
import { formatVoiceSeconds } from '../lib/time'

/** 录音已经发上去、还在转写时的那一条占位。 */
export function PendingVoiceRow({ voiceMs }: { voiceMs: number }) {
  const width = Math.min(160, Math.max(90, 70 + Math.round(voiceMs / 1000) * 4))

  return (
    <div className="msg me">
      <div className="msg-body">
        <div className="msg-head">
          <button className="msg-name" type="button" disabled>
            我
          </button>
        </div>

        <div className="bubble voice-bubble" style={{ width: `${width}px` }}>
          <span className="voice-inner">
            <MicIcon width={17} height={17} />
            <span className="voice-sec">{formatVoiceSeconds(voiceMs)}</span>
          </span>
        </div>

        <div className="voice-text voice-text-pending">
          <span className="spinner" aria-hidden="true" />
          语音转文字中
        </div>
      </div>
      <div className="msg-avatar me-avatar">我</div>
    </div>
  )
}
