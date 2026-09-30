import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { bindPressActions, createPressActions } from './PressActions'

beforeAll(() => GlobalRegistrator.register())
afterAll(async () => { await GlobalRegistrator.unregister() })

const cleanup: Array<() => void> = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })
const setup = ({ enabled, observeListeners = false }: { enabled?: () => boolean; observeListeners?: boolean } = {}) => {
  const win = window
  win.document.body.innerHTML = '<main><button aria-keyshortcuts="t">Tutorial</button><button aria-keyshortcuts="h">Help</button><input /></main>'
  const root = win.document.querySelector<HTMLElement>('main')!
  const buttons = [...root.querySelectorAll('button')]
  const calls: string[] = []
  for (const button of buttons) button.addEventListener('click', () => calls.push(button.textContent!))
  cleanup.push(() => root.remove())
  const listeners = observeListeners ? {
    documentAdded: spyOn(win.document, 'addEventListener'), documentRemoved: spyOn(win.document, 'removeEventListener'),
    windowAdded: spyOn(win, 'addEventListener'), windowRemoved: spyOn(win, 'removeEventListener'),
  } : undefined
  if (listeners) cleanup.push(() => Object.values(listeners).forEach(listener => listener.mockRestore()))
  const stop = bindPressActions({ root, enabled, resolveShortcut: event => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    const button = buttons.find(button => button.getAttribute('aria-keyshortcuts') === event.key)
    return button ? { element: button, activate: () => button.click() } : undefined
  } })
  cleanup.push(stop)
  const key = (type: 'keydown' | 'keyup', key: string, init: KeyboardEventInit = {}, target: EventTarget | null = win.document) => {
    if (!target) throw new Error('Missing key target')
    const event = new win.KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }
  const pointer = (type: 'pointerdown' | 'pointerup' | 'pointercancel', target: EventTarget | undefined, id = 1, init: PointerEventInit = {}) => {
    if (!target) throw new Error('Missing pointer target')
    const event = new win.PointerEvent(type, { button: 0, pointerId: id, bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }
  return { win, root, buttons, calls, stop, key, pointer, listeners }
}

test('only the final release wins, independent of press order; repeat downs cannot replace it', () => {
  const held = createPressActions(), calls: string[] = []
  held.down('t', { activate: () => calls.push('t') })
  held.down('h', { activate: () => calls.push('h') })
  held.down('h', { activate: () => calls.push('repeat') })
  held.up('h')
  expect(calls).toEqual([])
  held.up('t')
  held.up('t')
  expect(calls).toEqual(['t'])
})

test('held keys highlight their own controls and intermediate release cannot activate', () => {
  const { key, buttons, calls } = setup()
  key('keydown', 't'); key('keydown', 'h'); key('keydown', 'h', { repeat: true })
  expect(buttons.map(b => b.hasAttribute('data-pressed'))).toEqual([true, true])
  expect(calls).toEqual([])
  key('keyup', 't')
  expect(buttons.map(b => b.hasAttribute('data-pressed'))).toEqual([false, true])
  expect(calls).toEqual([])
  key('keyup', 'h')
  expect(calls).toEqual(['Help'])
  expect(buttons.every(b => !b.hasAttribute('data-pressed'))).toBe(true)
})

test('pointer and key holds share arbitration; synthesized mouse click cannot activate twice', () => {
  const { win, key, pointer, buttons, calls } = setup()
  pointer('pointerdown', buttons[0]); key('keydown', 'h')
  pointer('pointerup', buttons[0])
  buttons[0]!.dispatchEvent(new win.MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }))
  expect(calls).toEqual([])
  key('keyup', 'h')
  expect(calls).toEqual(['Help'])
  pointer('pointerdown', buttons[0]); pointer('pointerup', buttons[0])
  buttons[0]!.dispatchEvent(new win.MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }))
  expect(calls).toEqual(['Help', 'Tutorial'])
})

test('release outside the original button cancels even over another held control', () => {
  const { key, pointer, buttons, calls } = setup()
  pointer('pointerdown', buttons[0]); key('keydown', 'h')
  key('keyup', 'h'); pointer('pointerup', buttons[1])
  expect(calls).toEqual([])
  expect(buttons.every(b => !b.hasAttribute('data-pressed'))).toBe(true)
})

