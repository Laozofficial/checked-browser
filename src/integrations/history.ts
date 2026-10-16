import type { Client } from '../client'

/** SPA route tracking: pushState/replaceState wrappers plus popstate and hashchange. */
export function installHistory(client: Client): () => void {
  let last = safeHref()
  const check = () => {
    try {
      const href = safeHref()
      if (href !== last) {
        const from = last
        last = href
        client.recordNavigation(from, href)
      }
    } catch {
      /* ignore */
    }
  }

  const restores: Array<() => void> = []
  const h = window.history
  if (h) {
    for (const name of ['pushState', 'replaceState'] as const) {
      const original = h[name]
      if (typeof original !== 'function') continue
      const wrapped = function (this: History) {
        // eslint-disable-next-line prefer-rest-params
        const result = (original as (...a: unknown[]) => void).apply(this, arguments as unknown as unknown[])
        check()
        return result
      } as History[typeof name]
      h[name] = wrapped
      restores.push(() => {
        if (h[name] === wrapped) h[name] = original
      })
    }
  }
  window.addEventListener('popstate', check)
  window.addEventListener('hashchange', check)
  restores.push(() => {
    window.removeEventListener('popstate', check)
    window.removeEventListener('hashchange', check)
  })
  return () => restores.forEach((r) => r())
}

function safeHref(): string {
  try {
    return location.href
  } catch {
    return ''
  }
}
