import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { adjacentPane, controlsIn, focusControl, focusPane, keyboardScope, paneAt, panesIn, visible } from './KeyboardPanes'

beforeAll(() => GlobalRegistrator.register())
afterAll(async () => { await GlobalRegistrator.unregister() })
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })

// HappyDOM has no layout engine. Rectangles are controlled; containment,
// visibility, focus and listener ownership use the real DOM dependency.
function fixture(html = '<section data-keyboard-pane="First"><button id="first">First</button></section><section data-keyboard-pane="Second"><button id="second">Second</button></section>') {
  document.body.innerHTML = `<main>${html}</main>`
  const root = document.querySelector<HTMLElement>('main')!
  const place = (node: HTMLElement, x = 0, y = 0, width = 100, height = 100) => {
    node.getBoundingClientRect = () => new window.DOMRect(x, y, width, height)
  }
  place(root); root.querySelectorAll<HTMLElement>('*').forEach(node => place(node))
  cleanups.push(() => root.remove())
  const node = (id: string) => {
    const found = root.querySelector<HTMLElement>(`#${id}`)
    if (!found) throw new Error(`Missing fixture node ${id}`)
    return found
  }
  return { root, place, node }
}

test.each([
  { name: 'hidden ancestor', hide: (root: HTMLElement, _: HTMLButtonElement) => { root.hidden = true } },
  { name: 'inert ancestor', hide: (root: HTMLElement, _: HTMLButtonElement) => { root.setAttribute('inert', '') } },
  { name: 'aria-hidden ancestor', hide: (root: HTMLElement, _: HTMLButtonElement) => { root.setAttribute('aria-hidden', 'true') } },
  { name: 'disabled control', hide: (_: HTMLElement, button: HTMLButtonElement) => { button.disabled = true } },
  { name: 'aria-disabled control', hide: (_: HTMLElement, button: HTMLButtonElement) => { button.setAttribute('aria-disabled', 'true') } },
  { name: 'display none', hide: (_: HTMLElement, button: HTMLButtonElement) => { button.style.display = 'none' } },
  { name: 'visibility hidden', hide: (_: HTMLElement, button: HTMLButtonElement) => { button.style.visibility = 'hidden' } },
  { name: 'detached control', hide: (_: HTMLElement, button: HTMLButtonElement) => { button.remove() } },
])('$name cannot participate in keyboard navigation', ({ hide }) => {
  const f = fixture(), button = f.root.querySelector<HTMLButtonElement>('#first')!
  expect(visible(button)).toBe(true)
  hide(f.root, button)
  expect(visible(button)).toBe(false)
})

test.each([{ width: 0, height: 100 }, { width: 100, height: 0 }])('a control with $width by $height geometry is excluded', ({ width, height }) => {
  const f = fixture(), button = f.node('first')
  f.place(button, 0, 0, width, height)
  expect(visible(button)).toBe(false)
})

test('explicit false accessibility flags preserve an available control', () => {
  const f = fixture(), button = f.node('first')
  f.root.setAttribute('aria-hidden', 'false'); button.setAttribute('aria-disabled', 'false')
  expect(visible(button)).toBe(true)
})

test.each(['dialog', 'alertdialog', 'native'] as const)('the visible %s modal owns panes even outside the binding root', kind => {
  const f = fixture(), modal = document.createElement(kind === 'native' ? 'dialog' : 'section')
  if (kind === 'native') modal.setAttribute('open', '')
  else { modal.setAttribute('role', kind); modal.setAttribute('aria-modal', 'true') }
  modal.innerHTML = '<section data-keyboard-pane="Confirm"><button>Confirm</button></section>'
  document.body.append(modal); cleanups.push(() => modal.remove())
  f.place(modal); modal.querySelectorAll<HTMLElement>('*').forEach(node => f.place(node))
  expect(keyboardScope(f.root) === modal).toBe(true)
  expect(panesIn(f.root).map(node => node.dataset.keyboardPane)).toEqual(['Confirm'])
  expect(paneAt(f.root, f.node('first'))).toBeUndefined()
  expect(paneAt(f.root, modal.querySelector('button')) === modal.firstElementChild).toBe(true)
})

