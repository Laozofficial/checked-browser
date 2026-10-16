import type { Client } from '../client'
import type { MetricName, Rating } from '../types'

/** [needs-improvement above, poor above] */
const THRESHOLDS: Record<MetricName, [number, number]> = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  TTFB: [800, 1800],
  load: [4000, 8000],
}

export function rate(metric: MetricName, value: number): Rating {
  const [ni, poor] = THRESHOLDS[metric]
  if (value > poor) return 'poor'
  if (value > ni) return 'needs-improvement'
  return 'good'
}

interface LayoutShiftEntry extends PerformanceEntry {
  value: number
  hadRecentInput: boolean
}

interface EventTimingEntry extends PerformanceEntry {
  interactionId?: number
}

function supported(type: string): boolean {
  try {
    const types = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes
    return !!types && types.indexOf(type) !== -1
  } catch {
    return false
  }
}

/**
 * Web Vitals collection.
 * - TTFB and load come from navigation timing, reported once after load.
 * - LCP: last largest-contentful-paint entry.
 * - INP (approximate): longest event-timing duration among entries with an
 *   interactionId, durationThreshold 40ms.
 * - CLS: largest session window (shifts less than 1s apart, window at most 5s),
 *   ignoring shifts with recent input.
 * LCP, INP and CLS are reported once, on the first page hide.
 */
export function installPerformance(client: Client): { uninstall: () => void; reportOnHide: () => void } {
  const observers: PerformanceObserver[] = []
  let lcp = -1
  let inp = -1
  let cls = 0
  let clsSeen = false
  let sessionValue = 0
  let sessionStart = 0
  let sessionLast = 0
  let hiddenReported = false
  let loadTimer: ReturnType<typeof setTimeout> | null = null

  const hasPO = typeof PerformanceObserver !== 'undefined'

  const observe = (type: string, cb: (entries: PerformanceEntry[]) => void, extra?: Record<string, unknown>) => {
    if (!hasPO || !supported(type)) return
    try {
      const po = new PerformanceObserver((list) => {
        try {
          cb(list.getEntries())
        } catch {
          /* ignore */
        }
      })
      po.observe(Object.assign({ type, buffered: true }, extra || {}) as PerformanceObserverInit)
      observers.push(po)
    } catch {
      /* unsupported */
    }
  }

  observe('largest-contentful-paint', (entries) => {
    const last = entries[entries.length - 1]
    if (last) lcp = last.startTime
  })

  observe(
    'event',
    (entries) => {
      for (const e of entries as EventTimingEntry[]) {
        if (e.interactionId && e.duration > inp) inp = e.duration
      }
    },
    { durationThreshold: 40 },
  )

  observe('layout-shift', (entries) => {
    for (const e of entries as LayoutShiftEntry[]) {
      if (e.hadRecentInput) continue
      clsSeen = true
      if (sessionValue && e.startTime - sessionLast < 1000 && e.startTime - sessionStart < 5000) {
        sessionValue += e.value
      } else {
        sessionValue = e.value
        sessionStart = e.startTime
      }
      sessionLast = e.startTime
      if (sessionValue > cls) cls = sessionValue
    }
  })

  const reportNavigation = () => {
    try {
      if (typeof performance === 'undefined') return
      let ttfb = -1
      let load = -1
      const nav =
        typeof performance.getEntriesByType === 'function'
          ? (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined)
          : undefined
      if (nav) {
        ttfb = nav.responseStart
        load = nav.loadEventEnd
      } else if (performance.timing && performance.timing.navigationStart) {
        const t = performance.timing
        ttfb = t.responseStart - t.navigationStart
        load = t.loadEventEnd ? t.loadEventEnd - t.navigationStart : -1
      }
      if (ttfb > 0) client.recordVital('TTFB', ttfb, rate('TTFB', ttfb))
      if (load > 0) client.recordVital('load', load, rate('load', load))
    } catch {
      /* ignore */
    }
  }

  const onLoad = () => {
    // loadEventEnd is only set after the load handlers finish.
    loadTimer = setTimeout(reportNavigation, 0)
  }
  if (document.readyState === 'complete') onLoad()
  else window.addEventListener('load', onLoad)

  const reportOnHide = () => {
    if (hiddenReported) return
    hiddenReported = true
    try {
      if (lcp > 0) client.recordVital('LCP', lcp, rate('LCP', lcp))
      if (inp > 0) client.recordVital('INP', inp, rate('INP', inp))
      if (clsSeen) client.recordVital('CLS', cls, rate('CLS', cls))
    } catch {
      /* ignore */
    }
  }

  return {
    reportOnHide,
    uninstall: () => {
      window.removeEventListener('load', onLoad)
      if (loadTimer) clearTimeout(loadTimer)
      for (const o of observers) {
        try {
          o.disconnect()
        } catch {
          /* ignore */
        }
      }
    },
  }
}
