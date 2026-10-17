import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { Blob as NodeBlob } from 'node:buffer'
import { Checked, getClient, optionsFromScript } from '../src/index'
import type { ReplayHost, ReplayRecorder } from '../src/replay'
import { createReplay, optionsFromTag, stopReplay } from '../src/replay/index'
import { REPLAY_LIMITS, Recorder, gzipBase64, type RecordApi } from '../src/replay/recorder'
import { Scrubber } from '../src/replay/scrub'
import { SDK_VERSION } from '../src/version'
import { start, settle, errorEvents, requestEvents } from './helpers'

const REPLAY_URL = 'https://ingest.test/api/v1/ingest/replay?key=ck_pub_test'

type Sent = { url: string; body: any; keepalive: boolean }

function uploads() {
  const sent: Sent[] = []
  let reply: () => { status: number; json?: unknown; headers?: Record<string, string> } = () => ({ status: 202, json: { accepted: true } })
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)), keepalive: !!init.keepalive })
    const r = reply()
    return { status: r.status, json: async () => r.json ?? {}, headers: { get: (h: string) => (r.headers ?? {})[h] ?? null } } as unknown as Response
  })
  return {
    sent,
    fetchMock,
    reply(fn: typeof reply) {
      reply = fn
    },
    /** Every rrweb event that was uploaded, in order, decoded. */
    events(): any[] {
      return sent
        .slice()
        .sort((a, b) => a.body.replay.seq - b.body.replay.seq)
        .flatMap((s) => (s.body.encoding === 'gzip' ? JSON.parse(gunzipSync(Buffer.from(s.body.data, 'base64')).toString('utf8')) : s.body.data))
    },
  }
}

function makeHost(fetchMock: unknown, options: ReplayHost['options'] = {}, sid = 's_1'): ReplayHost {
  return {
    options,
    url: REPLAY_URL,
    fetch: fetchMock as typeof fetch,
    client: {
      key: 'ck_pub_test',
      opts: { environment: 'test', release: '2.0.0', captureQueryStrings: false, debug: false },
      sessionId: () => sid,
      getUser: () => ({ anonymousId: 'a_1', id: 'u_7' }),
      context: () => ({ browser: { name: 'Chrome', version: '129' }, os: { name: 'Windows', version: '10' }, device: 'desktop', viewport: { w: 1440, h: 900 } }),
      log: () => {},
    },
  }
}

/** A stand-in for rrweb: a meta + full snapshot at start and on every checkout. */
function fakeRrweb() {
  let emit: ((e: any, isCheckout?: boolean) => void) | null = null
  const options: Record<string, unknown>[] = []
  const snap = (checkout: boolean) => {
    emit?.({ type: 4, data: { href: location.href, width: 1, height: 1 }, timestamp: Date.now() }, checkout)
    emit?.({ type: 2, data: { node: { type: 0, id: 1, childNodes: [] }, initialOffset: { top: 0, left: 0 } }, timestamp: Date.now() }, checkout)
  }
  const api: RecordApi & { emit(e: any): void; options: Record<string, unknown>[]; running(): boolean } = {
    options,
    record(o) {
      options.push(o)
      emit = o.emit as typeof emit
      snap(false)
      return () => {
        emit = null
      }
    },
    addCustomEvent(tag, payload) {
      if (!emit) throw new Error('not recording')
      emit({ type: 5, data: { tag, payload }, timestamp: Date.now() })
    },
    takeFullSnapshot(isCheckout) {
      snap(!!isCheckout)
    },
    emit(e) {
      emit?.({ timestamp: Date.now(), ...e })
    },
    running: () => !!emit,
  }
  return api
}

const mouse = (n: number) => ({ type: 3, data: { source: 1, positions: [{ x: n, y: n, id: 1, timeOffset: 0 }] } })
const customs = (events: any[], a?: string) => events.filter((e) => e.type === 5 && e.data.tag === 'checked' && (!a || e.data.payload.a === a)).map((e) => e.data.payload)

beforeEach(() => {
  window.sessionStorage.clear()
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
})

afterEach(async () => {
  stopReplay()
  await Checked.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  Object.defineProperty(navigator, 'doNotTrack', { value: null, configurable: true })
  delete (window as { CheckedReplay?: unknown }).CheckedReplay
})