test('modal selection skips hidden and explicit nonmodal dialogs and returns to the root after dismissal', () => {
  const f = fixture(), first = document.createElement('dialog'), hidden = document.createElement('dialog'), nonmodal = document.createElement('dialog')
  for (const modal of [first, hidden, nonmodal]) {
    modal.setAttribute('open', ''); document.body.append(modal); f.place(modal); cleanups.push(() => modal.remove())
  }
  hidden.hidden = true; nonmodal.setAttribute('aria-modal', 'false')
  expect(keyboardScope(f.root) === first).toBe(true)
  first.removeAttribute('open')
  expect(keyboardScope(f.root) === f.root).toBe(true)
  expect(panesIn(f.root).map(node => node.dataset.keyboardPane)).toEqual(['First', 'Second'])
})

test('the last available modal wins and a modal without panes is its own keyboard pane', () => {
  const f = fixture(), first = document.createElement('dialog'), last = document.createElement('dialog')
  for (const modal of [first, last]) { modal.setAttribute('open', ''); document.body.append(modal); f.place(modal); cleanups.push(() => modal.remove()) }
  expect(keyboardScope(f.root) === last).toBe(true)
  expect(panesIn(f.root).length).toBe(1)
  expect(panesIn(f.root)[0] === last).toBe(true)
})

test('unmarked visible roots are their own pane; hidden roots have no pane', () => {
  const f = fixture('<button id="first">First</button>')
  expect(panesIn(f.root).length).toBe(1)
  expect(paneAt(f.root, f.node('first')) === f.root).toBe(true)
  expect(paneAt(f.root, null)).toBeUndefined()
  f.root.hidden = true
  expect(panesIn(f.root)).toEqual([])
})

test('control discovery keeps native and selected controls in DOM order and excludes nested pane ownership', () => {
  const f = fixture('<section data-keyboard-pane="Outer" id="outer"><button id="button">Action</button><button disabled id="disabled">No</button><a href="/" id="link">Link</a><a id="plain">Text</a><div tabindex="0" id="custom"></div><div tabindex="-1" id="scroller"></div><button role="option" tabindex="-1" id="option">Option</button><input readonly id="readonly"><textarea id="textarea"></textarea><select id="select"><option>One</option></select><div contenteditable="true" tabindex="0" id="editable"></div><div contenteditable="false" id="fixed"></div><section data-keyboard-pane="Nested"><button id="nested">Nested</button></section></section>')
  expect(controlsIn(f.node('outer')).map(node => node.id)).toEqual(['button', 'link', 'custom', 'option', 'readonly', 'textarea', 'select', 'editable'])
  expect(paneAt(f.root, f.node('nested'))?.dataset.keyboardPane).toBe('Nested')
})

test('skip-fields regions retain buttons while leaving editable fields outside navigation', () => {
  const f = fixture('<section data-keyboard-pane="Pane" id="pane"><div data-keyboard-skip-fields><button id="button">Action</button><input id="input"><textarea id="textarea"></textarea><select id="select"></select><div contenteditable="true" tabindex="0" id="editable"></div></div><input id="outside"></section>')
  expect(controlsIn(f.node('pane')).map(node => node.id)).toEqual(['button', 'outside'])
})

test.each([
  { key: 'h', expected: 'left' }, { key: 'ArrowLeft', expected: 'left' },
  { key: 'l', expected: 'right' }, { key: 'ArrowRight', expected: 'right' },
  { key: 'k', expected: 'up' }, { key: 'ArrowUp', expected: 'up' },
  { key: 'j', expected: 'down' }, { key: 'ArrowDown', expected: 'down' },
])('$key chooses the pane in the requested direction', ({ key, expected }) => {
  const f = fixture('<section id="center"></section><section id="left"></section><section id="right"></section><section id="up"></section><section id="down"></section>')
  const center = f.node('center'), panes = ['center', 'left', 'right', 'up', 'down'].map(f.node)
  f.place(center, 200, 200); f.place(f.node('left'), 0, 200); f.place(f.node('right'), 400, 200); f.place(f.node('up'), 200, 0); f.place(f.node('down'), 200, 400)
  expect(adjacentPane(panes, center, key)?.id).toBe(expected)
})

test.each([{ key: 'l', vertical: false }, { key: 'j', vertical: true }])('$key prefers an aligned pane over a nearby diagonal pane', ({ key, vertical }) => {
  const f = fixture('<section id="center"></section><section id="aligned"></section><section id="diagonal"></section>')
  f.place(f.node('aligned'), vertical ? 0 : 500, vertical ? 500 : 0)
  f.place(f.node('diagonal'), 110, 110)
  expect(adjacentPane(['center', 'diagonal', 'aligned'].map(f.node), f.node('center'), key)?.id).toBe('aligned')
})

