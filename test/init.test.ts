import { afterEach, describe, expect, it, vi } from 'vitest'
import { Checked, autoInit, getClient, optionsFromScript } from '../src/index'
import { installFetch, start, settle, errorEvents } from './helpers'

function setDnt(v: string | null) {
  Object.defineProperty(navigator, 'doNotTrack', { value: v, configurable: true })
}

afterEach(async () => {
  await Checked.close()
  setDnt(null)
  document.head.innerHTML = ''
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('auto init from the script tag', () => {
  it('reads data attributes and defaults the endpoint to the script origin', () => {
    installFetch()
    const s = document.createElement('script')
    s.src = 'https://cdn.example.com/sdk/checked.v1.min.js'
    s.setAttribute('data-key', 'ck_pub_abc')
    s.setAttribute('data-env', 'staging')
    s.setAttribute('data-release', '1.4.2')
    s.setAttribute('data-console-errors', 'true')
    s.setAttribute('data-sample-rate', '0.5')
    s.setAttribute('data-capture-4xx', 'true')
    document.head.appendChild(s)

    const opts = optionsFromScript(s)!
    expect(opts).toMatchObject({
      key: 'ck_pub_abc',
      environment: 'staging',
      release: '1.4.2',
      endpoint: 'https://cdn.example.com/api/v1/ingest/events',
      captureConsoleErrors: true,
      captureRequests4xx: true,
      sampleRate: 0.5,
    })

    expect(autoInit()).toBe(true)
    const c = getClient()!
    expect(c.key).toBe('ck_pub_abc')
    expect(c.ingestUrl).toBe('https://cdn.example.com/api/v1/ingest/events?key=ck_pub_abc')
  })

  it('data-endpoint overrides the default, and a bare origin gets the ingest path', () => {
    installFetch()
    const s = document.createElement('script')
    s.src = 'http://localhost:4301/sdk/checked.v1.min.js'
    s.setAttribute('data-key', 'ck_pub_local')
    s.setAttribute('data-endpoint', 'http://localhost:4300')
    document.head.appendChild(s)
    autoInit()
    expect(getClient()!.endpoint).toBe('http://localhost:4300/api/v1/ingest/events')
  })

  it('does nothing without data-key', () => {
    const s = document.createElement('script')
    s.src = 'https://cdn.example.com/sdk/checked.v1.min.js'
    document.head.appendChild(s)
    expect(autoInit()).toBe(false)
    expect(getClient()).toBeNull()
  })

  it('the IIFE entry exposes window.Checked and auto inits', async () => {
    installFetch()
    const s = document.createElement('script')
    s.src = 'https://cdn.example.com/sdk/checked.v1.min.js'
    s.setAttribute('data-key', 'ck_pub_iife')
    document.head.appendChild(s)
    delete (window as { Checked?: unknown }).Checked
    vi.resetModules()
    await import('../src/iife')
    const w = window as unknown as { Checked: typeof Checked }
    expect(typeof w.Checked.init).toBe('function')
    await w.Checked.close()
    delete (window as { Checked?: unknown }).Checked
  }, 30_000)
})

describe('safety before init and with Do Not Track', () => {
  it('calls before init are no-ops', async () => {
    expect(() => {
      Checked.captureError(new Error('x'))
      Checked.track('t')
      Checked.setTag('a', 'b')
      Checked.addBreadcrumb({ message: 'm' })
      Checked.captureMessage('hello')
    }).not.toThrow()
    await expect(Checked.flush()).resolves.toBe(true)
    await expect(Checked.identify({ id: 1 })).resolves.toBeUndefined()
  })

  it('respectDoNotTrack disables the SDK when navigator.doNotTrack is "1"', async () => {
    setDnt('1')
    const h = start({ respectDoNotTrack: true })
    expect(getClient()).toBeNull()
    Checked.captureError(new Error('nope'))
    await Checked.flush()
    expect(h.batches.length).toBe(0)
    // fetch is not wrapped
    expect(window.fetch).toBe(h.fetchMock)
  })

  it('Do Not Track is ignored unless respectDoNotTrack is set', async () => {
    setDnt('1')
    const h = start()
    Checked.captureError(new Error('yes'))
    await Checked.flush()
    await settle()
    expect(errorEvents(h).length).toBe(1)
  })

  it('close restores fetch', async () => {
    const h = start()
    expect(window.fetch).not.toBe(h.fetchMock)
    await Checked.close()
    expect(window.fetch).toBe(h.fetchMock)
  })
})
