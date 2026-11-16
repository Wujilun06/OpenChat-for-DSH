import type { DatabaseSync } from 'node:sqlite'
import type { Hub } from './hub.js'
import { createMessage } from './messages.js'

export interface MockConfig {
  enabled: boolean
  /** 2 秒内连发的并成一轮。 */
  mergeWindowMs: number
  /** 显示「正在输入」多久之后再出字。 */
  typingMs: number
  /** 回答分几段时，段与段之间隔多久。 */
  gapMs: number
}

/**
 * 假鱼回声。
 *
 * P1 还没接 DSH，得有个东西回话，不然聊天空着看不出对错。
 * 它只认这几件事：合并窗口、正在输入、分段落库。
 * 接上 DSH 之后把 config.mock.enabled 关掉就行，代码不用动。
 */
export class MockFish {
  private batch: string[] = []
  private mergeTimer: NodeJS.Timeout | null = null
  private busy = false
  private readonly timers = new Set<NodeJS.Timeout>()
  private stopped = false

  constructor(
    private readonly deps: {
      db: DatabaseSync
      hub: Hub
      convId: string
      config: MockConfig
    },
  ) {}

  /** 用户说了一句：先攒着，窗口到了再一起答。 */
  note(text: string): void {
    if (!this.deps.config.enabled || this.stopped) return
    this.batch.push(text)
    if (this.busy || this.mergeTimer) return
    this.mergeTimer = setTimeout(() => this.startTurn(), this.deps.config.mergeWindowMs)
    this.timers.add(this.mergeTimer)
  }

  stop(): void {
    this.stopped = true
    if (this.mergeTimer) clearTimeout(this.mergeTimer)
    this.mergeTimer = null
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.batch = []
    if (this.busy) {
      this.busy = false
      this.publishTyping(false)
    }
  }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (!this.stopped) fn()
    }, ms)
    this.timers.add(timer)
  }

  private publishTyping(on: boolean): void {
    this.deps.hub.publish({ type: 'typing.changed', data: { who: 'fish', on } })
  }

  private startTurn(): void {
    if (this.mergeTimer) {
      this.timers.delete(this.mergeTimer)
      this.mergeTimer = null
    }
    if (this.stopped || this.busy || this.batch.length === 0) return

    this.busy = true
    const texts = this.batch.splice(0)
    this.publishTyping(true)
    this.later(() => this.reply(texts), this.deps.config.typingMs)
  }

  private reply(texts: string[]): void {
    const parts = buildParts(texts)
    parts.forEach((text, index) => {
      this.later(() => {
        createMessage(this.deps.db, this.deps.hub, {
          convId: this.deps.convId,
          sender: 'fish',
          kind: 'text',
          text,
          source: 'mock',
        })
      }, index * this.deps.config.gapMs)
    })

    const settleAt = (parts.length - 1) * this.deps.config.gapMs + 60
    this.later(() => {
      this.busy = false
      this.publishTyping(false)
      if (this.batch.length > 0 && !this.mergeTimer) {
        this.mergeTimer = setTimeout(() => this.startTurn(), this.deps.config.mergeWindowMs)
        this.timers.add(this.mergeTimer)
      }
    }, settleAt)
  }
}

function buildParts(_texts: string[]): string[] {
  // 那句「收到：…」拿掉了 —— 它只是回声，看着像在复读。
  return ['这条是占位回答，接上 DSH 以后就换成真的了。']
}
