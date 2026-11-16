function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 第一档：时分秒。 */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 第二档：年月日时分秒。 */
export function formatFull(ts: number): string {
  const d = new Date(ts)
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}

/** 录音计时：0:07 这种。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${pad(seconds)}`
}

/** 语音气泡上那个秒数。 */
export function formatVoiceSeconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}″`
}
