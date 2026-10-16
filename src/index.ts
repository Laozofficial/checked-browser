import { Client, isDoNotTrack, resolveEndpoint, INGEST_PATH } from './client'
import type {
  BreadcrumbInput,
  CaptureContext,
  CheckedOptions,
  IdentifyInput,
  MessageLevel,
} from './types'
import type { ReplayRecorder } from './replay'
import { hasWindow } from './utils'
import { SDK_VERSION } from './version'

export type * from './types'
export type { ReplayOptions, ReplayRecorder, ReplayChunk } from './replay'
export { SDK_VERSION } from './version'

let client: Client | null = null

/**
 * Calls made before init (or after close, or when Do Not Track is respected)
 * are safe no-ops. They are not queued.
 */
function guard<T>(fallback: T, fn: (c: Client) => T): T {
  if (!client) return fallback
  try {
    return fn(client)
  } catch {
    return fallback
  }
}

export function init(options: CheckedOptions): void {
  try {
    if (!hasWindow()) return
    if (!options || !options.key) {
      if (options && options.debug) console.warn('[checked] init skipped: missing key')
      return
    }
    if (client) {
      void client.close()
      client = null
    }
    if (options.respectDoNotTrack && isDoNotTrack()) {
      if (options.debug) console.warn('[checked] Do Not Track is on, SDK disabled')
      return
    }
    const c = new Client(options)
    c.start()
    client = c
  } catch (e) {
    try {
      if (options && options.debug) console.warn('[checked] init failed', e)
    } catch {
      /* ignore */
    }
  }
}

export function identify(user: IdentifyInput | null): Promise<void> {
  return guard(Promise.resolve(), (c) => c.identify(user))
}

export function captureError(error: unknown, context?: CaptureContext): void {
  guard(undefined, (c) => {
    c.captureException(error, { mechanism: 'manual', handled: true, ...context })
  })
}

export function captureMessage(message: string, level?: MessageLevel, context?: CaptureContext): void {
  guard(undefined, (c) => {
    c.captureMessage(message, level, context)
  })
}

export function track(name: string, props?: Record<string, unknown>): void {
  guard(undefined, (c) => {
    c.track(name, props)
  })
}

export function addBreadcrumb(breadcrumb: BreadcrumbInput): void {
  guard(undefined, (c) => c.addBreadcrumbInternal({ type: 'custom', ...breadcrumb }))
}

export function setTag(key: string, value: unknown): void {
  guard(undefined, (c) => c.setTag(key, value))
}

export function flush(): Promise<boolean> {
  return guard(Promise.resolve(true), (c) => c.flush().catch(() => false))
}

export function close(): Promise<boolean> {
  const c = client
  client = null
  if (!c) return Promise.resolve(true)
  try {
    return c.close().catch(() => false)
  } catch {
    return Promise.resolve(false)
  }
}

/** Integration point for the (future) session replay bundle. */
export function attachReplay(recorder: ReplayRecorder | null): void {
  guard(undefined, (c) => c.attachReplay(recorder))
}

/** Read options from a `<script data-key=...>` tag. Exposed for testing. */
export function optionsFromScript(script: HTMLScriptElement): CheckedOptions | null {
  const d = (name: string) => {
    const v = script.getAttribute('data-' + name)
    return v === null ? undefined : v
  }
  const key = d('key')
  if (!key) return null
  let endpoint = d('endpoint')
  if (!endpoint) {
    try {
      endpoint = new URL(script.src, location.href).origin + INGEST_PATH
    } catch {
      endpoint = undefined
    }
  }
  const rate = d('sample-rate')
  const opts: CheckedOptions = {
    key,
    environment: d('env') || d('environment'),
    release: d('release') || null,
    endpoint: endpoint ? resolveEndpoint(endpoint) : undefined,
    captureConsoleErrors: d('console-errors') === 'true',
    captureRequests4xx: d('capture-4xx') === 'true',
    captureQueryStrings: d('capture-query-strings') === 'true',
    respectDoNotTrack: d('respect-dnt') === 'true',
    reportAllVitals: d('report-all-vitals') === 'true',
    debug: d('debug') === 'true',
  }
  if (rate !== undefined && rate !== '' && isFinite(Number(rate))) opts.sampleRate = Number(rate)
  return opts
}

export function findOwnScript(): HTMLScriptElement | null {
  try {
    const cur = document.currentScript as HTMLScriptElement | null
    if (cur && cur.tagName === 'SCRIPT' && cur.src && cur.getAttribute('data-key')) return cur
    const scripts = document.getElementsByTagName('script')
    for (let i = scripts.length - 1; i >= 0; i--) {
      const s = scripts[i]
      if (s.src && s.src.indexOf('/sdk/checked.') !== -1) return s
    }
  } catch {
    /* ignore */
  }
  return null
}

/** Auto init from the script tag. Returns true when init ran. */
export function autoInit(): boolean {
  try {
    if (!hasWindow()) return false
    const script = findOwnScript()
    if (!script) return false
    const opts = optionsFromScript(script)
    if (!opts) return false
    init(opts)
    return true
  } catch {
    return false
  }
}

/** For tests and debugging. */
export function getClient(): Client | null {
  return client
}

export const Checked = {
  init,
  identify,
  captureError,
  captureMessage,
  track,
  addBreadcrumb,
  setTag,
  flush,
  close,
  attachReplay,
  autoInit,
  version: SDK_VERSION,
}

export default Checked