for (const reason of ['blur', 'pointercancel', 'unmount', 'Tab', 'Escape', 'compositionstart', 'focus']) test(`${reason} cancels all held inputs`, () => {
  const { win, key, pointer, buttons, calls, stop } = setup()
  key('keydown', 't'); pointer('pointerdown', buttons[1])
  if (reason === 'blur') win.dispatchEvent(new win.Event('blur'))
  else if (reason === 'pointercancel') pointer('pointercancel', buttons[1])
  else if (reason === 'Tab' || reason === 'Escape') key('keydown', reason)
  else if (reason === 'compositionstart') win.document.dispatchEvent(new win.Event('compositionstart'))
  else if (reason === 'focus') win.document.querySelector('input')!.focus()
  else stop()
  key('keyup', 't'); pointer('pointerup', buttons[1])
  expect(calls).toEqual([])
  expect(buttons.every(b => !b.hasAttribute('data-pressed'))).toBe(true)
})

test('native Enter and Space wait for release; text editing and modified shortcuts stay native', () => {
  const { root, buttons, key, calls } = setup()
  for (const value of ['Enter', ' ']) {
    key('keydown', value, {}, buttons[0])
    expect(buttons[0]!.hasAttribute('data-pressed')).toBe(true)
    key('keyup', value, {}, buttons[0])
  }
  expect(calls).toEqual(['Tutorial', 'Tutorial'])
  key('keydown', 't', {}, root.querySelector('input')); key('keyup', 't')
  key('keydown', 't', { ctrlKey: true }); key('keyup', 't')
  key('keydown', 't', { repeat: true }); key('keyup', 't')
  expect(calls).toEqual(['Tutorial', 'Tutorial'])
})

test('Escape reaches the inner menu before the enclosing close shortcut', () => {
  const { root, key } = setup()
  const input = root.querySelector('input')!
  const calls: string[] = []
  const stop = bindPressActions({ root, resolveShortcut: event => event.key === 'Escape'
    ? { activate: () => calls.push('composer') } : undefined })
  cleanup.push(stop)
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape' && calls.length === 0) { event.preventDefault(); calls.push('menu') }
  })
  key('keydown', 't')
  key('keydown', 'Escape', {}, input); key('keyup', 'Escape', {}, input)
  expect(calls).toEqual(['menu'])
  expect(root.querySelector('[data-pressed]')).toBeNull()
  key('keydown', 'Escape', {}, input); key('keyup', 'Escape', {}, input)
  expect(calls).toEqual(['menu', 'composer'])
})

test('an open composer owns plain keys even if focus is still on the opener', () => {
  const { root, buttons, key, calls } = setup()
  const composer = document.createElement('div')
  composer.className = 'composer-wrap'
  composer.innerHTML = '<textarea data-testid="composer-input"></textarea>'
  root.append(composer)
  buttons[0]!.focus()
  key('keydown', 'h', {}, buttons[0]); key('keyup', 'h', {}, buttons[0])
  expect(calls).toEqual([])
  // Native button activation still belongs to the focused control.
  key('keydown', 'Enter', {}, buttons[1]); key('keyup', 'Enter', {}, buttons[1])
  expect(calls).toEqual(['Help'])
  composer.hidden = true
  key('keydown', 't', {}, buttons[0]); key('keyup', 't', {}, buttons[0])
  expect(calls).toEqual(['Help', 'Tutorial'])
})


test('two inputs on the same button keep it highlighted until both are released', () => {
  const { key, pointer, buttons, calls } = setup()
  key('keydown', 't'); pointer('pointerdown', buttons[0])
  key('keyup', 't')
  expect(buttons[0]!.hasAttribute('data-pressed')).toBe(true)
  expect(calls).toEqual([])
  pointer('pointerup', buttons[0])
  expect(buttons[0]!.hasAttribute('data-pressed')).toBe(false)
  expect(calls).toEqual(['Tutorial'])
})

