import type { Client } from '../client'
import { safeString } from '../utils'

/** window 'error' (uncaught exceptions only, resource load errors ignored) and 'unhandledrejection'. */
export function installGlobalHandlers(client: Client): () => void {
  const onError = (event: Event) => {
    try {
      // Resource load errors (img, script) do not bubble to window and are not
      // ErrorEvents. Ignore anything that is not a script error.
      const ev = event as ErrorEvent
      const target = event.target as { nodeType?: unknown } | null
      if (target && typeof target.nodeType === 'number') return
      if (!('message' in ev) && !('error' in ev)) return
      const err = ev.error
      if (err instanceof Error || (err && typeof err === 'object' && 'message' in err)) {
        client.captureException(err, { mechanism: 'onerror', handled: false })
        return
      }
      const message = ev.message || (err !== undefined ? safeString(err) : 'Unknown error')
      const loc = ev.filename ? `\n    at ${ev.filename}:${ev.lineno || 0}:${ev.colno || 0}` : ''
      client.captureRaw({
        type: 'Error',
        message,
        stack: loc ? message + loc : '',
        handled: false,
        mechanism: 'onerror',
      })
    } catch (e) {
      client.log('error handler failed', e)
    }
  }

  const onRejection = (event: Event) => {
    try {
      let reason: unknown = (event as PromiseRejectionEvent).reason
      // Some wrappers put the reason on event.detail.reason.
      const detail = (event as CustomEvent).detail
      if (reason === undefined && detail && typeof detail === 'object' && 'reason' in detail) {
        reason = (detail as { reason: unknown }).reason
      }
      if (reason instanceof Error || (reason && typeof reason === 'object' && 'stack' in reason && 'message' in reason)) {
        client.captureException(reason, { mechanism: 'unhandledrejection', handled: false })
        return
      }
      client.captureRaw({
        type: 'UnhandledRejection',
        message: 'Non-Error promise rejection: ' + safeString(reason),
        stack: '',
        handled: false,
        mechanism: 'unhandledrejection',
      })
    } catch (e) {
      client.log('rejection handler failed', e)
    }
  }

  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
