import { vi } from 'vitest'
import { Checked } from '../src/index'
import type { Batch, CheckedEvent, CheckedOptions } from '../src/types'

export const ENDPOINT = 'https://ingest.test/api/v1/ingest/events'

export interface FakeResponse {
  status: number
  type?: string
  headers?: { get(name: string): string | null }
}

export type AppHandler = (url: string, init?: RequestInit) => FakeResponse | Promise<FakeResponse>

export interface Harness {
  batches: Batch[]
  ingestUrls: string[]
  fetchMock: ReturnType<typeof vi.fn>
  /** Status codes the ingest endpoint returns in order; the last one repeats. */
  ingestStatuses: number[]
  setApp(handler: AppHandler): void
  events(): CheckedEvent[]
}

export function installFetch(): Harness {
  let app: AppHandler = () => ({ status: 200 })
  const h: Harness = {
    batches: [],
    ingestUrls: [],
    ingestStatuses: [202],
    fetchMock: vi.fn(),
    setApp(handler) {
      app = handler
    },
    events() {
      return ([] as CheckedEvent[]).concat(...h.batches.map((b) => b.events))
    },
  }
  h.fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string }).url ?? input)
    if (url.indexOf('/api/v1/ingest/events') !== -1) {
      h.ingestUrls.push(url)
      h.batches.push(JSON.parse(String(init?.body)))
      const status = h.ingestStatuses.length > 1 ? h.ingestStatuses.shift()! : h.ingestStatuses[0]
      return { status, headers: { get: () => null } }
    }
    return app(url, init)
  })
  ;(window as unknown as { fetch: unknown }).fetch = h.fetchMock
  ;(globalThis as unknown as { fetch: unknown }).fetch = h.fetchMock
  return h
}

export function start(opts: Partial<CheckedOptions> = {}): Harness {
  const h = installFetch()
  Checked.init({ key: 'ck_pub_test', endpoint: ENDPOINT, environment: 'test', ...opts })
  return h
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  await new Promise((r) => setTimeout(r, 0))
}

export function errorEvents(h: Harness) {
  return h.events().filter((e) => e.type === 'error') as Array<Extract<CheckedEvent, { type: 'error' }>>
}

export function requestEvents(h: Harness) {
  return h.events().filter((e) => e.type === 'request') as Array<Extract<CheckedEvent, { type: 'request' }>>
}