describe('core SDK: loading and linking', () => {
  it('attaches the recorder from replay.load and links error events to it', async () => {
    const flush = vi.fn(async () => 'r1')
    const recorder: ReplayRecorder = { start() {}, stop: vi.fn(), flush, replayId: 'abc123' }
    let host: ReplayHost | null = null
    const h = start({ replay: { onErrorSampleRate: 1, load: async () => ({ createReplay: (x: ReplayHost) => ((host = x), recorder) }) } })
    await settle()
    expect(host!.url).toBe('https://ingest.test/api/v1/ingest/replay?key=ck_pub_test')
    expect(host!.client.opts.environment).toBe('test')
    Checked.captureError(new TypeError('cart is empty'))
    await Checked.flush()
    const [ev] = errorEvents(h)
    expect(ev.replayId).toBe('abc123')
    expect(flush).toHaveBeenCalledWith('error', { eventId: ev.id, message: 'TypeError: cart is empty' })
  })

  it('failed requests carry the replay id too and flush with reason "request"', async () => {
    const flush = vi.fn(async () => 'r1')
    const h = start({ replay: { load: async () => ({ default: { createReplay: () => ({ start() {}, stop() {}, flush, replayId: 'req1' }) } }) } })
    await settle()
    h.setApp(() => ({ status: 503 }))
    await fetch('https://api.example.com/pay?card=4242')
    await Checked.flush()
    const [r] = requestEvents(h)
    expect(r.replayId).toBe('req1')
    expect(flush).toHaveBeenCalledWith('request', { eventId: r.id, message: 'GET https://api.example.com/pay 503' })
  })

  it('without replay options nothing is loaded', async () => {
    start()
    await settle()
    expect(document.querySelector('script[src*="checked-replay"]')).toBeNull()
  })

  it('injects the versioned replay script and attaches window.CheckedReplay once it loads', async () => {
    start({ replay: { src: 'https://cdn.test/sdk/checked-replay.v' + SDK_VERSION + '.min.js' } })
    const tag = document.querySelector('script[src*="checked-replay"]') as HTMLScriptElement
    expect(tag.src).toBe('https://cdn.test/sdk/checked-replay.v' + SDK_VERSION + '.min.js')
    const rec = { start() {}, stop() {}, flush: async () => null, replayId: 'tag1' }
    ;(window as any).CheckedReplay = { createReplay: () => rec }
    tag.onload!(new Event('load'))
    expect((getClient() as any).replay).toBe(rec)
  })

  it('the script tag turns replay on with data-replay and points at the matching bundle', () => {
    const s = document.createElement('script')
    s.src = 'https://cdn.example.com/sdk/checked.v1.min.js?x=1'
    s.setAttribute('data-key', 'ck_pub_abc')
    s.setAttribute('data-replay', 'true')
    expect(optionsFromScript(s)!.replay).toEqual({ src: `https://cdn.example.com/sdk/checked-replay.v${SDK_VERSION}.min.js` })
    s.removeAttribute('data-replay')
    expect(optionsFromScript(s)!.replay).toBeUndefined()
  })

  it('the replay bundle reads the other data-replay-* attributes from the tag', () => {
    const s = document.createElement('script')
    s.setAttribute('data-key', 'ck_pub_abc')
    s.setAttribute('data-replay', 'true')
    s.setAttribute('data-replay-sample-rate', '0.1')
    s.setAttribute('data-replay-error-sample-rate', '0.5')
    s.setAttribute('data-replay-mask-all-text', 'true')
    s.setAttribute('data-replay-block', '.ads')
    document.head.appendChild(s)
    expect(optionsFromTag({ src: 'x', sampleRate: 0.9 })).toMatchObject({ src: 'x', sampleRate: 0.9, onErrorSampleRate: 0.5, maskAllText: true, blockSelector: '.ads' })
  })

  it('close() stops an attached recorder, and a recorder attached after close is stopped at once', async () => {
    const stop = vi.fn()
    start({ replay: { load: async () => ({ createReplay: () => ({ start() {}, stop, flush: async () => null, replayId: 'x' }) }) } })
    await settle()
    await Checked.close()
    expect(stop).toHaveBeenCalledTimes(1)
  })
})

