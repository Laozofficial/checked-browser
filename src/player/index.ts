// NOT part of checkd-browser. The Check’d app's replay viewer loads this bundle lazily
// (frontend/public/replay/checked-player.v1.min.js) to play recordings. It is built here because
// this package owns the pinned rrweb dependency, so recorder and player always match.
import { Replayer, EventType, IncrementalSource, MouseInteractions, ReplayerEvents } from 'rrweb'

declare global {
  interface Window {
    CheckedPlayer?: { Replayer: typeof Replayer; EventType: typeof EventType; IncrementalSource: typeof IncrementalSource; MouseInteractions: typeof MouseInteractions; ReplayerEvents: typeof ReplayerEvents }
  }
}

if (typeof window !== 'undefined' && !window.CheckedPlayer) {
  window.CheckedPlayer = { Replayer, EventType, IncrementalSource, MouseInteractions, ReplayerEvents }
}
