/**
 * Compact, privacy-safe descriptions of what a person clicked or typed into, recorded next to
 * the rrweb stream as custom "checked" events. The server turns them into the "last actions"
 * summary for AI explanations and into draft journeys. Values are never included: an input
 * reports only how many characters it holds.
 */

export interface ActionTarget {
  tag: string
  type?: string
  role?: string
  /** Accessible name: aria-label, label text, button text. Left out when the element's text is masked. */
  name?: string
  placeholder?: string
  testid?: { attr: string; value: string }
  id?: string
  nameAttr?: string
  href?: string
  checked?: boolean
  /** The element's text is masked (data-checked-mask or maskAllText), so name is withheld. */
  masked?: true
  /** The element is blocked (data-checked-block); nothing else is recorded about it. */
  blocked?: true
}

const TESTID = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa']
const CLICKABLE =
  'a,button,input,select,textarea,label,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=switch],[role=tab],[role=menuitem],[role=option],[data-testid]'

const squash = (s: unknown, max = 80) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max - 3) + '...' : t
}

function implicitRole(el: Element): string {
  const explicit = el.getAttribute('role')
  if (explicit) return explicit
  const t = el.tagName.toLowerCase()
  const ty = (el.getAttribute('type') || '').toLowerCase()
  if (t === 'a' && el.hasAttribute('href')) return 'link'
  if (t === 'button' || t === 'summary') return 'button'
  if (t === 'input') {
    if (['submit', 'button', 'reset', 'image'].indexOf(ty) >= 0) return 'button'
    if (ty === 'checkbox' || ty === 'radio') return ty
    if (ty === 'search') return 'searchbox'
    if (['hidden', 'file', 'color', 'range'].indexOf(ty) >= 0) return ''
    return 'textbox'
  }
  if (t === 'textarea') return 'textbox'
  if (t === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox'
  return ''
}

function labelText(el: Element): string {
  try {
    const labels = (el as HTMLInputElement).labels
    if (labels && labels.length) return squash(labels[0].textContent)
    const wrap = el.closest('label')
    if (wrap) return squash(wrap.textContent)
  } catch {
    /* ignore */
  }
  return ''
}

function accessibleName(el: Element): string {
  const aria = el.getAttribute('aria-label')
  if (aria) return squash(aria)
  const by = el.getAttribute('aria-labelledby')
  if (by) {
    const ref = el.ownerDocument.getElementById(by.split(/\s+/)[0])
    if (ref) return squash(ref.textContent)
  }
  const t = el.tagName.toLowerCase()
  if (t === 'input' || t === 'textarea' || t === 'select') {
    const ty = (el.getAttribute('type') || '').toLowerCase()
    // Button inputs show their value as their label; that is page text, not user data.
    if (['submit', 'button', 'reset'].indexOf(ty) >= 0) return squash((el as HTMLInputElement).value)
    return labelText(el)
  }
  const text = squash((el as HTMLElement).innerText !== undefined ? (el as HTMLElement).innerText : el.textContent)
  if (text) return text
  return squash(el.getAttribute('alt') || el.getAttribute('title') || '')
}

export interface DescribeRules {
  maskSelector: string
  blockSelector: string
  maskAllText: boolean
  stripUrl: (u: string) => string
}

const matches = (el: Element, sel: string) => {
  try {
    return !!sel && !!el.closest(sel)
  } catch {
    return false
  }
}

/** The element a click "meant": the nearest button, link, field or test id. */
export function clickTarget(el: Element | null): Element | null {
  if (!el || !el.closest) return null
  try {
    return el.closest(CLICKABLE) || el
  } catch {
    return el
  }
}

export function describe(el: Element, rules: DescribeRules): ActionTarget {
  const tag = el.tagName.toLowerCase()
  if (matches(el, rules.blockSelector)) return { tag, blocked: true }
  const d: ActionTarget = { tag }
  const type = el.getAttribute('type')
  if (type) d.type = type.toLowerCase().slice(0, 20)
  const role = implicitRole(el)
  if (role) d.role = role
  for (const attr of TESTID) {
    const v = el.getAttribute(attr)
    if (v) {
      d.testid = { attr, value: squash(v, 100) }
      break
    }
  }
  if (el.id) d.id = squash(el.id, 100)
  const nameAttr = el.getAttribute('name')
  if (nameAttr) d.nameAttr = squash(nameAttr, 100)
  const masked = rules.maskAllText || matches(el, rules.maskSelector)
  if (masked) d.masked = true
  else {
    const name = accessibleName(el)
    if (name) d.name = name
    const ph = el.getAttribute('placeholder')
    if (ph) d.placeholder = squash(ph)
  }
  const href = tag === 'a' ? el.getAttribute('href') : null
  if (href && !/^(javascript|data):/i.test(href)) {
    try {
      d.href = rules.stripUrl(new URL(href, location.href).href).slice(0, 300)
    } catch {
      /* ignore */
    }
  }
  if (type === 'checkbox' || type === 'radio' || role === 'checkbox' || role === 'switch') {
    d.checked = (el as HTMLInputElement).checked === true || el.getAttribute('aria-checked') === 'true'
  }
  return d
}
