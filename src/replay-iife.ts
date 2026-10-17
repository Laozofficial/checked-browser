// Entry for the lazily loaded replay bundle (checked-replay.v<version>.min.js).
// Exposes window.CheckedReplay; the core SDK finds it there once the script has loaded.
import { createReplay, replayId, stopReplay } from './replay/index'
import { SDK_VERSION } from './version'

declare global {
  interface Window {
    CheckedReplay?: { createReplay: typeof createReplay; stop: typeof stopReplay; replayId: typeof replayId; version: string }
  }
}

try {
  if (typeof window !== 'undefined' && !window.CheckedReplay) {
    window.CheckedReplay = { createReplay, stop: stopReplay, replayId, version: SDK_VERSION }
  }
} catch {
  /* never throw into the host page */
}
