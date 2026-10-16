/**
 * Session replay integration point. Design note only: recording is NOT
 * implemented and rrweb is NOT bundled. A future, lazily loaded bundle
 * (`checked.replay.v1.min.js`) will provide a ReplayRecorder and hand it to
 * `Checked.attachReplay(recorder)`. Once attached, every outgoing error event
 * carries the recorder's `replayId`, and the recorder is asked to flush its
 * rolling buffer with reason "error".
 */

export interface ReplayOptions {
  /** Fraction of sessions recorded from the start (0..1). */
  sampleRate?: number
  /** Fraction of sessions whose buffer is kept and uploaded when an error happens (0..1). */
  onErrorSampleRate?: number
  /** Mask all text content. Defaults to true. Inputs are always masked. */
  maskAllText?: boolean
  /** CSS selector for elements that are never recorded (replaced by a placeholder). */
  blockSelector?: string
}

export interface ReplayRecorder {
  start(): void
  stop(): void
  /** Upload the buffered recording. Resolves with the replay id, or null if nothing was sent. */
  flush(reason: string): Promise<string | null>
  readonly replayId: string | null
}

export interface ReplayChunk {
  replayId: string
  seq: number
  ts: number
  /** base64 of gzip compressed rrweb events. */
  data: string
  final: boolean
}