test('a landing link used as the binding root supports shortcut, Enter, and pointer release', () => {
  const link = document.createElement('a')
  link.href = '/app'
  document.body.append(link)
  let calls = 0
  link.addEventListener('click', event => { event.preventDefault(); calls++ })
  const stop = bindPressActions({ root: link, resolveShortcut: event => event.key === 's' ? { element: link, activate: () => link.click() } : undefined })
  cleanup.push(() => { stop(); link.remove() })
  for (const key of ['s', 'Enter']) {
    link.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    expect(link.hasAttribute('data-pressed')).toBe(true)
    link.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
    expect(link.hasAttribute('data-pressed')).toBe(false)
  }
  expect(calls).toBe(2)
  link.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, bubbles: true }))
  expect(calls).toBe(2)
  link.dispatchEvent(new PointerEvent('pointerup', { button: 0, pointerId: 1, bubbles: true }))
  link.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }))
  expect(calls).toBe(3)
})

const releaseOrders = [
  ['first', 'second', 'third'], ['first', 'third', 'second'], ['second', 'first', 'third'],
  ['second', 'third', 'first'], ['third', 'first', 'second'], ['third', 'second', 'first'],
]
test.each(releaseOrders.map(order => ({ order })))('three held actions activate only the final release in order $order', ({ order }) => {
  const held = createPressActions(), calls: string[] = []
  for (const id of ['first', 'second', 'third']) held.down(id, { activate: () => calls.push(id) })
  expect(held.up('unmatched')).toBe(false)
  expect(held.up(order[0]!)).toBe(true)
  expect(held.up(order[1]!)).toBe(true)
  expect(calls).toEqual([])
  expect(held.up(order[2]!)).toBe(true)
  expect(calls).toEqual([order[2]!])
  expect(held.up(order[2]!)).toBe(false)
})

test('an invalid final release does not revive an earlier action; cancellation permits a fresh gesture', () => {
  const held = createPressActions(), calls: string[] = []
  held.down('first', { activate: () => calls.push('first') })
  held.down('second', { activate: () => calls.push('second') })
  expect(held.up('first')).toBe(true)
  expect(held.up('second', false)).toBe(true)
  expect(calls).toEqual([])
  held.down('cancelled', { activate: () => calls.push('cancelled') })
  held.cancel(); held.cancel()
  expect(held.up('cancelled')).toBe(false)
  held.down('fresh', { activate: () => calls.push('fresh') })
  expect(held.up('fresh')).toBe(true)
  expect(calls).toEqual(['fresh'])
})

test('an activation error leaves no held action or painted control and does not poison the next gesture', () => {
  const held = createPressActions(), button = document.createElement('button'), failure = new Error('activation failed')
  held.down('bad', { element: button, activate: () => { throw failure } })
  expect(button.hasAttribute('data-pressed')).toBe(true)
  expect(() => held.up('bad')).toThrow(failure)
  expect(button.hasAttribute('data-pressed')).toBe(false)
  expect(held.up('bad')).toBe(false)
  const calls: string[] = []
  held.down('good', { element: button, activate: () => calls.push('good') })
  held.up('good')
  expect(calls).toEqual(['good'])
  expect(button.hasAttribute('data-pressed')).toBe(false)
})

test.each(['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const)('pointer %s on down leaves native pointer handling untouched', modifier => {
  const f = setup(), button = f.buttons[0]!
  expect(f.pointer('pointerdown', button, 1, { [modifier]: true }).defaultPrevented).toBe(false)
  expect(button.hasAttribute('data-pressed')).toBe(false)
  f.pointer('pointerup', button)
  expect(f.calls).toEqual([])
})

test.each(['metaKey', 'ctrlKey', 'altKey', 'shiftKey'] as const)('pointer %s on release cancels the held action and clears its highlight', modifier => {
  const f = setup(), button = f.buttons[0]!
  f.pointer('pointerdown', button)
  expect(button.hasAttribute('data-pressed')).toBe(true)
  f.pointer('pointerup', button, 1, { [modifier]: true })
  expect(button.hasAttribute('data-pressed')).toBe(false)
  expect(f.calls).toEqual([])
})

test.each([1, 2])('pointer button %s does not arm a primary activation', button => {
  const f = setup(), target = f.buttons[0]!
  f.pointer('pointerdown', target, 1, { button }); f.pointer('pointerup', target, 1, { button })
  expect(target.hasAttribute('data-pressed')).toBe(false)
  expect(f.calls).toEqual([])
})