test('geometry has no wrap at an edge, starts at the first pane without current focus, and preserves DOM order for ties', () => {
  const f = fixture('<section id="center"></section><section id="first"></section><section id="second"></section>')
  const center = f.node('center'), first = f.node('first'), second = f.node('second')
  f.place(first, 200, 0); f.place(second, 200, 0)
  expect(adjacentPane([center, first, second], center, 'h')).toBeUndefined()
  expect(adjacentPane([], undefined, 'l')).toBeUndefined()
  expect(adjacentPane([first, second], undefined, 'l') === first).toBe(true)
  expect(adjacentPane([center, first, second], center, 'l') === first).toBe(true)
  expect(adjacentPane([center, second, first], center, 'l') === second).toBe(true)
})

test.each(['remembered', 'removed', 'hidden', 'scroller'] as const)('pane focus restores %s only when it is still an available control', state => {
  const f = fixture('<section data-keyboard-pane="Pane" id="pane"><button id="remembered">Action</button><div tabindex="-1" id="scroller"></div><input id="preferred"></section>')
  const remembered = state === 'scroller' ? f.node('scroller') : f.node('remembered'), focused: string[] = []
  if (state === 'removed') remembered.remove()
  if (state === 'hidden') remembered.hidden = true
  focusPane(f.node('pane'), remembered, target => focused.push(target.id))
  expect(focused).toEqual([state === 'remembered' ? 'remembered' : 'preferred'])
})

test.each([
  { html: '<button id="first">First</button><button aria-selected="true" id="selected">Selected</button>', expected: 'selected' },
  { html: '<button id="first">First</button><button id="second">Second</button>', expected: 'first' },
  { html: '<button disabled id="disabled">Disabled</button>', expected: 'pane' },
])('default pane focus selects $expected without inventing a navigation stop', ({ html, expected }) => {
  const f = fixture(`<section data-keyboard-pane="Pane" id="pane">${html}</section>`), focused: string[] = []
  focusPane(f.node('pane'), undefined, target => focused.push(target.id))
  expect(focused).toEqual([expected])
})

test('focusing an empty pane owns a one-shot tabindex cleanup and scrolls to the nearest visible position', () => {
  const f = fixture('<section data-keyboard-pane="Pane" id="pane"></section><button id="next">Next</button>'), pane = f.node('pane')
  const focused = spyOn(pane, 'focus'), scrolled = spyOn(pane, 'scrollIntoView'), added = spyOn(pane, 'addEventListener')
  cleanups.push(() => { focused.mockRestore(); scrolled.mockRestore(); added.mockRestore() })
  focusControl(pane)
  expect(document.activeElement === pane).toBe(true)
  expect(pane.getAttribute('tabindex')).toBe('-1')
  expect(focused.mock.calls).toEqual([[{ preventScroll: true }]])
  expect(scrolled.mock.calls).toEqual([[{ block: 'nearest', inline: 'nearest' }]])
  expect(added.mock.calls.map(([name, , options]) => [name, options])).toEqual([['blur', { once: true }]])
  f.node('next').focus()
  expect(pane.hasAttribute('tabindex')).toBe(false)
  pane.tabIndex = 7; pane.dispatchEvent(new window.Event('blur'))
  expect(pane.getAttribute('tabindex')).toBe('7')
})

test('focusing a native control preserves its existing tabindex and needs no transient blur listener', () => {
  const f = fixture('<button id="button" tabindex="2">Action</button>'), button = f.node('button'), added = spyOn(button, 'addEventListener')
  cleanups.push(() => added.mockRestore())
  focusControl(button)
  expect(document.activeElement === button).toBe(true)
  expect(button.getAttribute('tabindex')).toBe('2')
  expect(added.mock.calls).toEqual([])
})

test.each([
  { key: 'l', x: 1, y: 0, expected: undefined },
  { key: 'l', x: 1.25, y: 0, expected: 'candidate' },
  { key: 'j', x: 0, y: 1, expected: undefined },
  { key: 'j', x: 0, y: 1.25, expected: 'candidate' },
])('$key excludes effectively coincident centers but accepts a distinct center at ($x, $y)', ({ key, x, y, expected }) => {
  const f = fixture('<section id="current"></section><section id="candidate"></section>')
  f.place(f.node('candidate'), x, y)
  expect(adjacentPane(['current', 'candidate'].map(f.node), f.node('current'), key)?.id).toBe(expected)
})
