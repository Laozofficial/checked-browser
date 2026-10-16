import type { Batch, CheckedEvent } from './types'
import { byteLength } from './utils'

export const MAX_BATCH = 50
export const MAX_BODY_BYTES = 60 * 1024
export const MAX_QUEUE = 200
export const MAX_ATTEMPTS = 5
export const MAX_BACKOFF_MS = 60_000
export const FLUSH_AT = 10

type SendResult = { kind: 'ok' } | { kind: 'drop' } | { kind: 'retry'; retryAfterMs?: number }

export interface TransportConfig {
  url: string
  key: string
  sdk: { name: string; version: string }
  flushIntervalMs: number
  fetchImpl: typeof fetch | undefined
  log: (...args: unknown[]) => void
}

export class Transport {
  private queue: CheckedEvent[] = []
  private dropped = 0
  private failures = 0
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private chain: Promise<boolean> = Promise.resolve(true)
  private closed = false

  constructor(private cfg: TransportConfig) {}

  get size(): number {
    return this.queue.length
  }

  get droppedCount(): number {
    return this.dropped
  }

  countDropped(n = 1): void {
    this.dropped += n
  }

  enqueue(event: CheckedEvent): void {
    if (this.closed) return
    this.queue.push(event)
    while (this.queue.length > MAX_QUEUE) {
      this.queue.shift()
      this.dropped++
    }
    if (this.queue.length >= FLUSH_AT && !this.retryTimer && this.isOnline()) {
      void this.flush()
    } else {
      this.scheduleFlush()
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.closed) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      void this.flush()
    }, this.cfg.flushIntervalMs)
  }

  isOnline(): boolean {
    try {
      return typeof navigator === 'undefined' || navigator.onLine !== false
    } catch {
      return true
    }
  }

  /** Called from the window 'online' event. */
  onOnline(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    void this.flush()
  }

  /** Send everything queued. Resolves true when the queue was fully delivered. */
  flush(): Promise<boolean> {
    this.chain = this.chain.then(
      () => this.drain(),
      () => this.drain(),
    )
    return this.chain
  }

  private async drain(): Promise<boolean> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    while (this.queue.length) {
      if (!this.isOnline()) {
        this.cfg.log('offline, holding', this.queue.length, 'events')
        return false
      }
      if (this.retryTimer) return false
      const { batch, body, droppedSent } = this.takeBatch()
      if (!batch.length) continue
      const res = await this.send(body)
      if (res.kind === 'ok') {
        this.failures = 0
        this.dropped = Math.max(0, this.dropped - droppedSent)
        continue
      }
      if (res.kind === 'drop') {
        this.failures = 0
        this.cfg.log('batch rejected, dropping', batch.length, 'events')
        this.dropped = Math.max(0, this.dropped - droppedSent) + batch.length
        continue
      }
      this.failures++
      if (this.failures >= MAX_ATTEMPTS) {
        this.cfg.log('giving up after', this.failures, 'attempts')
        this.failures = 0
        this.dropped += batch.length
        continue
      }
      // Put the batch back at the front, cap the queue, wait.
      this.queue = batch.concat(this.queue)
      while (this.queue.length > MAX_QUEUE) {
        this.queue.shift()
        this.dropped++
      }
      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, this.failures - 1))
      const delay = res.retryAfterMs !== undefined ? Math.min(MAX_BACKOFF_MS, Math.max(0, res.retryAfterMs)) : backoff
      this.cfg.log('retrying in', delay, 'ms')
      if (!this.closed) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          void this.flush()
        }, delay)
      }
      return false
    }
    return true
  }

  /** Take up to MAX_BATCH events whose serialized body stays under MAX_BODY_BYTES. */
  private takeBatch(): { batch: CheckedEvent[]; body: string; droppedSent: number } {
    let count = Math.min(MAX_BATCH, this.queue.length)
    const droppedSent = this.dropped
    while (count > 0) {
      const batch = this.queue.slice(0, count)
      const body = this.serialize(batch, droppedSent)
      if (byteLength(body) <= MAX_BODY_BYTES) {
        this.queue.splice(0, count)
        return { batch, body, droppedSent }
      }
      if (count === 1) {
        // A single event too big to ever send. Drop it.
        this.queue.shift()
        this.dropped++
        return { batch: [], body: '', droppedSent: 0 }
      }
      count = Math.max(1, Math.floor(count / 2))
    }
    return { batch: [], body: '', droppedSent: 0 }
  }

  private serialize(events: CheckedEvent[], dropped: number): string {
    const batch: Batch = {
      key: this.cfg.key,
      sdk: this.cfg.sdk,
      sentAt: Date.now(),
      client: { dropped },
      events,
    }
    return JSON.stringify(batch)
  }

  private async send(body: string): Promise<SendResult> {
    const f = this.cfg.fetchImpl
    if (!f) return { kind: 'drop' }
    let res: Response
    try {
      res = await f(this.cfg.url, {
        method: 'POST',
        body,
        keepalive: true,
        credentials: 'omit',
        mode: 'cors',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      })
    } catch (e) {
      this.cfg.log('send failed', e)
      return { kind: 'retry' }
    }
    const status = res.status
    if (status >= 200 && status < 300) return { kind: 'ok' }
    if (status === 429) {
      let retryAfterMs: number | undefined
      try {
        const h = res.headers && res.headers.get('Retry-After')
        const secs = h ? Number(h) : NaN
        if (isFinite(secs) && secs >= 0) retryAfterMs = secs * 1000
      } catch {
        /* header not readable */
      }
      return { kind: 'retry', retryAfterMs }
    }
    if (status >= 500) return { kind: 'retry' }
    return { kind: 'drop' }
  }

  /**
   * Page is going away: hand everything to sendBeacon (or fetch keepalive),
   * ignoring backoff. Best effort, no retries.
   */
  flushOnHide(): void {
    if (!this.queue.length || !this.isOnline()) return
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    while (this.queue.length) {
      const { batch, body, droppedSent } = this.takeBatch()
      if (!batch.length) continue
      let queued = false
      try {
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
          queued = navigator.sendBeacon(this.cfg.url, new Blob([body], { type: 'text/plain;charset=UTF-8' }))
        }
      } catch {
        queued = false
      }
      if (!queued) {
        void this.send(body)
      }
      this.dropped = Math.max(0, this.dropped - droppedSent)
    }
  }

  close(): void {
    this.closed = true
    if (this.flushTimer) clearTimeout(this.flushTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.flushTimer = null
    this.retryTimer = null
  }
}