describe('recorder: sampling and modes', () => {
  it('buffer mode (the default) uploads nothing until an error, then the last segments', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['setTimeout', 'setInterval', 'Date'] })
    const u = uploads()
    const api = fakeRrweb()
    const r = new Recorder(makeHost(u.fetchMock), api)
    r.start()
    expect(r.mode).toBe('buffer')
    expect(r.replayId).toMatch(/^[a-f0-9]{32}$/)
    api.emit(mouse(1))
    await vi.advanceTimersByTimeAsync(REPLAY_LIMITS.bufferSegmentMs) // checkout 1: segment 2 starts
    api.emit(mouse(2))
    await vi.advanceTimersByTimeAsync(REPLAY_LIMITS.bufferSegmentMs) // checkout 2: segment 1 dropped
    api.emit(mouse(3))
    expect(u.sent.length).toBe(0)

    const id = await r.flush('error', { eventId: 'ev1', message: 'TypeError: x' })
    expect(id).toBe(r.replayId)
    const evs = u.events()
    const xs = evs.filter((e) => e.type === 3).map((e) => e.data.positions[0].x)
    expect(xs).toEqual([2, 3]) // 30 to 60 seconds kept, older dropped
    expect(evs[0].type).toBe(4) // starts with meta + full snapshot, so it can play
    expect(evs[1].type).toBe(2)
    expect(customs(evs, 'error')[0]).toMatchObject({ message: 'TypeError: x', eventId: 'ev1' })
    const meta = u.sent[0].body.replay
    expect(meta).toMatchObject({ id: r.replayId, seq: 0, mode: 'buffer', reason: 'error', environment: 'test', release: '2.0.0', user: { anonymousId: 'a_1', id: 'u_7' }, sessionId: 's_1' })
    expect(meta.context.browser).toEqual({ name: 'Chrome', version: '129' })
    expect(u.sent[0].url).toBe(REPLAY_URL)

    // After the error it keeps recording and uploads on the interval.
    api.emit(mouse(4))
    await vi.advanceTimersByTimeAsync(REPLAY_LIMITS.flushMs)
    expect(u.sent.length).toBe(2)
    expect(u.sent[1].body.replay.seq).toBe(1)
  })

  it('session sample rate records from the start and uploads every interval', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['setTimeout', 'setInterval', 'Date'] })
    vi.spyOn(Math, 'random').mockReturnValue(0.05)
    const u = uploads()
    const api = fakeRrweb()
    const r = new Recorder(makeHost(u.fetchMock, { sampleRate: 0.1 }), api)
    r.start()
    expect(r.mode).toBe('session')
    api.emit(mouse(9))
    await vi.advanceTimersByTimeAsync(REPLAY_LIMITS.flushMs)
    expect(u.sent.length).toBe(1)
    expect(u.events().some((e) => e.type === 3)).toBe(true)
    expect(customs(u.events(), 'nav')[0]).toMatchObject({ cause: 'load' })
  })

  it('not sampled: nothing recorded and no replay id', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const api = fakeRrweb()
    const r = new Recorder(makeHost(vi.fn(), { sampleRate: 0.1, onErrorSampleRate: 0.5 }), api)
    r.start()
    expect(r.mode).toBe('off')
    expect(r.replayId).toBeNull()
    expect(api.options.length).toBe(0)
  })

  it('the decision sticks for the tab session; a sampled-out session stays out on the next page', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    new Recorder(makeHost(vi.fn(), { onErrorSampleRate: 0.5 }), fakeRrweb()).start()
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    const second = new Recorder(makeHost(vi.fn(), { onErrorSampleRate: 0.5 }), fakeRrweb())
    second.start()
    expect(second.mode).toBe('off')
  })

  it('a session mode replay continues on the next page of the same tab session', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    const u = uploads()
    const first = new Recorder(makeHost(u.fetchMock, { sampleRate: 1 }), fakeRrweb())
    first.start()
    await first.flush('interval')
    const id = first.replayId
    first.stop()
    const next = new Recorder(makeHost(u.fetchMock, { sampleRate: 1 }), fakeRrweb())
    next.start()
    expect(next.replayId).toBe(id)
    await next.flush('interval')
    const seqs = u.sent.map((s) => s.body.replay.seq)
    expect(new Set(seqs).size).toBe(seqs.length) // no sequence number reused
  })

  it('Do Not Track turns replay off', () => {
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true })
    const api = fakeRrweb()
    const r = new Recorder(makeHost(vi.fn()), api)
    r.start()
    expect(r.replayId).toBeNull()
    expect(api.options.length).toBe(0)
  })

  it('stops for good when the server says stop (over quota), and when a chunk is rejected', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    const u = uploads()
    u.reply(() => ({ status: 200, json: { accepted: false, stop: true, reason: 'over_quota' } }))
    const api = fakeRrweb()
    const r = new Recorder(makeHost(u.fetchMock, { sampleRate: 1 }), api)
    r.start()
    await r.flush('interval')
    expect(r.replayId).toBeNull()
    expect(api.running()).toBe(false)
    expect(JSON.parse(sessionStorage.getItem('checked.replay')!).mode).toBe('off')

    sessionStorage.clear()
    const u2 = uploads()
    u2.reply(() => ({ status: 413 }))
    const r2 = new Recorder(makeHost(u2.fetchMock, { sampleRate: 1 }), fakeRrweb())
    r2.start()
    await r2.flush('interval')
    expect(r2.replayId).toBeNull()
  })

  it('retries 5xx with backoff and gives up quietly', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    const saved = REPLAY_LIMITS.backoffMs
    REPLAY_LIMITS.backoffMs = 1
    try {
      const u = uploads()
      u.reply(() => ({ status: 503 }))
      const r = new Recorder(makeHost(u.fetchMock, { sampleRate: 1 }), fakeRrweb())
      r.start()
      await r.flush('interval')
      expect(u.sent.length).toBe(REPLAY_LIMITS.attempts)
      expect(r.replayId).not.toBeNull()
    } finally {
      REPLAY_LIMITS.backoffMs = saved
    }
  })

  it('stops at the length cap', async () => {
    vi.useFakeTimers({ now: 1_000_000, toFake: ['setTimeout', 'setInterval', 'Date'] })
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    const api = fakeRrweb()
    const r = new Recorder(makeHost(uploads().fetchMock, { sampleRate: 1, maxDurationMinutes: 1 }), api)
    r.start()
    await vi.advanceTimersByTimeAsync(70_000)
    expect(r.replayId).toBeNull()
    expect(api.running()).toBe(false)
  })
})

