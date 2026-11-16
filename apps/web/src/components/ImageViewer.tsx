import { useEffect } from 'react'
import type { AttachmentInfo } from '@openchat/shared'
import { CloseIcon } from './icons'

/** 点图片看原图。 */
export function ImageViewer({
  attachment,
  onClose,
}: {
  attachment: AttachmentInfo
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="viewer" onClick={onClose}>
      <button className="viewer-close" type="button" aria-label="关掉" onClick={onClose}>
        <CloseIcon width={22} height={22} />
      </button>
      <img src={attachment.fileUrl} alt={attachment.name} onClick={(e) => e.stopPropagation()} />
    </div>
  )
}