test('pointer identity and nested release targets retain the original control', () => {
  const f = setup(), button = f.buttons[0]!, child = document.createElement('span')
  button.append(child)
  f.pointer('pointerdown', child, 7)
  f.pointer('pointerup', child, 8)
  expect(button.hasAttribute('data-pressed')).toBe(true)
  expect(f.calls).toEqual([])
  f.pointer('pointerup', child, 7)
  expect(button.hasAttribute('data-pressed')).toBe(false)
  expect(f.calls).toEqual(['Tutorial'])
})

test.each(['keyboard', 'pointer'] as const)('disabling the binding between %s down and up refuses activation and allows later recovery', gesture => {
  let enabled = true
  const f = setup({ enabled: () => enabled }), button = f.buttons[0]!
  if (gesture === 'keyboard') f.key('keydown', 'Enter', {}, button)
  else f.pointer('pointerdown', button)
  expect(button.hasAttribute('data-pressed')).toBe(true)
  enabled = false
  if (gesture === 'keyboard') f.key('keyup', 'Enter', {}, button)
  else f.pointer('pointerup', button)
  expect(button.hasAttribute('data-pressed')).toBe(false)
  expect(f.calls).toEqual([])
  enabled = true
  f.pointer('pointerdown', button); f.pointer('pointerup', button)
  expect(f.calls).toEqual(['Tutorial'])
})

test.each(['disabled', 'hidden', 'removed'] as const)('a native keyboard control becoming %s while held cannot activate on release', state => {
  const f = setup(), button = f.buttons[0]!
  f.key('keydown', 'Enter', {}, button)
  if (state === 'disabled') button.disabled = true
  else if (state === 'hidden') button.hidden = true
  else button.remove()
  f.key('keyup', 'Enter')
  expect(button.hasAttribute('data-pressed')).toBe(false)
  expect(f.calls).toEqual([])
})

test('physical keyboard code owns release even if the reported key changes case', () => {
  const f = setup(), button = f.buttons[0]!
  f.key('keydown', 't', { code: 'KeyT' })
  expect(button.hasAttribute('data-pressed')).toBe(true)
  expect(f.key('keyup', 'T', { code: 'KeyT', shiftKey: true }).defaultPrevented).toBe(true)
  expect(f.calls).toEqual(['Tutorial'])
  expect(button.hasAttribute('data-pressed')).toBe(false)
})

test.each(['prevented', 'composing', 'repeat'] as const)('%s keydown cannot create a new held gesture', reason => {
  const f = setup(), event = new f.win.KeyboardEvent('keydown', {
    key: 't', bubbles: true, cancelable: true, isComposing: reason === 'composing', repeat: reason === 'repeat',
  })
  if (reason === 'prevented') event.preventDefault()
  f.win.document.dispatchEvent(event)
  expect(f.buttons.every(button => !button.hasAttribute('data-pressed'))).toBe(true)
  expect(f.key('keyup', 't').defaultPrevented).toBe(false)
  expect(f.calls).toEqual([])
})

test('composition on release clears the held key without activating it', () => {
  const f = setup()
  f.key('keydown', 't')
  expect(f.key('keyup', 't', { isComposing: true }).defaultPrevented).toBe(true)
  expect(f.calls).toEqual([])
  expect(f.buttons[0]!.hasAttribute('data-pressed')).toBe(false)
})

test('programmatic and modified clicks stay native while synthesized primary clicks are suppressed', () => {
  const f = setup(), button = f.buttons[0]!
  const click = (detail: number, ctrlKey = false) => {
    const event = new f.win.MouseEvent('click', { detail, ctrlKey, bubbles: true, cancelable: true })
    button.dispatchEvent(event)
    return event
  }
  expect(click(0).defaultPrevented).toBe(false)
  expect(f.calls).toEqual(['Tutorial'])
  expect(click(1).defaultPrevented).toBe(true)
  expect(f.calls).toEqual(['Tutorial'])
  expect(click(1, true).defaultPrevented).toBe(false)
  expect(f.calls).toEqual(['Tutorial', 'Tutorial'])
})

test('pagehide cancels held pointers and keys while focus on another button retains the gesture', () => {
  const f = setup()
  f.key('keydown', 't'); f.buttons[1]!.focus()
  expect(f.buttons[0]!.hasAttribute('data-pressed')).toBe(true)
  f.pointer('pointerdown', f.buttons[1])
  f.win.dispatchEvent(new f.win.Event('pagehide'))
  expect(f.buttons.every(button => !button.hasAttribute('data-pressed'))).toBe(true)
  f.key('keyup', 't'); f.pointer('pointerup', f.buttons[1])
  expect(f.calls).toEqual([])
})

