import { useRef, useState } from 'react'
import type { StickerInfo } from '@openchat/shared'
import { CloseIcon, PlusIcon } from './icons'

export interface StickerPanelProps {
  items: StickerInfo[]
  maxCount: number
  loading: boolean
  error: string
  onPick: (sticker: StickerInfo) => void
  onUpload: (file: File) => void
  onDelete: (id: string) => void
  onClose: () => void
}

const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif'

export function StickerPanel({
  items,
  maxCount,
  loading,
  error,
  onPick,
  onUpload,
  onDelete,
  onClose,
}: StickerPanelProps) {
  const [manage, setManage] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)

  const full = items.length >= maxCount

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <span>
            表情 {items.length}/{maxCount}
          </span>
          <div className="sheet-head-actions">
            {items.length > 0 ? (
              <button type="button" onClick={() => setManage((v) => !v)}>
                {manage ? '完成' : '管理'}
              </button>
            ) : null}
            <button type="button" className="sheet-close" aria-label="关掉" onClick={onClose}>
              <CloseIcon width={18} height={18} />
            </button>
          </div>
        </div>

        <div className="sticker-grid">
          {full ? null : (
            <button
              className="sticker-add"
              type="button"
              title="加一个表情"
              onClick={() => fileRef.current?.click()}
            >
              <PlusIcon width={28} height={28} />
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept={ACCEPT}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) onUpload(file)
              e.target.value = ''
            }}
          />

          {items.map((sticker) => (
            <button
              key={sticker.id}
              className={`sticker-tile${manage ? ' managing' : ''}`}
              type="button"
              title={manage ? '删掉这个' : '发这个'}
              onClick={() => {
                if (!manage) {
                  onPick(sticker)
                  return
                }
                if (window.confirm('删掉这个表情？历史消息里还会留着')) onDelete(sticker.id)
              }}
            >
              <img src={sticker.thumbUrl} alt="" loading="lazy" />
              {sticker.animated ? <span className="gif-badge">GIF</span> : null}
              {manage ? (
                <span className="tile-x">
                  <CloseIcon width={11} height={11} />
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {loading ? <p className="sheet-note">读表情…</p> : null}
        {error ? <p className="sheet-note error">{error}</p> : null}
        {!loading && !error && items.length === 0 ? (
          <p className="sheet-note">还没有表情，点上面的 + 加一个（jpg / png / webp / gif，单张 5MB 内）</p>
        ) : null}
      </div>
    </div>
  )
}
