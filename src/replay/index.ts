/**
 * `checkd-browser/replay`: the session replay recorder. Bundled separately from the core SDK
 * (it carries rrweb), and loaded only when `replay` is set in `Checked.init`.
 *
 *   Checked.init({ key, replay: { onErrorSampleRate: 1, load: () => import('checkd-browser/replay') } })
 */
import { record } from 'rrweb'
import type { ReplayHost, ReplayOptions, ReplayRecorder } from '../replay'
import { createRecorder, type RecordApi, type Recorder } from './recorder'

export { REPLAY_LIMITS, doNotTrack, gzipBase64 } from './recorder'
export type { RecordApi } from './recorder'

const rrweb: RecordApi = {
  record: (o) => record(o as Parameters<typeof record>[0]),
  addCustomEvent: (tag, payload) => record.addCustomEvent(tag, payload),
  takeFullSnapshot: (isCheckout) => record.takeFullSnapshot(isCheckout),
}

let current: Recorder | null = null

/**
 * The script tag build passes only `{ src }`; the rest comes from the tag's data-replay-*
 * attributes. Options set in code win over attributes.
 */
export function optionsFromTag(options: ReplayOptions): ReplayOptions {
  try {
    const tag = document.querySelector('script[data-replay="true"][data-key]')
    if (!tag) return options
    const num = (name: string) => {
      const v = tag.getAttribute('data-replay-' + name)
      return v !== null && v !== '' && isFinite(Number(v)) ? Number(v) : undefined
    }
    const fromTag: ReplayOptions = {
      sampleRate: num('sample-rate'),
      onErrorSampleRate: num('error-sample-rate'),
      maxDurationMinutes: num('max-minutes'),
      maskAllText: tag.getAttribute('data-replay-mask-all-text') === 'true',
      maskSelector: tag.getAttribute('data-replay-mask') || undefined,
      blockSelector: tag.getAttribute('data-replay-block') || undefined,
    }
    const out: ReplayOptions = { ...options }
    for (const k of Object.keys(fromTag) as Array<keyof ReplayOptions>) {
      if (out[k] === undefined && fromTag[k] !== undefined) (out as Record<string, unknown>)[k] = fromTag[k]
    }
    return out
  } catch {
    return options
  }
}

/** Called by the core SDK with what it knows (key, endpoint, session, user). Starts recording. */
export function createReplay(host: ReplayHost, api: RecordApi = rrweb): ReplayRecorder {
  if (current) current.stop()
  current = createRecorder({ ...host, options: optionsFromTag(host.options || {}) }, api)
  return current
}

/** Stop recording for this page, for example when the person withdraws consent. */
export function stopReplay(): void {
  if (current) current.stop()
  current = null
}

/** The active replay id, if this page is being recorded. */
export function replayId(): string | null {
  return current ? current.replayId : null
}
