import type { Client } from '../client'

const FORM_TAGS = ['input', 'textarea', 'select', 'option']

function attr(el: Element, name: string): string | null {
  try {
    const v = el.getAttribute(name)
    return v ? v.slice(0, 60) : null
  } catch {
    return null
  }
}

/**
 * Describe a clicked element without ever reading form values.
 * Examples: `button#save "Save order"`, `a.nav-link "Pricing"`, `input[name=email]`.
 */
export function describeElement(target: EventTarget | null): string {
  let el = target as Element | null
  if (!el || typeof (el as Element).tagName !== 'string') return 'unknown'
  // Clicks on text nodes or icons inside a button: walk up to something meaningful.
  const interactive = (el as Element).closest
    ? (el as Element).closest('button, a, input, textarea, select, label, [role=button], [role=link], [onclick]')
    : null
  if (interactive) el = interactive
  const tag = el.tagName.toLowerCase()

  if (FORM_TAGS.indexOf(tag) !== -1) {
    const name = attr(el, 'name')
    const type = attr(el, 'type')
    const id = el.id ? '#' + el.id.slice(0, 60) : ''
    if (name) return `${tag}[name=${name}]`
    if (id) return tag + id
    if (type) return `${tag}[type=${type}]`
    return tag
  }

  let desc = tag
  if (el.id) desc += '#' + el.id.slice(0, 60)
  else {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\s+/).filter(Boolean).slice(0, 2) : []
    if (cls.length) desc += '.' + cls.join('.')
  }
  const aria = attr(el, 'aria-label')
  if (aria) return `${desc}[aria-label="${aria}"]`
  if ((el as HTMLElement).isContentEditable) return desc
  let text = ''
  try {
    text = (el.textContent || '').replace(/\s+/g, ' ').trim()
  } catch {
    text = ''
  }
  if (text) desc += ` "${text.slice(0, 60)}"`
  return desc.slice(0, 200)
}

export function installClicks(client: Client): () => void {
  const onClick = (event: Event) => {
    try {
      client.addBreadcrumbInternal({ type: 'click', message: describeElement(event.target) })
    } catch {
      /* ignore */
    }
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}
