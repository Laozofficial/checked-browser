import { afterEach, describe, expect, it, vi } from 'vitest'
import { Checked, getClient } from '../src/index'
import { parseUserAgent } from '../src/ua'
import { rate } from '../src/integrations/performance'
import { stripQueriesInText } from '../src/utils'
import { start } from './helpers'

afterEach(async () => {
  await Checked.close()
  vi.restoreAllMocks()
})

describe('user agent parser', () => {
  const cases: Array<[string, string, string, string, string, string]> = [
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Chrome', '129', 'Windows', '10', 'desktop',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.2792.79',
      'Edge', '129', 'Windows', '10', 'desktop',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
      'Safari', '17', 'macOS', '10.15', 'desktop',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
      'Safari', '17', 'iOS', '17.4', 'mobile',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
      'Samsung Internet', '25', 'Android', '14', 'mobile',
    ],
    [
      'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
      'Firefox', '131', 'Linux', '', 'desktop',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 OPR/114.0.0.0',
      'Opera', '114', 'Windows', '10', 'desktop',
    ],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'Chrome', '129', 'ChromeOS', '14541', 'desktop',
    ],
    [
      'Mozilla/5.0 (iPad; CPU OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1',
      'Safari', '16', 'iOS', '16.6', 'tablet',
    ],
  ]
  it.each(cases)('%s', (ua, bn, bv, on, ov, dev) => {
    const p = parseUserAgent(ua)
    expect(p.browser).toEqual({ name: bn, version: bv })
    expect(p.os).toEqual({ name: on, version: ov })
    expect(p.device).toBe(dev)
  })
})

describe('vitals', () => {
  it('rates with the documented thresholds', () => {
    expect(rate('LCP', 2400)).toBe('good')
    expect(rate('LCP', 3000)).toBe('needs-improvement')
    expect(rate('LCP', 4001)).toBe('poor')
    expect(rate('INP', 501)).toBe('poor')
    expect(rate('CLS', 0.26)).toBe('poor')
    expect(rate('CLS', 0.11)).toBe('needs-improvement')
    expect(rate('TTFB', 1801)).toBe('poor')
    expect(rate('load', 8001)).toBe('poor')
  })

  it('only poor vitals are sent unless reportAllVitals', async () => {
    let h = start()
    getClient()!.recordVital('LCP', 3000, 'needs-improvement')
    getClient()!.recordVital('LCP', 5000, 'poor')
    await Checked.flush()
    expect(h.events().map((e) => e.type === 'performance' && e.performance)).toEqual([
      { metric: 'LCP', value: 5000, rating: 'poor' },
    ])
    await Checked.close()
    h = start({ reportAllVitals: true })
    getClient()!.recordVital('CLS', 0.123456, 'needs-improvement')
    await Checked.flush()
    expect(h.events()[0]).toMatchObject({ type: 'performance', performance: { metric: 'CLS', value: 0.1235 } })
  })

  it('installs without PerformanceObserver', () => {
    vi.stubGlobal('PerformanceObserver', undefined)
    try {
      expect(() => start()).not.toThrow()
      expect(getClient()).not.toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reports LCP and CLS on page hide from PerformanceObserver entries', async () => {
    const observers: Array<{ type: string; cb: (l: { getEntries(): unknown[] }) => void }> = []
    class FakePO {
      static supportedEntryTypes = ['largest-contentful-paint', 'event', 'layout-shift']
      constructor(private cb: (l: { getEntries(): unknown[] }) => void) {}
      observe(o: { type: string }) {
        observers.push({ type: o.type, cb: this.cb })
      }
      disconnect() {}
    }
    vi.stubGlobal('PerformanceObserver', FakePO)
    try {
      const h = start()
      const emit = (type: string, entries: unknown[]) =>
        observers.filter((o) => o.type === type).forEach((o) => o.cb({ getEntries: () => entries }))
      emit('largest-contentful-paint', [{ startTime: 1200 }, { startTime: 4500 }])
      emit('event', [{ interactionId: 1, duration: 120 }])
      emit('layout-shift', [
        { startTime: 100, value: 0.2, hadRecentInput: false },
        { startTime: 600, value: 0.1, hadRecentInput: false },
        { startTime: 700, value: 0.5, hadRecentInput: true },
      ])
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      await Checked.flush()
      await new Promise((r) => setTimeout(r, 0))
      const perf = h.events().map((e) => (e.type === 'performance' ? e.performance : null))
      expect(perf).toEqual([
        { metric: 'LCP', value: 4500, rating: 'poor' },
        { metric: 'CLS', value: 0.3, rating: 'poor' },
      ])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('text privacy helpers', () => {
  it('strips queries in stack frames and keeps line:col', () => {
    expect(stripQueriesInText('at a (https://x.test/app.js?v=1:2:3)')).toBe('at a (https://x.test/app.js:2:3)')
    expect(stripQueriesInText('at https://x.test/app.js?v=1#h:20:30')).toBe('at https://x.test/app.js:20:30')
    expect(stripQueriesInText('GET https://x.test/a?b=c failed')).toBe('GET https://x.test/a failed')
  })
})