test('unbinding removes every registered listener with its original callback and capture option', () => {
  const f = setup({ observeListeners: true }), listeners = f.listeners!
  f.key('keydown', 't')
  expect(listeners.documentAdded.mock.calls.map(([name, , capture]) => [name, capture])).toEqual([
    ['keydown', true], ['keydown', undefined], ['keyup', true], ['pointerdown', true], ['pointerup', true],
    ['pointercancel', true], ['click', true], ['visibilitychange', undefined], ['compositionstart', undefined], ['focusin', undefined],
  ])
  expect(listeners.windowAdded.mock.calls.map(([name, , capture]) => [name, capture])).toEqual([
    ['blur', undefined], ['pagehide', undefined],
  ])
  f.stop()
  expect(listeners.documentRemoved.mock.calls).toEqual(listeners.documentAdded.mock.calls)
  expect(listeners.windowRemoved.mock.calls).toEqual(listeners.windowAdded.mock.calls)
  expect(f.buttons.every(button => !button.hasAttribute('data-pressed'))).toBe(true)
  expect(f.key('keydown', 'h').defaultPrevented).toBe(false)
  expect(f.key('keyup', 't').defaultPrevented).toBe(false)
  f.pointer('pointerdown', f.buttons[1]); f.pointer('pointerup', f.buttons[1])
  expect(f.calls).toEqual([])
})

test.each(['hidden', 'visible'] as const)('visibilitychange to %s cancels or retains held gestures', state => {
  const f = setup(), doc = f.win.document, descriptor = Object.getOwnPropertyDescriptor(doc, 'visibilityState')
  Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => state })
  cleanup.push(() => { if (descriptor) Object.defineProperty(doc, 'visibilityState', descriptor); else Reflect.deleteProperty(doc, 'visibilityState') })
  f.key('keydown', 't'); f.pointer('pointerdown', f.buttons[1])
  expect(f.buttons.map(button => button.hasAttribute('data-pressed'))).toEqual([true, true])
  doc.dispatchEvent(new f.win.Event('visibilitychange'))
  expect(f.buttons.map(button => button.hasAttribute('data-pressed'))).toEqual(state === 'hidden' ? [false, false] : [true, true])
  f.key('keyup', 't')
  expect(f.calls).toEqual([])
  f.pointer('pointerup', f.buttons[1])
  expect(f.calls).toEqual(state === 'hidden' ? [] : ['Help'])
  expect(f.buttons.every(button => !button.hasAttribute('data-pressed'))).toBe(true)
})

test.each(['keyboard', 'pointer'] as const)('a disabled binding cannot arm a new %s gesture', gesture => {
  const f = setup({ enabled: () => false }), button = f.buttons[0]!
  if (gesture === 'keyboard') {
    expect(f.key('keydown', 'Enter', {}, button).defaultPrevented).toBe(false)
    expect(f.key('keyup', 'Enter', {}, button).defaultPrevented).toBe(false)
  } else { f.pointer('pointerdown', button); f.pointer('pointerup', button) }
  expect(button.hasAttribute('data-pressed')).toBe(false)
  expect(f.calls).toEqual([])
})

const unavailableGestures = ['hidden', 'inert', 'aria-hidden', 'disabled', 'aria-disabled'].flatMap(state => ['keyboard', 'pointer'].map(gesture => ({ state, gesture })))
test.each(unavailableGestures)('$state controls cannot arm a native $gesture gesture', ({ state, gesture }) => {
  const f = setup(), button = f.buttons[0]!
  if (state === 'disabled') button.disabled = true
  else if (state === 'aria-disabled') button.setAttribute('aria-disabled', 'true')
  else if (state === 'hidden') f.root.hidden = true
  else if (state === 'inert') f.root.setAttribute('inert', '')
  else f.root.setAttribute('aria-hidden', 'true')
  if (gesture === 'keyboard') {
    expect(f.key('keydown', 'Enter', {}, button).defaultPrevented).toBe(false)
    f.key('keyup', 'Enter', {}, button)
  } else { f.pointer('pointerdown', button); f.pointer('pointerup', button) }
  expect(button.hasAttribute('data-pressed')).toBe(false)
  expect(f.calls).toEqual([])
})
