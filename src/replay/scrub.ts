/**
 * Last privacy pass over rrweb events before they are buffered: page addresses lose their
 * query string and fragment (unless captureQueryStrings is on), and so do links, form targets
 * and iframe addresses inside the recorded DOM. Image and stylesheet addresses are left alone
 * so the replay still renders.
 */
import { stripQuery } from '../utils'

// rrweb's numeric enums, inlined so this file does not pull rrweb in.
const META = 4
const FULL = 2
const INCREMENTAL = 3
const MUTATION = 0
const ELEMENT_NODE = 2

type SNode = { type: number; id?: number; tagName?: string; attributes?: Record<string, unknown>; childNodes?: SNode[] }
type RREvent = { type: number; data: any; timestamp: number }

const URL_ATTRS: Record<string, string[]> = { a: ['href'], area: ['href'], form: ['action'], iframe: ['src'] }

export class Scrubber {
  /** Node ids of links and forms, so later attribute changes on them are stripped too. */
  private urlNodes = new Set<number>()

  constructor(private keepQueries: boolean) {}

  private walk(n: SNode | undefined, depth = 0): void {
    if (!n || depth > 500) return
    if (n.type === ELEMENT_NODE && n.tagName && n.attributes) {
      const attrs = URL_ATTRS[n.tagName.toLowerCase()]
      if (attrs) {
        if (typeof n.id === 'number') this.urlNodes.add(n.id)
        for (const a of attrs) {
          const v = n.attributes[a]
          if (typeof v === 'string') n.attributes[a] = stripQuery(v)
        }
      }
    }
    if (n.childNodes) for (const c of n.childNodes) this.walk(c, depth + 1)
  }

  scrub<T extends RREvent>(e: T): T {
    if (this.keepQueries || !e || !e.data) return e
    try {
      if (e.type === META && typeof e.data.href === 'string') e.data.href = stripQuery(e.data.href)
      else if (e.type === FULL) {
        this.urlNodes.clear()
        this.walk(e.data.node)
      } else if (e.type === INCREMENTAL && e.data.source === MUTATION) {
        const adds = e.data.adds as Array<{ node: SNode }> | undefined
        if (adds) for (const a of adds) this.walk(a.node)
        const attrs = e.data.attributes as Array<{ id: number; attributes: Record<string, unknown> }> | undefined
        if (attrs)
          for (const m of attrs) {
            if (!this.urlNodes.has(m.id) || !m.attributes) continue
            for (const k of ['href', 'action', 'src']) {
              const v = m.attributes[k]
              if (typeof v === 'string') m.attributes[k] = stripQuery(v)
            }
          }
      }
    } catch {
      /* never break recording over a scrub */
    }
    return e
  }
}
