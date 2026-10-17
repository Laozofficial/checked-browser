/**
 * Session replay integration point for the core SDK. Recording itself lives in a separate,
 * lazily loaded bundle (`checked-replay.v<version>.min.js`, built from src/replay/), so the core
 * stays within its size budget and pages that never turn replay on never download rrweb.
 *
 * Once a recorder is attached, every outgoing error and failed request event carries the
 * recorder's `replayId`, and the recorder is asked to flush its rolling buffer.
 */
import type { Client } from './client'
import type { EventContext, EventUser } from './types'
import { SDK_VERSION } from './version'

export interface ReplayOptions {
  /** Defaults to true when a replay object is given. */
  enabled?: boolean
  /** Fraction of sessions recorded from the start and uploaded as they go (0..1). Default 0. */
  sampleRate?: number
  /** Fraction of sessions that keep a rolling buffer of the last ~60 seconds and upload it when an error or failed request is captured (0..1). Default 1. */
  onErrorSampleRate?: number
  /** Mask all text on the page, not only inputs. Default false. Inputs and textareas are always masked. */
  maskAllText?: boolean
  /** Extra CSS selector whose text is masked, in addition to `[data-checked-mask]`. */
  maskSelector?: string
  /** Extra CSS selector for elements never recorded (a same size placeholder is shown), in addition to `[data-checked-block]`. */
  blockSelector?: string
  /** Record canvas pixels. Default false. */
  recordCanvas?: boolean
  /** Stop recording after this many minutes. Default 60; your plan may cap it lower. */
  maxDurationMinutes?: number
  /** URL of the replay bundle. The script tag build works it out from its own address. */
  src?: string
  /** For bundlers: `load: () => import('@checked/browser/replay')`. Used instead of `src`. */
  load?: () => Promise<unknown>
  /** Full replay ingest URL. Defaults to the events endpoint with `/events` swapped for `/replay`. */
  endpoint?: string
}

/** The parts of the core client the replay bundle reads. Both ship with the same version. */
export interface ReplayClient {
  readonly key: string
  readonly opts: { environment: string; release: string | null; captureQueryStrings: boolean; debug: boolean }
  sessionId(): string
  getUser(): EventUser
  context(): EventContext
  log(...args: unknown[]): void
}

/** What the core hands the replay bundle. */
export interface ReplayHost {
  options: ReplayOptions
  client: ReplayClient
  /** Replay ingest URL, with `?key=`. */
  url: string
  /** The page's fetch from before the SDK wrapped it, so uploads never show up as requests. */
  fetch?: typeof fetch
}

export interface ReplayMarkDetail {
  eventId: string
  message: string
}

export interface ReplayRecorder {
  start(): void
  stop(): void
  /** Upload the buffered recording. Resolves with the replay id, or null if nothing was sent. */
  flush(reason: string, detail?: ReplayMarkDetail): Promise<string | null>
  readonly replayId: string | null
}

export interface ReplayModule {
  createReplay(host: ReplayHost): ReplayRecorder
}

export interface ReplayChunk {
  replayId: string
  seq: number
  ts: number
  /** base64 of gzip compressed rrweb events, or the events themselves when CompressionStream is missing. */
  data: string | unknown[]
  final: boolean
}

/** Loads the replay bundle (or the bundler module) and attaches the recorder it creates. */
export function loadReplay(c: Client, o: ReplayOptions): void {
  const w = window as unknown as { CheckedReplay?: ReplayModule }
  const go = (m: unknown) => {
    const mod = m as (ReplayModule & { default?: ReplayModule }) | undefined
    const f = mod && (mod.createReplay || (mod.default && mod.default.createReplay))
    if (f) c.attachReplay(f(c.replayHost(o)))
  }
  try {
    if (o.load) return void o.load().then(go, (e) => c.log('replay load failed', e))
    if (w.CheckedReplay) return go(w.CheckedReplay)
    const s = document.createElement('script')
    s.async = true
    s.src = o.src || new URL(c.endpoint).origin + '/sdk/checked-replay.v' + SDK_VERSION + '.min.js'
    s.onload = () => go(w.CheckedReplay)
    ;(document.head || document.documentElement).appendChild(s)
  } catch (e) {
    c.log('replay load failed', e)
  }
}
