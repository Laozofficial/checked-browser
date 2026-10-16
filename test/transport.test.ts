import { afterEach, describe, expect, it, vi } from 'vitest'
import { Checked } from '../src/index'
import { start, settle } from './helpers'

afterEach(async () => {
  vi.useRealTimers()
  await Checked.close()
  vi.restoreAllMocks()
})

async function tick(ms: number) {
  await vi.advanceTimersByTimeAsync(ms)
}

describe('batching', () => {
  it('flushes after the interval', async () => {
    vi.useFakeTimers()
    const h = start()
    Checked.track('a')
    Checked.track('b')
    expect(h.batches.length).toBe(0)
    await tick(5000)
    expect(h.batches.length).toBe(1)
    expect(h.batches[0].events.length).toBe(2)
  })

  it('10 queued events trigger one flush immediately', async () => {
    vi.useFakeTimers()
    const h = start()
    for (let i = 0; i < 10; i++) Checked.track('e' + i)
    await tick(0)
    expect(h.batches.length).toBe(1)
    expect(h.batches[0].events.length).toBe(10)
  })

  it('60 events split into batches of at most 50', async () => {
    const h = start({ maxEventsPerPage: 1000, flushIntervalMs: 60_000 })
    // Hold the network while queueing so the size-trigger flushes stack up.
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    for (let i = 0; i < 60; i++) Checked.track('e' + i)
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    await Checked.flush()
    expect(h.batches.map((b) => b.events.length)).toEqual([50, 10])
  })

  it('keeps each body under 60 KB', async () => {
    const h = start({ maxEventsPerPage: 1000 })
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    const big = 'x'.repeat(900)
    for (let i = 0; i < 40; i++) {
      const props: Record<string, string> = {}
      for (let k = 0; k < 3; k++) props['p' + k] = big
      Checked.track('big' + i, props)
    }
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
    await Checked.flush()
    expect(h.batches.length).toBeGreaterThan(1)
    for (const call of h.fetchMock.mock.calls) {
      const body = String((call[1] as RequestInit).body)
      expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(60 * 1024)
    }
    expect(h.events().length).toBe(40)
  })

  it('posts text/plain with keepalive and no credentials', async () => {
    const h = start()
    Checked.track('x')
    await Checked.flush()
    const init = h.fetchMock.mock.calls[0][1] as RequestInit
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit', mode: 'cors' })
    expect(init.headers).toEqual({ 'Content-Type': 'text/plain;charset=UTF-8' })
  })

  it('uses sendBeacon on page hide', async () => {
    const h = start()
    const beacon = vi.fn(() => true)
    ;(navigator as unknown as { sendBeacon: unknown }).sendBeacon = beacon
    try {
      Checked.track('leaving')
      window.dispatchEvent(new Event('pagehide'))
      expect(beacon).toHaveBeenCalledTimes(1)
      const [url, blob] = beacon.mock.calls[0] as unknown as [string, Blob]
      expect(url).toContain('?key=ck_pub_test')
      expect(blob.type).toBe('text/plain;charset=utf-8')
      expect(h.batches.length).toBe(0)
    } finally {
      delete (navigator as unknown as { sendBeacon?: unknown }).sendBeacon
    }
  })
})

describe('retry', () => {
  it('retries a 503 with exponential backoff', async () => {
    vi.useFakeTimers()
    const h = start()
    h.ingestStatuses = [503, 503, 202]
    Checked.track('x')
    await Checked.flush()
    expect(h.batches.length).toBe(1)
    await tick(999)
    expect(h.batches.length).toBe(1)
    await tick(1)
    expect(h.batches.length).toBe(2)
    await tick(1999)
    expect(h.batches.length).toBe(2)
    await tick(1)
    expect(h.batches.length).toBe(3)
    // Delivered; no more attempts.
    await tick(60_000)
    expect(h.batches.length).toBe(3)
    expect(h.batches[2].events[0].type).toBe('custom')
  })

  it('gives up after 5 attempts and reports the drop', async () => {
    vi.useFakeTimers()
    const h = start()
    h.ingestStatuses = [500, 500, 500, 500, 500, 202]
    Checked.track('x')
    await Checked.flush()
    await tick(1000 + 2000 + 4000 + 8000)
    expect(h.batches.length).toBe(5)
    Checked.track('y')
    await Checked.flush()
    const last = h.batches[h.batches.length - 1]
    expect(last.client.dropped).toBe(1)
    expect(last.events.length).toBe(1)
  })

  it('does not retry a 403', async () => {
    vi.useFakeTimers()
    const h = start()
    h.ingestStatuses = [403]
    Checked.track('x')
    await Checked.flush()
    await tick(120_000)
    expect(h.batches.length).toBe(1)
  })

  it('respects Retry-After on 429', async () => {
    vi.useFakeTimers()
    const h = start()
    let calls = 0
    const ingest = h.fetchMock.getMockImplementation()!
    h.fetchMock.mockImplementation(async (input: unknown, init?: RequestInit) => {
      if (String(input).includes('/ingest/') && calls++ === 0) {
        h.batches.push(JSON.parse(String(init?.body)))
        return { status: 429, headers: { get: (n: string) => (n === 'Retry-After' ? '7' : null) } }
      }
      return ingest(input, init)
    })
    Checked.track('x')
    await Checked.flush()
    await tick(6999)
    expect(h.batches.length).toBe(1)
    await tick(1)
    expect(h.batches.length).toBe(2)
  })
})

describe('offline', () => {
  it('holds events while offline, caps the queue at 200 (oldest dropped) and reports client.dropped', async () => {
    const h = start({ maxEventsPerPage: 1000 })
    const spy = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false)
    for (let i = 0; i < 205; i++) Checked.track('e' + i)
    await Checked.flush()
    expect(h.batches.length).toBe(0)
    spy.mockReturnValue(true)
    window.dispatchEvent(new Event('online'))
    await settle()
    await Checked.flush()
    const names = h.events().map((e) => (e.type === 'custom' ? e.custom.name : ''))
    expect(names.length).toBe(200)
    expect(names[0]).toBe('e5')
    expect(names[199]).toBe('e204')
    expect(h.batches[0].client.dropped).toBe(5)
    expect(h.batches[1].client.dropped).toBe(0)
  })
})
