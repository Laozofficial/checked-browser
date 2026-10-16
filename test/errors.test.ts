import { afterEach, describe, expect, it, vi } from 'vitest'
import { Checked } from '../src/index'
import { start, settle, errorEvents } from './helpers'

afterEach(async () => {
  await Checked.close()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function dispatchError(error: unknown, message = 'boom') {
  const ev = new ErrorEvent('error', { error, message, filename: 'https://app.test/main.js', lineno: 3, colno: 7 })
  window.dispatchEvent(ev)
}

describe('error capture', () => {
  it('captures an uncaught ErrorEvent with its stack and the wire shape', async () => {
    const h = start({ release: '1.4.2' })
    const err = new TypeError('x is not a function')
    err.stack = 'TypeError: x is not a function\n    at render (https://app.test/main.js?v=42:10:5)'
    dispatchError(err)
    await Checked.flush()
    expect(h.batches.length).toBe(1)
    const b = h.batches[0]
    expect(b.key).toBe('ck_pub_test')
    expect(b.sdk).toEqual({ name: 'checked.browser', version: '1.0.0' })
    expect(typeof b.sentAt).toBe('number')
    expect(b.client).toEqual({ dropped: 0 })
    expect(h.ingestUrls[0]).toBe('https://ingest.test/api/v1/ingest/events?key=ck_pub_test')
    const e = errorEvents(h)[0]
    expect(e.environment).toBe('test')
    expect(e.release).toBe('1.4.2')
    expect(e.id).toMatch(/^[0-9a-f]{32}$/)
    expect(e.user.anonymousId).toMatch(/^a_/)
    expect(e.sessionId).toMatch(/^s_/)
    expect(e.error).toEqual({
      type: 'TypeError',
      message: 'x is not a function',
      // query string stripped inside the stack, line and column kept
      stack: 'TypeError: x is not a function\n    at render (https://app.test/main.js:10:5)',
      handled: false,
      mechanism: 'onerror',
    })
    expect(e.context.device).toBeDefined()
    expect(e.context.viewport).toBeDefined()
  })

  it('captures an ErrorEvent without an error object', async () => {
    const h = start()
    dispatchError(undefined, 'Script error.')
    await Checked.flush()
    expect(errorEvents(h)[0].error.message).toBe('Script error.')
  })

  it('ignores resource load errors', async () => {
    const h = start()
    const img = document.createElement('img')
    document.body.appendChild(img)
    img.dispatchEvent(new Event('error'))
    await Checked.flush()
    expect(errorEvents(h).length).toBe(0)
  })

  it('captures unhandledrejection with an Error reason and a non-Error reason', async () => {
    const h = start()
    const e1 = new Event('unhandledrejection') as Event & { reason: unknown }
    e1.reason = new RangeError('bad range')
    window.dispatchEvent(e1)
    const e2 = new Event('unhandledrejection') as Event & { reason: unknown }
    const cyclic: Record<string, unknown> = { code: 7 }
    cyclic.self = cyclic
    e2.reason = cyclic
    window.dispatchEvent(e2)
    await Checked.flush()
    const errs = errorEvents(h)
    expect(errs[0].error).toMatchObject({ type: 'RangeError', message: 'bad range', mechanism: 'unhandledrejection' })
    expect(errs[1].error.type).toBe('UnhandledRejection')
    expect(errs[1].error.message).toContain('"code":7')
    expect(errs[1].error.message).toContain('[Circular]')
  })

  it('console.error is captured only when opted in, and still prints', async () => {
    const printed: unknown[][] = []
    const original = console.error
    const stub = (...a: unknown[]) => {
      printed.push(a)
    }
    console.error = stub
    try {
      let h = start()
      console.error('not captured')
      await Checked.flush()
      expect(errorEvents(h).length).toBe(0)
      await Checked.close()

      h = start({ captureConsoleErrors: true })
      console.error('failed to load', { id: 3 })
      console.error(new Error('real error'))
      await Checked.flush()
      const errs = errorEvents(h)
      expect(errs.length).toBe(2)
      expect(errs[0].error).toMatchObject({ type: 'ConsoleError', message: 'failed to load {"id":3}', handled: true, mechanism: 'console' })
      expect(errs[1].error).toMatchObject({ type: 'Error', mechanism: 'console' })
      expect(errs[1].breadcrumbs.some((b) => b.type === 'console')).toBe(true)
      expect(printed.length).toBe(3)
      await Checked.close()
      expect(console.error).toBe(stub)
    } finally {
      console.error = original
    }
  })

  it('captureError and captureMessage with tags and extra', async () => {
    const h = start()
    Checked.setTag('plan', 'pro')
    Checked.captureError(new Error('manual'), { tags: { area: 'checkout' }, extra: { orderId: 9 } })
    Checked.captureMessage('cache cold', 'warning')
    await Checked.flush()
    const [a, b] = errorEvents(h)
    expect(a.error).toMatchObject({ handled: true, mechanism: 'manual' })
    expect(a.tags).toEqual({ plan: 'pro', area: 'checkout' })
    expect(a.extra).toEqual({ orderId: 9 })
    expect(b.error).toMatchObject({ type: 'Message', message: 'cache cold', handled: true })
    expect(b.tags.level).toBe('warning')
  })

  it('dedupes identical errors within one second', async () => {
    vi.useFakeTimers({ now: 1_000_000 })
    const h = start()
    const make = () => {
      const e = new Error('same')
      e.stack = 'Error: same\n    at f (https://app.test/a.js:1:1)'
      return e
    }
    Checked.captureError(make())
    Checked.captureError(make())
    vi.setSystemTime(1_000_000 + 1500)
    Checked.captureError(make())
    await Checked.flush()
    expect(errorEvents(h).length).toBe(2)
  })

  it('scrubs secrets and truncates long messages', async () => {
    const h = start()
    Checked.captureError(new Error('auth failed Bearer abcdefghijklmnop123 password=hunter2&x=1 ' + 'z'.repeat(2000)))
    await Checked.flush()
    const m = errorEvents(h)[0].error.message
    expect(m).not.toContain('abcdefghijklmnop123')
    expect(m).not.toContain('hunter2')
    expect(m).toContain('Bearer [Filtered]')
    expect(m).toContain('password=[Filtered]')
    expect(m.length).toBeLessThanOrEqual(1000)
  })

  it('beforeSend can scrub and drop', async () => {
    const h = start({
      beforeSend(ev) {
        if (ev.type === 'error' && ev.error.message.includes('drop me')) return null
        if (ev.type === 'error') ev.error.message = ev.error.message.replace(/\d{4}/g, '****')
        return ev
      },
    })
    Checked.captureError(new Error('card 4242 declined'))
    Checked.captureError(new Error('please drop me'))
    await Checked.flush()
    const errs = errorEvents(h)
    expect(errs.length).toBe(1)
    expect(errs[0].error.message).toBe('card **** declined')
  })

  it('a throwing beforeSend drops the event and never throws into the app', async () => {
    const h = start({
      beforeSend() {
        throw new Error('bug in hook')
      },
    })
    expect(() => Checked.captureError(new Error('x'))).not.toThrow()
    await Checked.flush()
    expect(h.batches.length).toBe(0)
  })

  it('sampleRate 0 drops errors but not custom events', async () => {
    const h = start({ sampleRate: 0 })
    Checked.captureError(new Error('sampled out'))
    Checked.track('checkout_completed', { total: 12.5, currency: 'NGN', nested: { no: 1 }, ok: true })
    await Checked.flush()
    const evs = h.events()
    expect(evs.length).toBe(1)
    expect(evs[0].type).toBe('custom')
    if (evs[0].type === 'custom') {
      expect(evs[0].custom).toEqual({ name: 'checkout_completed', props: { total: 12.5, currency: 'NGN', ok: true } })
    }
  })

  it('caps events per page load', async () => {
    const h = start({ maxEventsPerPage: 5 })
    for (let i = 0; i < 8; i++) Checked.track('e' + i)
    await Checked.flush()
    await settle()
    expect(h.events().length).toBe(5)
  })

  it('attachReplay sets replayId on error events only', async () => {
    const h = start()
    const flush = vi.fn(async () => 'r_1')
    Checked.attachReplay({ replayId: 'r_1', start() {}, stop() {}, flush })
    Checked.captureError(new Error('with replay'))
    Checked.track('no replay')
    await Checked.flush()
    const evs = h.events()
    expect(evs[0].replayId).toBe('r_1')
    expect(evs[1].replayId).toBeUndefined()
    expect(flush).toHaveBeenCalledWith('error')
  })
})
