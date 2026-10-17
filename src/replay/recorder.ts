/**
 * The session replay recorder: rrweb plus Check’d's privacy defaults, a rolling buffer and a
 * chunked, compressed upload to POST /api/v1/ingest/replay.
 *
 * Modes, decided once per tab session (sessionStorage) from the sample rates:
 *   buffer   keep the last 30 to 60 seconds in memory (two 30 second segments, each starting
 *            with a full snapshot). Nothing leaves the page unless an error or failed request
 *            is captured; then the buffer is uploaded and recording continues as "session".
 *   session  upload as it goes, every 10 seconds, until the page closes or the length cap.
 *   off      not sampled, or Do Not Track is on. Nothing is recorded.
 *
 * Privacy defaults: every input, textarea and select is masked (passwords always show a fixed
 * mask, so not even their length leaks); `[data-checked-mask]` (or maskAllText) masks text;
 * `[data-checked-block]` elements are replaced by placeholders; no canvas, no cross-origin
 * iframes, no inlined images or fonts; page addresses lose their query strings.
 */
import type { ReplayHost, ReplayMarkDetail, ReplayRecorder } from '../replay'
import { randomId, stripQuery, truncate } from '../utils'
import { clickTarget, describe, type DescribeRules } from './describe'
import { Scrubber } from './scrub'
import { SDK_NAME, SDK_VERSION } from '../version'

export const REPLAY_LIMITS = {
  /** Buffer mode: a new full snapshot (and segment) every 30s; two segments are kept. */
  bufferSegmentMs: 30_000,
  /** Session mode: a full snapshot every 5 minutes so the player can seek. */
  sessionCheckoutMs: 5 * 60_000,
  flushMs: 10_000,
  /** Uncompressed JSON per chunk; the server caps a chunk body at 1 MB. */
  chunkRawBytes: 900_000,
  keepaliveBytes: 60_000,
  maxPendingEvents: 3_000,
  maxBufferEvents: 20_000,
  idleMs: 30 * 60_000,
  attempts: 3,
  backoffMs: 1_000,
}

const STORE_KEY = 'checked.replay'
const META = 4

type Mode = 'off' | 'buffer' | 'session'
type RREvent = { type: number; data: any; timestamp: number }
interface Stored {
  sid: string
  mode: Mode
  origin?: Mode
  id?: string
  seq?: number
  start?: number
  last?: number
}

/** The parts of rrweb the recorder uses; tests can pass their own. */
export interface RecordApi {
  record(options: Record<string, unknown>): (() => void) | undefined
  addCustomEvent(tag: string, payload: unknown): void
  takeFullSnapshot(isCheckout?: boolean): void
}

export function doNotTrack(): boolean {
  try {
    const n = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string }
    const w = window as Window & { doNotTrack?: string }
    return n.doNotTrack === '1' || w.doNotTrack === '1' || n.msDoNotTrack === '1' || n.globalPrivacyControl === true
  } catch {
    return false
  }
}

const clamp01 = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? Math.min(1, Math.max(0, v)) : d)
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** gzip + base64 through CompressionStream. Null when the browser cannot. */
export async function gzipBase64(text: string): Promise<string | null> {
  try {
    const CS = (globalThis as { CompressionStream?: new (f: string) => GenericTransformStream }).CompressionStream
    if (!CS || typeof Blob === 'undefined' || typeof Response === 'undefined' || typeof btoa === 'undefined') return null
    const blob = new Blob([text])
    if (typeof blob.stream !== 'function') return null
    const out = new Uint8Array(await new Response(blob.stream().pipeThrough(new CS('gzip') as unknown as TransformStream)).arrayBuffer())
    let bin = ''
    for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.prototype.slice.call(out.subarray(i, i + 0x8000)) as number[])
    return btoa(bin)
  } catch {
    return null
  }
}

