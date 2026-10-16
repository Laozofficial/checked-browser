import { afterEach, describe, expect, it, vi } from 'vitest'
import { Checked, getClient } from '../src/index'
import { ENDPOINT, start, requestEvents } from './helpers'

afterEach(async () => {
  await Checked.close()
  vi.restoreAllMocks()
  history.replaceState(null, '', '/')
})

describe('fetch wrapper', () => {
  it('a 503 becomes a request event with the query string stripped', async () => {
    const h = start()
    h.setApp(() => ({ status: 503 }))
    const res = await fetch('https://api.example.com/orders/123?token=secret#frag', { method: 'post' })
    expect(res.status).toBe(503)
    await Checked.flush()
    const [r] = requestEvents(h)
    expect(r.request.method).toBe('POST')
    expect(r.request.url).toBe('https://api.example.com/orders/123')
    expect(r.request.status).toBe(503)
    expect(typeof r.request.durationMs).toBe('number')
    expect(r).not.toHaveProperty('body')
    expect(JSON.stringify(r)).not.toContain('secret')
  })

  it('a 200 sends no event but leaves a breadcrumb', async () => {
    const h = start()
    await fetch('/api/me?x=1')
    await Checked.flush()
    expect(requestEvents(h).length).toBe(0)
    const crumbs = getClient()!.getBreadcrumbs()
    const last = crumbs[crumbs.length - 1]
    expect(last.type).toBe('request')
    expect(last.message).toBe('GET http://localhost:3000/api/me 200')
    expect(last.data).toMatchObject({ method: 'GET', url: 'http://localhost:3000/api/me', status: 200 })
  })

  it('a network error is a status 0 event and the original rejection still propagates', async () => {
    const h = start()
    const boom = new TypeError('Failed to fetch')
    h.setApp(() => Promise.reject(boom))
    await expect(fetch('https://api.example.com/down')).rejects.toBe(boom)
    await Checked.flush()
    const [r] = requestEvents(h)
    expect(r.request).toMatchObject({ status: 0, errorMessage: 'Failed to fetch', url: 'https://api.example.com/down' })
  })

  it('4xx is only sent with captureRequests4xx', async () => {
    let h = start()
    h.setApp(() => ({ status: 404 }))
    await fetch('/missing')
    await Checked.flush()
    expect(requestEvents(h).length).toBe(0)
    await Checked.close()

    h = start({ captureRequests4xx: true })
    h.setApp(() => ({ status: 404 }))
    await fetch('/missing')
    await Checked.flush()
    expect(requestEvents(h)[0].request.status).toBe(404)
  })

  it('never captures its own ingest calls, even when made through window.fetch', async () => {
    const h = start()
    h.ingestStatuses = [503]
    await fetch(ENDPOINT + '?key=ck_pub_test', { method: 'POST', body: JSON.stringify({ events: [] }) })
    Checked.track('one')
    h.ingestStatuses = [202]
    await Checked.flush()
    expect(requestEvents(h).length).toBe(0)
    expect(getClient()!.getBreadcrumbs().filter((b) => b.type === 'request').length).toBe(0)
  })

  it('captureQueryStrings keeps the query string', async () => {
    const h = start({ captureQueryStrings: true })
    h.setApp(() => ({ status: 500 }))
    history.replaceState(null, '', '/page?tab=2')
    await fetch('https://api.example.com/x?page=2')
    await Checked.flush()
    const [r] = requestEvents(h)
    expect(r.request.url).toBe('https://api.example.com/x?page=2')
    expect(r.url).toBe('http://localhost:3000/page?tab=2')
  })

  it('the page url drops the query string by default', async () => {
    const h = start()
    history.replaceState(null, '', '/orders/123?email=a@b.c#top')
    Checked.captureError(new Error('x'))
    await Checked.flush()
    expect(h.events()[0].url).toBe('http://localhost:3000/orders/123')
  })
})

describe('XMLHttpRequest wrapper', () => {
  it('records a failed XHR via loadend and keeps the original send', async () => {
    // Replace the real send (which would hit the network) before the SDK wraps it.
    const realSend = XMLHttpRequest.prototype.send
    const fakeSend = vi.fn(function (this: XMLHttpRequest) {
      setTimeout(() => {
        this.dispatchEvent(new Event('error'))
        this.dispatchEvent(new Event('loadend'))
      }, 0)
    })
    XMLHttpRequest.prototype.send = fakeSend as unknown as typeof realSend
    try {
      const h = start()
      const xhr = new XMLHttpRequest()
      xhr.open('GET', 'https://api.example.com/xhr?q=1')
      xhr.send()
      expect(fakeSend).toHaveBeenCalledTimes(1)
      await new Promise((r) => setTimeout(r, 5))
      await Checked.flush()
      const [r] = requestEvents(h)
      expect(r.request).toMatchObject({ method: 'GET', url: 'https://api.example.com/xhr', status: 0, errorMessage: 'Network error' })
      await Checked.close()
      expect(XMLHttpRequest.prototype.send).toBe(fakeSend)
    } finally {
      XMLHttpRequest.prototype.send = realSend
    }
  })
})
