import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installFetch, settle } from './helpers'

const bundle = join(__dirname, '..', 'dist', 'checked.min.js')

afterEach(async () => {
  const w = window as unknown as { Checked?: { close(): Promise<boolean> } }
  if (w.Checked) await w.Checked.close()
  delete (window as { Checked?: unknown }).Checked
  document.head.innerHTML = ''
})

describe.skipIf(!existsSync(bundle))('built IIFE bundle', () => {
  it('auto inits from its script tag and sends an error', async () => {
    const h = installFetch()
    const s = document.createElement('script')
    // jsdom does not fetch external scripts in this environment; the tag is only read.
    s.src = 'https://cdn.example.com/sdk/checked.v1.min.js'
    s.setAttribute('data-key', 'ck_pub_bundle')
    s.setAttribute('data-env', 'production')
    s.setAttribute('data-release', '2.0.0')
    document.head.appendChild(s)
    ;(0, eval)(readFileSync(bundle, 'utf8'))
    const w = window as unknown as {
      Checked: { captureError(e: unknown): void; flush(): Promise<boolean>; version: string }
    }
    expect(w.Checked.version).toBe('1.0.0')
    expect(window.fetch).not.toBe(h.fetchMock)
    w.Checked.captureError(new Error('from bundle'))
    await w.Checked.flush()
    await settle()
    expect(h.ingestUrls[0]).toBe('https://cdn.example.com/api/v1/ingest/events?key=ck_pub_bundle')
    const ev = h.events()[0]
    expect(ev).toMatchObject({ type: 'error', environment: 'production', release: '2.0.0' })
  })
})
