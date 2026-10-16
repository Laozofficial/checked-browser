import type {
  BaseEvent,
  Breadcrumb,
  BreadcrumbInput,
  CaptureContext,
  CheckedEvent,
  CheckedOptions,
  ErrorMechanism,
  EventContext,
  EventType,
  EventUser,
  IdentifyInput,
  MessageLevel,
  MetricName,
  Rating,
} from './types'
import type { ReplayRecorder } from './replay'
import { Transport } from './transport'
import { parseUserAgent, type ParsedUA } from './ua'
import {
  LIMITS,
  cleanText,
  flatPrimitives,
  normalizeExtra,
  normalizeTags,
  now,
  randomId,
  stripQuery,
  topFrame,
  truncate,
} from './utils'
import { SDK_NAME, SDK_VERSION } from './version'
import { installGlobalHandlers } from './integrations/errors'
import { installConsole } from './integrations/console'
import { installNetwork, type RequestRecord } from './integrations/network'
import { installPerformance } from './integrations/performance'
import { installHistory } from './integrations/history'
import { installClicks } from './integrations/clicks'

export const DEFAULT_ENDPOINT = 'https://getchecked.twelveai.app/api/v1/ingest/events'
export const INGEST_PATH = '/api/v1/ingest/events'
const AID_KEY = 'checked.aid'
const SID_KEY = 'checked.sid'
const SESSION_IDLE_MS = 30 * 60 * 1000
const DEDUPE_MS = 1000

export interface RawError {
  type: string
  message: string
  stack: string
  handled: boolean
  mechanism: ErrorMechanism
}

/** Resolve an endpoint option. A bare origin gets the ingest path appended. */
export function resolveEndpoint(endpoint: string | undefined, base?: string): string {
  if (!endpoint) return DEFAULT_ENDPOINT
  try {
    const u = new URL(endpoint, base || (typeof location !== 'undefined' ? location.href : undefined))
    const path = u.pathname === '/' || u.pathname === '' ? INGEST_PATH : u.pathname.replace(/\/+$/, '')
    return u.origin + path
  } catch {
    return stripQuery(endpoint)
  }
}

export function isDoNotTrack(): boolean {
  try {
    const n = navigator as Navigator & { globalPrivacyControl?: boolean; msDoNotTrack?: string }
    const w = window as Window & { doNotTrack?: string }
    return n.doNotTrack === '1' || w.doNotTrack === '1' || n.msDoNotTrack === '1' || n.globalPrivacyControl === true
  } catch {
    return false
  }
}

async function sha256Hex(text: string): Promise<string | null> {
  try {
    const c = (globalThis as { crypto?: Crypto }).crypto
    if (!c || !c.subtle || typeof c.subtle.digest !== 'function' || typeof TextEncoder === 'undefined') return null
    const buf = await c.subtle.digest('SHA-256', new TextEncoder().encode(text))
    const bytes = new Uint8Array(buf)
    let s = ''
    for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16)
    return s
  } catch {
    return null
  }
}

export class Client {
  readonly key: string
  readonly endpoint: string
  readonly ingestUrl: string
  private opts: Required<
    Pick<
      CheckedOptions,
      | 'environment'
      | 'sampleRate'
      | 'captureConsoleErrors'
      | 'captureRequests4xx'
      | 'captureQueryStrings'
      | 'sendEmail'
      | 'maxBreadcrumbs'
      | 'reportAllVitals'
      | 'maxEventsPerPage'
      | 'debug'
    >
  > & { release: string | null; beforeSend?: CheckedOptions['beforeSend'] }
  private user: EventUser
  private tags: Record<string, string> = {}
  private breadcrumbs: Breadcrumb[] = []
  private transport: Transport
  private uninstallers: Array<() => void> = []
  private eventCount = 0
  private dedupe = new Map<string, number>()
  private replay: ReplayRecorder | null = null
  private ua: ParsedUA
  private nativeFetch: typeof fetch | undefined
  private memSession: { id: string; last: number } | null = null
  private identifyToken = 0
  private closed = false
  private warn: (...a: unknown[]) => void
  private reportVitalsOnHide: (() => void) | null = null

