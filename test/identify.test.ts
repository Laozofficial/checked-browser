import { createHash, webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Checked } from '../src/index'
import { start, errorEvents } from './helpers'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

afterEach(async () => {
  await Checked.close()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('identify', () => {
  it('hashes the email with crypto.subtle and never sends it raw', async () => {
    if (!globalThis.crypto || !globalThis.crypto.subtle) vi.stubGlobal('crypto', webcrypto)
    const h = start()
    await Checked.identify({ id: 42, email: '  Ada@Example.com ' })
    Checked.captureError(new Error('x'))
    await Checked.flush()
    const u = errorEvents(h)[0].user
    expect(u.id).toBe('42')
    expect(u.emailHash).toBe(sha('ada@example.com'))
    expect(u.email).toBeUndefined()
    expect(JSON.stringify(h.batches)).not.toContain('Example.com')
  })

  it('drops the email when crypto.subtle is unavailable', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => webcrypto.getRandomValues(a) })
    const h = start()
    await Checked.identify({ id: 'u_1', email: 'ada@example.com' })
    Checked.captureError(new Error('x'))
    await Checked.flush()
    const u = errorEvents(h)[0].user
    expect(u.id).toBe('u_1')
    expect(u.emailHash).toBeUndefined()
    expect(u.email).toBeUndefined()
  })

  it('sends the raw email only with sendEmail', async () => {
    if (!globalThis.crypto || !globalThis.crypto.subtle) vi.stubGlobal('crypto', webcrypto)
    const h = start({ sendEmail: true, user: { id: 7 } })
    await Checked.identify({ id: 7, email: 'ada@example.com' })
    Checked.track('x')
    await Checked.flush()
    expect(h.events()[0].user).toMatchObject({ id: '7', email: 'ada@example.com', emailHash: sha('ada@example.com') })
  })

  it('keeps a stable anonymous id in localStorage and a session id in sessionStorage', async () => {
    const h = start()
    Checked.track('a')
    await Checked.flush()
    const first = h.events()[0]
    expect(localStorage.getItem('checked.aid')).toBe(first.user.anonymousId)
    expect(JSON.parse(sessionStorage.getItem('checked.sid')!).id).toBe(first.sessionId)
    await Checked.close()
    const h2 = start()
    Checked.track('b')
    await Checked.flush()
    expect(h2.events()[0].user.anonymousId).toBe(first.user.anonymousId)
    expect(h2.events()[0].sessionId).toBe(first.sessionId)
  })

  it('rolls the session after 30 minutes of inactivity', async () => {
    vi.useFakeTimers({ now: 5_000_000 })
    try {
      const h = start()
      Checked.track('a')
      vi.setSystemTime(5_000_000 + 31 * 60 * 1000)
      Checked.track('b')
      await Checked.flush()
      const [a, b] = h.events()
      expect(a.sessionId).not.toBe(b.sessionId)
    } finally {
      vi.useRealTimers()
    }
  })
})
