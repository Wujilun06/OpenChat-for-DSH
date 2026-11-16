import type { MessageRef } from '@openchat/shared'

/** 引用回复那一行只显示一句话，这里统一决定显示什么。 */
export function refLabel(ref: MessageRef): string {
  if (ref.text) return ref.text
  switch (ref.kind) {
    case 'sticker':
      return '[表情]'
    case 'image':
      return '[图片]'
    case 'video':
      return '[视频]'
    case 'file':
      return '[文件]'
    case 'voice':
      return '[语音]'
    default:
      return '[消息]'
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