  constructor(options: CheckedOptions) {
    this.key = String(options.key)
    this.endpoint = resolveEndpoint(options.endpoint)
    this.ingestUrl = this.endpoint + '?key=' + encodeURIComponent(this.key)
    const rate = typeof options.sampleRate === 'number' && isFinite(options.sampleRate) ? options.sampleRate : 1
    this.opts = {
      environment: truncate(options.environment || 'production', 64),
      release: options.release ? truncate(String(options.release), 64) : null,
      sampleRate: Math.min(1, Math.max(0, rate)),
      captureConsoleErrors: !!options.captureConsoleErrors,
      captureRequests4xx: !!options.captureRequests4xx,
      captureQueryStrings: !!options.captureQueryStrings,
      sendEmail: !!options.sendEmail,
      maxBreadcrumbs: Math.max(0, Math.min(100, options.maxBreadcrumbs ?? 30)),
      reportAllVitals: !!options.reportAllVitals,
      maxEventsPerPage: Math.max(1, options.maxEventsPerPage ?? 100),
      debug: !!options.debug,
      beforeSend: typeof options.beforeSend === 'function' ? options.beforeSend : undefined,
    }
    const originalWarn = typeof console !== 'undefined' ? console.warn : undefined
    this.warn = (...a: unknown[]) => {
      try {
        if (this.opts.debug && originalWarn) originalWarn.apply(console, ['[checked]', ...a])
      } catch {
        /* ignore */
      }
    }
    this.ua = parseUserAgent(typeof navigator !== 'undefined' ? navigator.userAgent : '')
    this.user = { anonymousId: this.anonymousId() }
    this.nativeFetch = typeof window !== 'undefined' && typeof window.fetch === 'function' ? window.fetch : undefined
    const nf = this.nativeFetch
    this.transport = new Transport({
      url: this.ingestUrl,
      key: this.key,
      sdk: { name: SDK_NAME, version: SDK_VERSION },
      flushIntervalMs: Math.max(100, options.flushIntervalMs ?? 5000),
      fetchImpl: nf ? (input, init) => nf.call(window, input, init) : undefined,
      log: this.warn,
    })
    if (options.user) void this.identify(options.user)
  }

  log(...args: unknown[]): void {
    this.warn(...args)
  }

