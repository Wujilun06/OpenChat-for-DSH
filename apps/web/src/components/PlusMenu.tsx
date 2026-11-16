import { useRef } from 'react'
import { FileIcon, ImageIcon, PhoneIcon, SmileIcon } from './icons'

export interface PlusMenuProps {
  onPickFile: (file: File) => void
  onSticker: () => void
  onCall: () => void
  onClose: () => void
}

/** 微信那个「+」下面的四宫格。 */
export function PlusMenu({ onPickFile, onSticker, onCall, onClose }: PlusMenuProps) {
  const mediaRef = useRef<HTMLInputElement | null>(null)
  const fileRef = useRef<HTMLInputElement | null>(null)

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet plus-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="plus-grid">
          <button
            className="plus-item"
            type="button"
            onClick={() => mediaRef.current?.click()}
          >
            <span className="plus-icon">
              <ImageIcon />
            </span>
            <span className="plus-label">图片/视频</span>
          </button>

          <button className="plus-item" type="button" onClick={onSticker}>
            <span className="plus-icon">
              <SmileIcon />
            </span>
            <span className="plus-label">表情</span>
          </button>

          <button className="plus-item" type="button" onClick={() => fileRef.current?.click()}>
            <span className="plus-icon">
              <FileIcon />
            </span>
            <span className="plus-label">文件</span>
          </button>

          <button className="plus-item" type="button" onClick={onCall}>
            <span className="plus-icon">
              <PhoneIcon />
            </span>
            <span className="plus-label">语音/视频</span>
          </button>
        </div>

        <input
          ref={mediaRef}
          type="file"
          accept="image/*,video/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onPickFile(file)
            e.target.value = ''
          }}
        />
        <input
          ref={fileRef}
          type="file"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) onPickFile(file)
            e.target.value = ''
          }}
        />
      </div>
    </div>
  )
}