describe('recorder: upload format', () => {
  it('splits big uploads into chunks under the raw cap, in sequence', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    const saved = REPLAY_LIMITS.chunkRawBytes
    REPLAY_LIMITS.chunkRawBytes = 2_000
    try {
      const u = uploads()
      const api = fakeRrweb()
      const r = new Recorder(makeHost(u.fetchMock, { sampleRate: 1 }), api)
      r.start()
      for (let i = 0; i < 30; i++) api.emit({ type: 3, data: { source: 0, texts: [{ id: i, value: 'x'.repeat(200) }], attributes: [], removes: [], adds: [] } })
      await r.flush('interval')
      expect(u.sent.length).toBeGreaterThan(2)
      expect(u.sent.map((s) => s.body.replay.seq)).toEqual(u.sent.map((_, i) => i))
      for (const s of u.sent) expect(JSON.stringify(s.body.data).length).toBeLessThan(2_000 + 400)
      expect(u.events().filter((e) => e.type === 3).length).toBe(30)
    } finally {
      REPLAY_LIMITS.chunkRawBytes = saved
    }
  })

  it('gzip + base64 when CompressionStream is available, plain JSON otherwise', async () => {
    const text = JSON.stringify([{ type: 4, data: { href: 'https://a.test/' }, timestamp: 1 }])
    const OrigBlob = globalThis.Blob
    ;(globalThis as any).Blob = NodeBlob
    try {
      const b64 = await gzipBase64(text)
      expect(b64).toBeTruthy()
      expect(gunzipSync(Buffer.from(b64!, 'base64')).toString('utf8')).toBe(text)
    } finally {
      ;(globalThis as any).Blob = OrigBlob
    }
    const CS = (globalThis as any).CompressionStream
    ;(globalThis as any).CompressionStream = undefined
    try {
      expect(await gzipBase64(text)).toBeNull()
      vi.spyOn(Math, 'random').mockReturnValue(0.01)
      const u = uploads()
      const r = new Recorder(makeHost(u.fetchMock, { sampleRate: 1 }), fakeRrweb())
      r.start()
      await r.flush('interval')
      expect(u.sent[0].body.encoding).toBe('json')
      expect(Array.isArray(u.sent[0].body.data)).toBe(true)
    } finally {
      ;(globalThis as any).CompressionStream = CS
    }
  })

  it('page hide sends what session mode holds with keepalive', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    const u = uploads()
    const api = fakeRrweb()
    const r = new Recorder(makeHost(u.fetchMock, { sampleRate: 1 }), api)
    r.start()
    window.dispatchEvent(new Event('pagehide'))
    await settle()
    expect(u.sent.length).toBe(1)
    expect(u.sent[0].keepalive).toBe(true)
    expect(u.sent[0].body.encoding).toBe('json')
    r.stop()
  })
})

