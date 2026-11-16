import { useEffect, useMemo, useState } from 'react'
import type { AttachmentInfo } from '@openchat/shared'
import { CloseIcon } from './icons'

/**
 * 看大图 / 播视频。
 *
 * 尺寸按画幅算：先按 94% 宽、88% 高塞满，能放多大放多大；
 * 小图也放大，不然点开还看不清。
 */
export function MediaViewer({
  attachment,
  onClose,
}: {
  attachment: AttachmentInfo
  onClose: () => void
}) {
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))

  useEffect(() => {
    const onResize = () => setView({ w: window.innerWidth, h: window.innerHeight })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('resize', onResize)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('resize', onResize)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const mediaStyle = useMemo(() => {
    const maxW = view.w * 0.94
    const maxH = view.h * 0.88
    if (attachment.w && attachment.h) {
      const fit = Math.min(maxW / attachment.w, maxH / attachment.h)
      return {
        width: `${Math.round(attachment.w * fit)}px`,
        height: `${Math.round(attachment.h * fit)}px`,
      }
    }
    return { width: `${Math.round(maxW)}px`, maxHeight: `${Math.round(maxH)}px` }
  }, [attachment.w, attachment.h, view])

  return (
    <div className="viewer" onClick={onClose}>
      <button className="viewer-close" type="button" aria-label="关掉" onClick={onClose}>
        <CloseIcon width={22} height={22} />
      </button>

      {attachment.kind === 'video' ? (
        <video
          className="viewer-media"
          src={attachment.fileUrl}
          style={mediaStyle}
          controls
          autoPlay
          playsInline
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <img
          className="viewer-media"
          src={attachment.fileUrl}
          alt={attachment.name}
          style={mediaStyle}
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  )
}