export class Recorder implements ReplayRecorder {
  mode: Mode = 'off'
  /** How this replay started (buffer = kept until an error), reported to the server. */
  private origin: Mode = 'off'
  private id: string | null = null
  private seq = 0
  private startedAt = 0
  private segments: RREvent[][] = [[], []]
  private pending: RREvent[] = []
  private stopRecording: (() => void) | null = null
  private timers: Array<ReturnType<typeof setInterval>> = []
  private chain: Promise<unknown> = Promise.resolve()
  private stopped = false
  private rejected = false
  private started = false
  private uninstallers: Array<() => void> = []
  private scrubber: Scrubber
  private rules: DescribeRules
  private lastPath = ''
  private sampleRate: number
  private onErrorSampleRate: number
  private maxMs: number

  constructor(
    private host: ReplayHost,
    private api: RecordApi
  ) {
    const o = host.options || {}
    this.sampleRate = clamp01(o.sampleRate, 0)
    this.onErrorSampleRate = clamp01(o.onErrorSampleRate, 1)
    this.maxMs = Math.max(1, Math.min(240, typeof o.maxDurationMinutes === 'number' ? o.maxDurationMinutes : 60)) * 60_000
    this.scrubber = new Scrubber(host.client.opts.captureQueryStrings)
    this.rules = {
      maskSelector: '[data-checked-mask]' + (o.maskSelector ? ',' + o.maskSelector : ''),
      blockSelector: '[data-checked-block]' + (o.blockSelector ? ',' + o.blockSelector : ''),
      maskAllText: !!o.maskAllText,
      stripUrl: (u) => (host.client.opts.captureQueryStrings ? u : stripQuery(u)),
    }
  }

  get replayId(): string | null {
    return this.mode === 'off' || this.stopped ? null : this.id
  }