describe('recorder: privacy defaults', () => {
  it('passes masking, blocking and no-canvas options to rrweb', () => {
    const api = fakeRrweb()
    new Recorder(makeHost(vi.fn(), { blockSelector: '.ads', maskSelector: '.pii' }), api).start()
    const o = api.options[0] as any
    expect(o.maskAllInputs).toBe(true)
    expect(o.blockSelector).toBe('[data-checked-block],.ads')
    expect(o.maskTextSelector).toBe('[data-checked-mask],.pii')
    expect(o.recordCanvas).toBe(false)
    expect(o.recordCrossOriginIframes).toBe(false)
    expect(o.inlineImages).toBe(false)
    const pw = document.createElement('input')
    pw.type = 'password'
    expect(o.maskInputFn('hunter2hunter2', pw)).toBe('********')
    expect(o.maskInputFn('abc', document.createElement('input'))).toBe('***')
  })

  it('maskAllText masks every text node', () => {
    const api = fakeRrweb()
    new Recorder(makeHost(vi.fn(), { maskAllText: true }), api).start()
    expect((api.options[0] as any).maskTextSelector).toBe('*')
  })

  it('records actions without values: clicks, typed length, passwords without length, masked names', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    document.body.innerHTML = `
      <button data-testid="pay">Pay now</button>
      <label for="em">Email</label><input id="em" name="email" type="email">
      <input id="pw" type="password">
      <div data-checked-mask><button id="secret-btn">Jane Doe</button></div>
      <div data-checked-block><button id="blocked">Hidden</button></div>
      <input id="tick" type="checkbox">
      <label id="tick-label"><input id="tick2" type="checkbox"> Gift wrap</label>`
    const u = uploads()
    const r = new Recorder(makeHost(u.fetchMock, { sampleRate: 1 }), fakeRrweb())
    r.start()
    ;(document.querySelector('[data-testid=pay]') as HTMLElement).click()
    const em = document.getElementById('em') as HTMLInputElement
    em.click()
    em.value = 'jane@example.com'
    em.dispatchEvent(new Event('change', { bubbles: true }))
    const pw = document.getElementById('pw') as HTMLInputElement
    pw.value = 'hunter2'
    pw.dispatchEvent(new Event('change', { bubbles: true }))
    em.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    document.getElementById('secret-btn')!.click()
    document.getElementById('blocked')!.click()
    ;(document.getElementById('tick') as HTMLInputElement).click()
    document.getElementById('tick-label')!.click()
    await r.flush('interval')
    const all = u.events()
    const json = JSON.stringify(all)
    expect(json).not.toContain('jane@example.com')
    expect(json).not.toContain('hunter2')
    expect(json).not.toContain('Jane Doe')
    const acts = customs(all)
    expect(acts.find((a) => a.a === 'click')).toMatchObject({ el: { tag: 'button', role: 'button', name: 'Pay now', testid: { attr: 'data-testid', value: 'pay' } } })
    expect(acts.filter((a) => a.a === 'click').some((a) => a.el.id === 'em')).toBe(false) // focusing a field is not a click
    expect(acts.find((a) => a.a === 'input' && a.el.id === 'em')).toMatchObject({ n: 16, el: { name: 'Email', nameAttr: 'email', type: 'email' } })
    const pwAct = acts.find((a) => a.a === 'input' && a.el.id === 'pw')
    expect(pwAct.secret).toBe(true)
    expect(pwAct.n).toBeUndefined()
    expect(acts.find((a) => a.a === 'press')).toMatchObject({ key: 'Enter' })
    expect(acts.find((a) => a.a === 'click' && a.el.id === 'secret-btn')).toMatchObject({ el: { masked: true } })
    expect(acts.find((a) => a.a === 'click' && a.el.id === 'secret-btn').el.name).toBeUndefined()
    expect(acts.find((a) => a.a === 'click' && a.el.blocked)).toMatchObject({ el: { tag: 'button', blocked: true } })
    expect(acts.find((a) => a.a === 'check')).toMatchObject({ checked: true })
    expect(acts.some((a) => a.a === 'click' && a.el.tag === 'label')).toBe(false) // the label click is the checkbox's change
    expect(acts.filter((a) => a.a === 'check').length).toBe(2)
  })

  it('page addresses and links lose their query strings', async () => {
    const s = new Scrubber(false)
    const meta = s.scrub({ type: 4, data: { href: 'https://shop.test/orders?token=abc#x' }, timestamp: 1 })
    expect(meta.data.href).toBe('https://shop.test/orders')
    const full = s.scrub({
      type: 2,
      timestamp: 1,
      data: { node: { type: 0, childNodes: [{ type: 2, id: 5, tagName: 'a', attributes: { href: '/reset?code=123' }, childNodes: [] }, { type: 2, id: 6, tagName: 'img', attributes: { src: '/i.png?sig=1' }, childNodes: [] }] } },
    })
    expect(full.data.node.childNodes[0].attributes.href).toBe('/reset')
    expect(full.data.node.childNodes[1].attributes.src).toBe('/i.png?sig=1') // images still load
    const mut = s.scrub({ type: 3, timestamp: 1, data: { source: 0, adds: [], removes: [], texts: [], attributes: [{ id: 5, attributes: { href: '/x?y=1' } }] } })
    expect(mut.data.attributes[0].attributes.href).toBe('/x')
    expect(new Scrubber(true).scrub({ type: 4, data: { href: 'https://a.test/?q=1' }, timestamp: 1 }).data.href).toBe('https://a.test/?q=1')
  })

  it('history navigation is recorded without the query string', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    const u = uploads()
    const r = new Recorder(makeHost(u.fetchMock, { sampleRate: 1 }), fakeRrweb())
    r.start()
    history.pushState(null, '', '/checkout?coupon=FREE')
    await r.flush('interval')
    r.stop()
    history.replaceState(null, '', '/')
    expect(customs(u.events(), 'nav').map((n) => n.url)).toContain('http://localhost:3000/checkout')
    expect(JSON.stringify(u.events())).not.toContain('FREE')
  })
})

describe('real rrweb in the page', () => {
  it('masks inputs and marked text, blocks marked elements, and never records the password', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.01)
    document.body.innerHTML = `
      <h1>Checkout</h1>
      <input id="card" value="4242 4242 4242 4242">
      <input id="pw" type="password" value="hunter2">
      <textarea id="note">call me on 0803</textarea>
      <p data-checked-mask>Jane Doe, 12 Allen Avenue</p>
      <div data-checked-block><span>Account balance 9,999</span></div>`
    const u = uploads()
    const rec = createReplay(makeHost(u.fetchMock, { sampleRate: 1 }))
    const card = document.getElementById('card') as HTMLInputElement
    card.value = '5555 6666 7777 8888'
    card.dispatchEvent(new Event('input', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 20))
    await rec.flush('interval')
    const json = JSON.stringify(u.events())
    expect(json).toContain('Checkout') // ordinary text is kept
    for (const secret of ['4242', '5555', 'hunter2', '0803', 'Jane Doe', 'Allen', '9,999']) expect(json).not.toContain(secret)
    expect(json).toContain('rr_width') // the blocked element is a sized placeholder
    stopReplay()
  })
})