  start(): void {
    const safeInstall = (fn: () => void) => {
      try {
        fn()
      } catch (e) {
        this.warn('integration failed to install', e)
      }
    }
    safeInstall(() => this.uninstallers.push(installGlobalHandlers(this)))
    if (this.opts.captureConsoleErrors) safeInstall(() => this.uninstallers.push(installConsole(this)))
    safeInstall(() => this.uninstallers.push(installNetwork(this)))
    safeInstall(() => this.uninstallers.push(installHistory(this)))
    safeInstall(() => this.uninstallers.push(installClicks(this)))
    safeInstall(() => {
      const perf = installPerformance(this)
      this.reportVitalsOnHide = perf.reportOnHide
      this.uninstallers.push(perf.uninstall)
    })

    const onHide = () => {
      try {
        if (this.reportVitalsOnHide) this.reportVitalsOnHide()
        this.transport.flushOnHide()
      } catch (e) {
        this.warn('hide flush failed', e)
      }
    }
    const onVisibility = () => {
      try {
        if (document.visibilityState === 'hidden') onHide()
      } catch {
        /* ignore */
      }
    }
    const onOnline = () => {
      try {
        this.transport.onOnline()
      } catch {
        /* ignore */
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onHide)
    window.addEventListener('online', onOnline)
    this.uninstallers.push(() => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onHide)
      window.removeEventListener('online', onOnline)
    })
    this.warn('initialized', this.endpoint)
  }

  /** Remove every hook. Pending events are flushed first (the returned promise). */
  close(): Promise<boolean> {
    if (this.closed) return Promise.resolve(true)
    const p = this.transport.flush()
    this.closed = true
    this.transport.close()
    for (const u of this.uninstallers.splice(0)) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    if (this.replay) {
      try {
        this.replay.stop()
      } catch {
        /* ignore */
      }
    }
    return p
  }

  flush(): Promise<boolean> {
    return this.transport.flush()
  }

  isIngestUrl(url: string): boolean {
    if (!url) return false
    const bare = stripQuery(url)
    return bare === this.endpoint || bare.indexOf(this.endpoint) === 0
  }

  attachReplay(recorder: ReplayRecorder | null): void {
    this.replay = recorder
  }

  // ---------------------------------------------------------------- identity

  identify(input: IdentifyInput | null | undefined): Promise<void> {
    const token = ++this.identifyToken
    if (!input) {
      this.user = { anonymousId: this.user.anonymousId }
      return Promise.resolve()
    }
    const next: EventUser = { anonymousId: this.user.anonymousId }
    if (input.id !== undefined && input.id !== null && input.id !== '') next.id = truncate(String(input.id), 128)
    this.user = next
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
    if (!email) return Promise.resolve()
    if (this.opts.sendEmail) next.email = truncate(email, 254)
    return sha256Hex(email).then((hash) => {
      if (hash && token === this.identifyToken) this.user = { ...this.user, emailHash: hash }
    })
  }

  getUser(): EventUser {
    return { ...this.user }
  }

  setTag(key: string, value: unknown): void {
    if (!key) return
    if (value === undefined || value === null) {
      delete this.tags[key]
      return
    }
    Object.assign(this.tags, normalizeTags({ [key]: value }))
  }

  private anonymousId(): string {
    try {
      const existing = window.localStorage.getItem(AID_KEY)
      if (existing && /^a_[0-9a-f]{8,64}$/.test(existing)) return existing
      const id = 'a_' + randomId(10)
      window.localStorage.setItem(AID_KEY, id)
      return id
    } catch {
      return 'a_' + randomId(10)
    }
  }

  private sessionId(): string {
    const t = now()
    let s: { id: string; last: number } | null = null
    try {
      const raw = window.sessionStorage.getItem(SID_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed.id === 'string' && typeof parsed.last === 'number') s = parsed
      }
    } catch {
      s = this.memSession
    }
    if (!s && this.memSession) s = this.memSession
    if (!s || t - s.last > SESSION_IDLE_MS) s = { id: 's_' + randomId(10), last: t }
    s.last = t
    this.memSession = s
    try {
      window.sessionStorage.setItem(SID_KEY, JSON.stringify(s))
    } catch {
      /* in-memory fallback */
    }
    return s.id
  }

  // ------------------------------------------------------------- breadcrumbs

  addBreadcrumbInternal(input: BreadcrumbInput): void {
    if (this.closed || this.opts.maxBreadcrumbs === 0 || !input) return
    const keep = this.opts.captureQueryStrings
    const crumb: Breadcrumb = {
      ts: typeof input.ts === 'number' ? input.ts : now(),
      type: input.type || 'custom',
      message: cleanText(String(input.message ?? ''), LIMITS.breadcrumb, keep),
    }
    if (input.data && typeof input.data === 'object') {
      const flat = flatPrimitives(input.data, 10, LIMITS.breadcrumb)
      for (const k of Object.keys(flat)) {
        const v = flat[k]
        if (typeof v === 'string') flat[k] = cleanText(v, LIMITS.breadcrumb, keep)
      }
      crumb.data = flat
    }
    this.breadcrumbs.push(crumb)
    if (this.breadcrumbs.length > this.opts.maxBreadcrumbs) {
      this.breadcrumbs.splice(0, this.breadcrumbs.length - this.opts.maxBreadcrumbs)
    }
  }

  getBreadcrumbs(): Breadcrumb[] {
    return this.breadcrumbs.slice()
  }

  // ---------------------------------------------------------------- capture

  private sampled(): boolean {
    if (this.opts.sampleRate >= 1) return true
    if (this.opts.sampleRate <= 0) return false
    return Math.random() < this.opts.sampleRate
  }

  private pageUrl(): string {
    try {
      const href = location.href
      return this.opts.captureQueryStrings ? href : stripQuery(href)
    } catch {
      return ''
    }
  }

  private context(): EventContext & { referrer?: string } {
    const ctx: EventContext & { referrer?: string } = {
      browser: this.ua.browser,
      os: this.ua.os,
      device: this.ua.device,
    }
    try {
      ctx.viewport = { w: window.innerWidth || 0, h: window.innerHeight || 0 }
    } catch {
      /* ignore */
    }
    try {
      if (navigator.language) ctx.language = navigator.language
      if (navigator.userAgent) ctx.userAgent = truncate(navigator.userAgent, LIMITS.userAgent)
    } catch {
      /* ignore */
    }
    try {
      if (document.referrer) ctx.referrer = new URL(document.referrer).origin
    } catch {
      /* ignore */
    }
    return ctx
  }

  private base(type: EventType, withBreadcrumbs: boolean, ctx?: CaptureContext): BaseEvent {
    const ev: BaseEvent = {
      id: randomId(16),
      type,
      ts: now(),
      environment: this.opts.environment,
      release: this.opts.release,
      url: this.pageUrl(),
      user: { ...this.user },
      sessionId: this.sessionId(),
      context: this.context(),
      breadcrumbs: withBreadcrumbs ? this.breadcrumbs.slice() : [],
      tags: { ...this.tags, ...(ctx && ctx.tags ? normalizeTags(ctx.tags) : {}) },
    }
    const extra = ctx && ctx.extra ? normalizeExtra(ctx.extra) : undefined
    if (extra) ev.extra = extra
    return ev
  }

  /** beforeSend, page cap, then the queue. */
  private dispatch(event: CheckedEvent): boolean {
    if (this.closed) return false
    let out: CheckedEvent | null = event
    if (this.opts.beforeSend) {
      try {
        out = this.opts.beforeSend(event)
      } catch (e) {
        this.warn('beforeSend threw, dropping event', e)
        out = null
      }
      if (!out || typeof out !== 'object') return false
    }
    if (this.eventCount >= this.opts.maxEventsPerPage) {
      this.transport.countDropped(1)
      return false
    }
    this.eventCount++
    this.transport.enqueue(out)
    return true
  }

  captureException(
    err: unknown,
    opts: { mechanism: ErrorMechanism; handled: boolean; message?: string } & CaptureContext,
  ): boolean {
    const e = err as { name?: unknown; message?: unknown; stack?: unknown; constructor?: { name?: string } }
    let type = 'Error'
    try {
      if (typeof e.name === 'string' && e.name) type = e.name
      else if (e.constructor && e.constructor.name && e.constructor.name !== 'Object') type = e.constructor.name
    } catch {
      /* ignore */
    }
    let message = ''
    let stack = ''
    try {
      message = opts.message || (e.message !== undefined ? String(e.message) : String(err))
      stack = typeof e.stack === 'string' ? e.stack : ''
    } catch {
      message = message || 'Unknown error'
    }
    return this.captureRaw({ type, message, stack, handled: opts.handled, mechanism: opts.mechanism }, opts)
  }

  captureRaw(raw: RawError, ctx?: CaptureContext): boolean {
    if (this.closed) return false
    if (!this.sampled()) return false
    const keep = this.opts.captureQueryStrings
    const type = truncate(raw.type || 'Error', 128)
    const message = cleanText(raw.message || '', LIMITS.message, keep)
    const stack = cleanText(raw.stack || '', LIMITS.stack, keep)
    const t = now()
    const dkey = type + '|' + message + '|' + topFrame(stack)
    const last = this.dedupe.get(dkey)
    if (last !== undefined && t - last < DEDUPE_MS) return false
    this.dedupe.set(dkey, t)
    if (this.dedupe.size > 200) {
      for (const [k, v] of this.dedupe) if (t - v >= DEDUPE_MS) this.dedupe.delete(k)
    }
    const ev = this.base('error', true, ctx) as CheckedEvent
    ;(ev as CheckedEvent & { error: unknown }).error = {
      type,
      message,
      stack,
      handled: raw.handled,
      mechanism: raw.mechanism,
    }
    if (this.replay) {
      try {
        const rid = this.replay.replayId
        if (rid) ev.replayId = rid
        void this.replay.flush('error').catch(() => null)
      } catch {
        /* ignore */
      }
    }
    return this.dispatch(ev)
  }

  captureMessage(message: string, level: MessageLevel = 'info', ctx?: CaptureContext): boolean {
    const merged: CaptureContext = { ...ctx, tags: { level, ...(ctx && ctx.tags) } }
    return this.captureRaw(
      { type: 'Message', message: String(message), stack: '', handled: true, mechanism: 'manual' },
      merged,
    )
  }

  recordRequest(rec: RequestRecord, breadcrumbOnly = false): void {
    if (this.closed) return
    const keep = this.opts.captureQueryStrings
    const url = keep ? rec.url : stripQuery(rec.url)
    const method = truncate(rec.method || 'GET', 16)
    this.addBreadcrumbInternal({
      type: 'request',
      message: `${method} ${url} ${rec.status || (breadcrumbOnly ? 'aborted' : 'failed')}`,
      data: { method, url, status: rec.status, durationMs: rec.durationMs },
    })
    if (breadcrumbOnly) return
    const status = rec.status
    const wanted = status === 0 || status >= 500 || (this.opts.captureRequests4xx && status >= 400)
    if (!wanted || !this.sampled()) return
    const ev = this.base('request', true) as CheckedEvent
    const request: { method: string; url: string; status: number; durationMs: number; errorMessage?: string } = {
      method,
      url: truncate(url, 2000),
      status,
      durationMs: Math.max(0, Math.round(rec.durationMs || 0)),
    }
    if (rec.errorMessage) request.errorMessage = cleanText(rec.errorMessage, LIMITS.breadcrumb, keep)
    ;(ev as CheckedEvent & { request: unknown }).request = request
    this.dispatch(ev)
  }

  recordVital(metric: MetricName, value: number, rating: Rating): void {
    if (this.closed) return
    if (rating !== 'poor' && !this.opts.reportAllVitals) return
    if (!this.sampled()) return
    const ev = this.base('performance', false) as CheckedEvent
    const v = metric === 'CLS' ? Math.round(value * 10000) / 10000 : Math.round(value)
    ;(ev as CheckedEvent & { performance: unknown }).performance = { metric, value: v, rating }
    this.dispatch(ev)
  }

  recordNavigation(from: string, to: string): void {
    const keep = this.opts.captureQueryStrings
    const f = keep ? from : stripQuery(from)
    const t = keep ? to : stripQuery(to)
    if (f === t && !keep) return
    this.addBreadcrumbInternal({ type: 'navigation', message: `${f} -> ${t}`, data: { from: f, to: t } })
  }

  track(name: string, props?: Record<string, unknown>): boolean {
    if (this.closed || !name) return false
    const ev = this.base('custom', false) as CheckedEvent
    ;(ev as CheckedEvent & { custom: unknown }).custom = {
      name: truncate(String(name), LIMITS.name),
      props: flatPrimitives(props, LIMITS.propKeys, LIMITS.message),
    }
    return this.dispatch(ev)
  }
}