  // ------------------------------------------------------------- lifecycle

  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    try {
      if (doNotTrack()) {
        this.host.client.log('replay off: Do Not Track')
        return
      }
      this.decide()
      if (this.mode === 'off') return
      const o = this.host.options || {}
      const stop = this.api.record({
        emit: (e: RREvent, isCheckout?: boolean) => this.onEvent(e, isCheckout),
        maskAllInputs: true,
        maskInputFn: (text: string, el?: HTMLElement) => (el && (el.getAttribute('type') || '').toLowerCase() === 'password' ? '********' : '*'.repeat(Math.min(String(text || '').length, 40))),
        maskTextSelector: this.rules.maskAllText ? '*' : this.rules.maskSelector,
        blockSelector: this.rules.blockSelector,
        recordCanvas: !!o.recordCanvas,
        recordCrossOriginIframes: false,
        inlineImages: false,
        collectFonts: false,
        inlineStylesheet: true,
        slimDOMOptions: 'all',
        sampling: { mousemove: 100, scroll: 150, media: 800, input: 'last' },
        errorHandler: () => true,
      })
      this.stopRecording = stop || null
      this.installListeners()
      this.scheduleCheckout()
      if (this.mode === 'session') this.startFlushTimer()
      this.action({ a: 'nav', url: this.pageUrl(), cause: 'load' })
      this.host.client.log('replay recording', this.mode, this.id)
    } catch (e) {
      this.host.client.log('replay failed to start', e)
      this.stop()
    }
  }

  /**
   * Stops recording. Session mode uploads what it still holds as the final chunk, unless the
   * server refused the replay (rejected), in which case nothing more is sent.
   */
  stop(reason?: string, rejected = false): void {
    if (this.stopped) return
    if (rejected) this.rejected = true
    const flushLast = this.mode === 'session' && this.started && !rejected
    try {
      if (flushLast) void this.sendPending('stop', true)
    } catch {
      /* ignore */
    }
    this.stopped = true
    try {
      if (this.stopRecording) this.stopRecording()
    } catch {
      /* ignore */
    }
    this.stopRecording = null
    for (const t of this.timers.splice(0)) clearInterval(t)
    for (const u of this.uninstallers.splice(0)) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.segments = [[], []]
    if (reason) {
      this.host.client.log('replay stopped:', reason)
      // The server said no (quota, length, key): do not try again on the next page of this session.
      this.persist('off')
    }
  }

  flush(reason: string, detail?: ReplayMarkDetail): Promise<string | null> {
    try {
      if (!this.id || this.mode === 'off' || this.stopped || !this.started) return Promise.resolve(null)
      const id = this.id
      if (detail) this.action({ a: reason === 'request' ? 'request' : 'error', message: truncate(String(detail.message || ''), 300), eventId: String(detail.eventId || '').slice(0, 40) })
      if (this.mode === 'buffer') {
        const events = this.segments[0].concat(this.segments[1])
        this.segments = [[], []]
        this.mode = 'session'
        this.startedAt = events.length ? events[0].timestamp : Date.now()
        this.persist()
        this.scheduleCheckout()
        this.startFlushTimer()
        return this.enqueue(events, false, reason).then(() => id)
      }
      return this.sendPending(reason).then(() => id)
    } catch {
      return Promise.resolve(null)
    }
  }

  // --------------------------------------------------------------- sampling

  private read(): Stored | null {
    try {
      const raw = window.sessionStorage.getItem(STORE_KEY)
      const s = raw ? JSON.parse(raw) : null
      return s && typeof s.sid === 'string' ? s : null
    } catch {
      return null
    }
  }

  private persist(mode: Mode = this.mode): void {
    try {
      const s: Stored = { sid: this.host.client.sessionId(), mode }
      if (mode === 'session' && this.id) {
        s.id = this.id
        s.origin = this.origin
        s.seq = this.seq
        s.start = this.startedAt
        s.last = Date.now()
      }
      window.sessionStorage.setItem(STORE_KEY, JSON.stringify(s))
    } catch {
      /* in memory only */
    }
  }

  private decide(): void {
    const sid = this.host.client.sessionId()
    const s = this.read()
    const now = Date.now()
    if (s && s.sid === sid) {
      if (s.mode === 'session' && s.id && /^[a-f0-9]{32}$/.test(s.id) && now - (s.last || 0) < REPLAY_LIMITS.idleMs && now - (s.start || 0) < this.maxMs) {
        // The same tab session moved to a new page: keep adding to the same replay.
        this.mode = 'session'
        this.origin = s.origin === 'buffer' ? 'buffer' : 'session'
        this.id = s.id
        this.seq = Math.max(0, Number(s.seq) || 0)
        this.startedAt = Number(s.start) || now
        return
      }
      if (s.mode === 'off' || s.mode === 'buffer') {
        this.mode = s.mode
        this.origin = s.mode
        if (this.mode === 'buffer') this.fresh(now)
        return
      }
    }
    this.mode = Math.random() < this.sampleRate ? 'session' : Math.random() < this.onErrorSampleRate ? 'buffer' : 'off'
    this.origin = this.mode
    if (this.mode !== 'off') this.fresh(now)
    this.persist()
  }

  private fresh(now: number) {
    this.id = randomId(16)
    this.seq = 0
    this.startedAt = now
  }

  // ------------------------------------------------------------------ events

  private onEvent(e: RREvent, isCheckout?: boolean): void {
    if (this.stopped || !e) return
    const ev = this.scrubber.scrub(e)
    if (this.mode === 'buffer') {
      if (isCheckout && ev.type === META) this.segments = [this.segments[1], []]
      this.segments[1].push(ev)
      if (this.segments[1].length > REPLAY_LIMITS.maxBufferEvents) this.checkout()
    } else if (this.mode === 'session') {
      this.pending.push(ev)
      if (this.pending.length >= REPLAY_LIMITS.maxPendingEvents) void this.sendPending('size')
    }
  }

  private action(payload: Record<string, unknown>): void {
    if (this.stopped || this.mode === 'off') return
    try {
      this.api.addCustomEvent('checked', payload)
    } catch {
      /* not recording yet */
    }
  }

  private checkout(): void {
    try {
      this.api.takeFullSnapshot(true)
    } catch {
      /* ignore */
    }
  }

  private scheduleCheckout(): void {
    for (const t of this.timers.splice(0)) clearInterval(t)
    this.timers.push(setInterval(() => this.checkout(), this.mode === 'buffer' ? REPLAY_LIMITS.bufferSegmentMs : REPLAY_LIMITS.sessionCheckoutMs))
  }

  private startFlushTimer(): void {
    this.timers.push(
      setInterval(() => {
        if (Date.now() - this.startedAt > this.maxMs) return this.stop('length cap')
        void this.sendPending('interval')
      }, REPLAY_LIMITS.flushMs)
    )
  }

  private pageUrl(): string {
    try {
      return this.rules.stripUrl(location.href).slice(0, 1000)
    } catch {
      return ''
    }
  }

  private installListeners(): void {
    const doc = document
    const on = (target: EventTarget, type: string, fn: (e: Event) => void) => {
      const h = (e: Event) => {
        try {
          fn(e)
        } catch {
          /* never break the page */
        }
      }
      target.addEventListener(type, h, { capture: true, passive: true } as AddEventListenerOptions)
      this.uninstallers.push(() => target.removeEventListener(type, h, { capture: true } as EventListenerOptions))
    }
    const textField = (el: Element) => {
      const t = el.tagName.toLowerCase()
      const ty = (el.getAttribute('type') || 'text').toLowerCase()
      return t === 'textarea' || (t === 'input' && ['submit', 'button', 'reset', 'image', 'checkbox', 'radio', 'file', 'hidden', 'range', 'color'].indexOf(ty) < 0)
    }
    on(doc, 'click', (e) => {
      const el = clickTarget(e.target as Element)
      if (!el) return
      const t = el.tagName.toLowerCase()
      const ty = (el.getAttribute('type') || '').toLowerCase()
      // Focusing a field is not an action, and checkboxes report through "change".
      if (textField(el) || t === 'select' || (t === 'input' && (ty === 'checkbox' || ty === 'radio'))) return
      // A label only forwards the click to its field, which reports its own change.
      if (t === 'label' && (el as HTMLLabelElement).control) return
      this.action({ a: 'click', el: describe(el, this.rules) })
    })
    on(doc, 'change', (e) => {
      const el = e.target as HTMLInputElement
      if (!el || !el.tagName) return
      const t = el.tagName.toLowerCase()
      const ty = (el.getAttribute('type') || '').toLowerCase()
      if (t === 'input' && (ty === 'checkbox' || ty === 'radio')) return this.action({ a: 'check', el: describe(el, this.rules), checked: !!el.checked })
      if (t === 'select') return this.action({ a: 'select', el: describe(el, this.rules) })
      if (!textField(el)) return
      // Never the value. Passwords do not even report their length.
      if (ty === 'password') return this.action({ a: 'input', el: describe(el, this.rules), secret: true })
      this.action({ a: 'input', el: describe(el, this.rules), n: String(el.value || '').length })
    })
    on(doc, 'keydown', (e) => {
      const k = e as KeyboardEvent
      const el = k.target as Element
      if (k.key !== 'Enter' || !el || !el.tagName || el.tagName.toLowerCase() !== 'input') return
      this.action({ a: 'press', key: 'Enter', el: describe(el, this.rules) })
    })
    on(doc, 'submit', (e) => {
      const el = e.target as Element
      if (el && el.tagName) this.action({ a: 'submit', el: describe(el, this.rules) })
    })

    // Page changes inside a single page app.
    this.lastPath = this.pageUrl()
    const nav = (cause: string) => {
      const url = this.pageUrl()
      if (url === this.lastPath) return
      this.lastPath = url
      this.action({ a: 'nav', url, cause })
    }
    const h = window.history
    for (const m of ['pushState', 'replaceState'] as const) {
      const orig = h[m]
      if (typeof orig !== 'function') continue
      const wrapped = function (this: History, ...args: Parameters<History['pushState']>) {
        const r = orig.apply(this, args)
        try {
          nav(m === 'pushState' ? 'push' : 'replace')
        } catch {
          /* ignore */
        }
        return r
      }
      h[m] = wrapped
      this.uninstallers.push(() => {
        if (h[m] === wrapped) h[m] = orig
      })
    }
    on(window, 'popstate', () => nav('back'))

    // Leaving or hiding the page: send what session mode holds, with keepalive when small.
    const hide = () => {
      if (this.mode === 'session') void this.sendPending('hide', false, true)
    }
    on(window, 'pagehide', hide)
    on(doc, 'visibilitychange', () => {
      if (document.visibilityState === 'hidden') hide()
    })
  }

  // ----------------------------------------------------------------- upload

  private sendPending(reason: string, final = false, hide = false): Promise<unknown> {
    if (!this.pending.length && !final) return this.chain
    const events = this.pending
    this.pending = []
    return this.enqueue(events, final, reason, hide)
  }

  /** Splits into chunks under the raw size cap and sends them in order. */
  private enqueue(events: RREvent[], final: boolean, reason: string, hide = false): Promise<unknown> {
    const chunks: string[][] = []
    let cur: string[] = []
    let size = 0
    for (const e of events) {
      let s: string
      try {
        s = JSON.stringify(e)
      } catch {
        continue
      }
      if (cur.length && size + s.length > REPLAY_LIMITS.chunkRawBytes) {
        chunks.push(cur)
        cur = []
        size = 0
      }
      cur.push(s)
      size += s.length + 1
    }
    if (cur.length || final) chunks.push(cur)
    chunks.forEach((c, i) => {
      const isFinal = final && i === chunks.length - 1
      const json = '[' + c.join(',') + ']'
      const seq = this.seq++
      if (hide) void this.sendChunk(json, seq, isFinal, reason, true)
      else this.chain = this.chain.then(() => this.sendChunk(json, seq, isFinal, reason, false)).catch(() => null)
    })
    this.persist()
    return this.chain
  }

  private envelope(seq: number, final: boolean, reason: string, encoding: string): string {
    const ctx = this.host.client.context() || {}
    const user = this.host.client.getUser() || ({} as { anonymousId?: string; id?: string })
    return JSON.stringify({
      key: this.host.client.key,
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      replay: {
        id: this.id,
        seq,
        final,
        mode: this.origin,
        reason,
        startedAt: this.startedAt,
        sessionId: this.host.client.sessionId(),
        environment: this.host.client.opts.environment,
        release: this.host.client.opts.release,
        url: this.pageUrl(),
        user: { anonymousId: user.anonymousId, id: user.id },
        context: { browser: ctx.browser, os: ctx.os, device: ctx.device, viewport: ctx.viewport },
      },
      encoding,
    })
  }

  private async sendChunk(json: string, seq: number, final: boolean, reason: string, hide: boolean): Promise<void> {
    if (this.rejected) return
    let data = json
    let encoding = 'json'
    if (!hide) {
      const gz = await gzipBase64(json)
      if (gz) {
        data = '"' + gz + '"'
        encoding = 'gzip'
      }
    }
    const env = this.envelope(seq, final, reason, encoding)
    const body = env.slice(0, -1) + ',"data":' + data + '}'
    await this.post(body, hide)
  }

  private async post(body: string, hide: boolean): Promise<void> {
    const f = this.host.fetch || (typeof fetch === 'function' ? fetch : undefined)
    if (!f) return
    const attempts = hide ? 1 : REPLAY_LIMITS.attempts
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await f(this.host.url, {
          method: 'POST',
          body,
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          keepalive: hide && body.length < REPLAY_LIMITS.keepaliveBytes,
          credentials: 'omit',
        })
        const status = res.status
        if (status >= 200 && status < 300) {
          let j: { stop?: boolean; reason?: string } | null = null
          try {
            j = await res.json()
          } catch {
            /* empty body */
          }
          if (j && j.stop) this.stop(j.reason || 'server', true)
          return
        }
        if (status === 429) {
          const ra = Number(res.headers && res.headers.get ? res.headers.get('Retry-After') : NaN)
          await sleep(Math.min(60, isFinite(ra) && ra > 0 ? ra : 5) * 1000)
          continue
        }
        if (status >= 500) {
          await sleep(REPLAY_LIMITS.backoffMs * Math.pow(2, i))
          continue
        }
        // 400, 401, 403, 413: this replay will not be accepted.
        this.stop('rejected ' + status, true)
        return
      } catch {
        if (hide) return
        await sleep(REPLAY_LIMITS.backoffMs * Math.pow(2, i))
      }
    }
  }
}

export function createRecorder(host: ReplayHost, api: RecordApi): Recorder {
  const r = new Recorder(host, api)
  r.start()
  return r
}
