import type { Client } from '../client'
import { safeString } from '../utils'

/** Opt-in console.error capture. The original console.error always runs first, unchanged. */
export function installConsole(client: Client): () => void {
  if (typeof console === 'undefined' || typeof console.error !== 'function') return () => {}
  const original = console.error
  let busy = false
  const wrapped = function (this: unknown, ...args: unknown[]) {
    original.apply(this === undefined ? console : this, args)
    if (busy) return
    busy = true
    try {
      const err = args.find((a) => a instanceof Error) as Error | undefined
      const message = args.map((a) => (a instanceof Error ? a.name + ': ' + a.message : safeString(a))).join(' ')
      client.addBreadcrumbInternal({ type: 'console', message, data: { level: 'error' } })
      if (err) {
        client.captureException(err, { mechanism: 'console', handled: true, message })
      } else {
        client.captureRaw({ type: 'ConsoleError', message, stack: '', handled: true, mechanism: 'console' })
      }
    } catch (e) {
      client.log('console capture failed', e)
    } finally {
      busy = false
    }
  }
  console.error = wrapped
  return () => {
    if (console.error === wrapped) console.error = original
  }
}
