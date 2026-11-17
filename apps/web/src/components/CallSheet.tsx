import type { CallKind } from '@openchat/shared'
import { PhoneIcon, VideoIcon } from './icons'

export function CallSheet({
  onPick,
  onClose,
}: {
  onPick: (kind: CallKind) => void
  onClose: () => void
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet call-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="call-grid">
          <button className="call-choice" type="button" onClick={() => onPick('audio')}>
            <span className="call-icon">
              <PhoneIcon />
            </span>
            <span className="call-label">语音通话</span>
          </button>
          <button className="call-choice" type="button" onClick={() => onPick('video')}>
            <span className="call-icon">
              <VideoIcon />
            </span>
            <span className="call-label">视频通话</span>
          </button>
        </div>
        <p className="sheet-note">现在只是占位：接通、信令、音视频轨道都还没做（P4）</p>
      </div>
    </div>
  )
}
