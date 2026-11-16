import type { StreamEvent } from '@openchat/shared'

export type Sink = (event: StreamEvent) => void

/**
 * SSE 的扇出。
 *
 * 谁在线就往谁那里写一份；写失败（对面关页面了）就当场摘掉，
 * 不让一个坏连接把广播拖住。
 */
export class Hub {
  private readonly sinks = new Set<Sink>()

  add(sink: Sink): () => void {
    this.sinks.add(sink)
    return () => {
      this.sinks.delete(sink)
    }
  }

  publish(event: StreamEvent): void {
    for (const sink of this.sinks) {
      try {
        sink(event)
      } catch {
        this.sinks.delete(sink)
      }
    }
  }

  get size(): number {
    return this.sinks.size
  }
}
