import { afterEach, describe, expect, it, vi } from 'vitest'
import { Checked, getClient } from '../src/index'
import { describeElement } from '../src/integrations/clicks'
import { start, errorEvents } from './helpers'

afterEach(async () => {
  await Checked.close()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
  history.replaceState(null, '', '/')
})

describe('click breadcrumbs', () => {
  it('describes inputs by name and never includes their value', () => {
    start()
    document.body.innerHTML = `
      <input name="email" value="me@example.com">
      <input type="password" value="hunter2">
      <textarea id="notes">secret notes</textarea>
      <button id="save" class="btn primary">Save <b>order</b></button>
      <a class="nav-link big extra" href="#p">Pricing</a>
      <span aria-label="Close dialog">x</span>`
    const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const inputs = document.querySelectorAll('input')
    ;(inputs[0] as HTMLInputElement).value = 'typed@example.com'
    click(inputs[0])
    click(inputs[1])
    click(document.querySelector('textarea')!)
    click(document.querySelector('b')!)
    click(document.querySelector('a')!)
    click(document.querySelector('span')!)
    const msgs = getClient()!
      .getBreadcrumbs()
      .filter((b) => b.type === 'click')
      .map((b) => b.message)
    expect(msgs).toEqual([
      'input[name=email]',
      'input[type=password]',
      'textarea#notes',
      'button#save "Save order"',
      'a.nav-link.big "Pricing"',
      'span[aria-label="Close dialog"]',
    ])
    const all = JSON.stringify(getClient()!.getBreadcrumbs())
    expect(all).not.toContain('example.com')
    expect(all).not.toContain('hunter2')
    expect(all).not.toContain('secret notes')
  })

  it('truncates element text to 60 chars', () => {
    const div = document.createElement('div')
    div.textContent = 'y'.repeat(200)
    expect(describeElement(div)).toBe('div "' + 'y'.repeat(60) + '"')
  })
})

describe('navigation and custom breadcrumbs', () => {
  it('records pushState, replaceState and popstate as navigation breadcrumbs without queries', async () => {
    const h = start()
    history.pushState({}, '', '/orders?secret=1')
    history.replaceState({}, '', '/orders/7#frag')
    window.dispatchEvent(new PopStateEvent('popstate'))
    Checked.addBreadcrumb({ message: 'opened cart', data: { items: 3, nested: { a: 1 } } })
    Checked.captureError(new Error('after nav'))
    await Checked.flush()
    const e = errorEvents(h)[0]
    expect(e.url).toBe('http://localhost:3000/orders/7')
    const nav = e.breadcrumbs.filter((b) => b.type === 'navigation').map((b) => b.message)
    expect(nav).toEqual([
      'http://localhost:3000/ -> http://localhost:3000/orders',
      'http://localhost:3000/orders -> http://localhost:3000/orders/7',
    ])
    const custom = e.breadcrumbs.find((b) => b.type === 'custom')!
    expect(custom).toMatchObject({ message: 'opened cart', data: { items: 3 } })
  })

  it('keeps a ring buffer of maxBreadcrumbs', () => {
    start({ maxBreadcrumbs: 3 })
    for (let i = 0; i < 10; i++) Checked.addBreadcrumb({ message: 'b' + i })
    expect(getClient()!.getBreadcrumbs().map((b) => b.message)).toEqual(['b7', 'b8', 'b9'])
  })

  it('strips query strings from URLs inside breadcrumb messages', () => {
    start()
    Checked.addBreadcrumb({ message: 'loaded https://x.test/a?token=abc and more' })
    expect(getClient()!.getBreadcrumbs()[0].message).toBe('loaded https://x.test/a and more')
  })
})
