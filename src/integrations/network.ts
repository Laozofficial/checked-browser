import type { Client } from '../client'

export interface RequestRecord {
  method: string
  url: string
  status: number
  durationMs: number
  errorMessage?: string
}

function perfNow(): number {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now()
  } catch {
    /* ignore */
  }
  return Date.now()
}

function resolveUrl(raw: string): string {
  try {
    return new URL(raw, location.href).href
  } catch {
    return String(raw)
  }
}

function describeFetchInput(input: unknown, init: RequestInit | undefined): { method: string; url: string } {
  let url = ''
  let method = 'GET'
  if (typeof input === 'string') url = input
  else if (input && typeof input === 'object') {
    if (typeof URL !== 'undefined' && input instanceof URL) url = input.href
    else if ('url' in (input as Request)) {
      url = String((input as Request).url)
      if ((input as Request).method) method = String((input as Request).method)
    } else url = String(input)
  } else url = String(input)
  if (init && init.method) method = String(init.method)
  return { method: method.toUpperCase(), url: resolveUrl(url) }
}

const XHR_KEY = '__checked_xhr__'

interface XhrMeta {
  method: string
  url: string
  start: number
  failure?: string
}

export function installNetwork(client: Client): () => void {
  const restores: Array<() => void> = []

  // fetch
  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch
    const wrappedFetch = function (this: unknown, input: unknown, init?: RequestInit) {
      // eslint-disable-next-line prefer-rest-params
      const args = arguments as unknown as Parameters<typeof fetch>
      let meta: { method: string; url: string } | null = null
      try {
        meta = describeFetchInput(input, init)
        if (client.isIngestUrl(meta.url)) meta = null
      } catch {
        meta = null
      }
      const start = perfNow()
      const promise = originalFetch.apply(this === undefined ? window : this, args)
      if (meta) {
        const m = meta
        try {
          promise.then(
            (res) => {
              try {
                if (res && res.type === 'opaque') return
                client.recordRequest({
                  method: m.method,
                  url: m.url,
                  status: res ? res.status : 0,
                  durationMs: Math.round(perfNow() - start),
                })
              } catch {
                /* never throw into the host */
              }
            },
            (err: unknown) => {
              try {
                const aborted = !!err && (err as { name?: string }).name === 'AbortError'
                client.recordRequest(
                  {
                    method: m.method,
                    url: m.url,
                    status: 0,
                    durationMs: Math.round(perfNow() - start),
                    errorMessage: err instanceof Error ? err.message : String(err),
                  },
                  aborted,
                )
              } catch {
                /* never throw into the host */
              }
            },
          )
        } catch {
          /* non-thenable result, leave it alone */
        }
      }
      return promise
    } as typeof fetch
    window.fetch = wrappedFetch
    restores.push(() => {
      if (window.fetch === wrappedFetch) window.fetch = originalFetch
    })
  }

  // XMLHttpRequest
  if (typeof XMLHttpRequest !== 'undefined' && XMLHttpRequest.prototype) {
    const proto = XMLHttpRequest.prototype
    const originalOpen = proto.open
    const originalSend = proto.send
    const wrappedOpen = function (this: XMLHttpRequest, method: string, url: string | URL) {
      try {
        ;(this as unknown as Record<string, XhrMeta>)[XHR_KEY] = {
          method: String(method || 'GET').toUpperCase(),
          url: resolveUrl(String(url)),
          start: 0,
        }
      } catch {
        /* ignore */
      }
      // eslint-disable-next-line prefer-rest-params
      return (originalOpen as (...a: unknown[]) => void).apply(this, arguments as unknown as unknown[])
    } as typeof proto.open
    const wrappedSend = function (this: XMLHttpRequest) {
      try {
        const meta = (this as unknown as Record<string, XhrMeta | undefined>)[XHR_KEY]
        if (meta && !client.isIngestUrl(meta.url)) {
          meta.start = perfNow()
          const xhr = this
          const mark = (msg: string) => () => {
            meta.failure = msg
          }
          xhr.addEventListener('error', mark('Network error'))
          xhr.addEventListener('timeout', mark('Timeout'))
          xhr.addEventListener('abort', mark('Aborted'))
          xhr.addEventListener('loadend', () => {
            try {
              const status = xhr.status || 0
              client.recordRequest(
                {
                  method: meta.method,
                  url: meta.url,
                  status,
                  durationMs: Math.round(perfNow() - meta.start),
                  errorMessage: status === 0 ? meta.failure || 'Network error' : undefined,
                },
                meta.failure === 'Aborted',
              )
            } catch {
              /* ignore */
            }
          })
        }
      } catch {
        /* ignore */
      }
      // eslint-disable-next-line prefer-rest-params
      return (originalSend as (...a: unknown[]) => void).apply(this, arguments as unknown as unknown[])
    } as typeof proto.send
    proto.open = wrappedOpen
    proto.send = wrappedSend
    restores.push(() => {
      if (proto.open === wrappedOpen) proto.open = originalOpen
      if (proto.send === wrappedSend) proto.send = originalSend
    })
  }

  return () => restores.forEach((r) => r())
}
