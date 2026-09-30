import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { bindKeyboardInput, type KeyboardHint } from './KeyboardInput'
import { controlsIn, focusPane } from './KeyboardPanes'

beforeAll(() => GlobalRegistrator.register())
afterAll(async () => { await GlobalRegistrator.unregister() })

const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).reverse().forEach(cleanup => cleanup()) })
function fixture(observeListeners = false) {
  const win = window
  const doc = win.document
  doc.body.innerHTML = '<main><nav data-keyboard-pane="Sidebar"><button>One</button><button>Two</button></nav><section data-keyboard-pane="Conversation"><button>Read</button><input value="title"></section><section data-keyboard-pane="Chat"><textarea>hello world</textarea></section><section data-keyboard-pane="Hidden" hidden><button>Hidden</button></section></main>'
  const root = doc.querySelector<HTMLElement>('main')!
  const panes = [...root.querySelectorAll<HTMLElement>('[data-keyboard-pane]')]
  const place = (node: HTMLElement, x: number, y: number, width = 200, height = 180) => {
    node.getBoundingClientRect = () => new win.DOMRect(x, y, width, height)
  }
  panes.forEach((pane, n) => { place(pane, n === 0 ? 0 : 220, n === 2 ? 200 : 0); [...pane.children].forEach((child, index) => place(child as HTMLElement, n === 0 ? 0 : 220, n === 2 ? 200 : index * 40, 180, 30)) })
  let hint: KeyboardHint
  const hints: KeyboardHint[] = []
  const listeners = observeListeners ? {
    windowAdded: spyOn(win, 'addEventListener'), windowRemoved: spyOn(win, 'removeEventListener'),
    documentAdded: spyOn(doc, 'addEventListener'), documentRemoved: spyOn(doc, 'removeEventListener'),
  } : undefined
  if (listeners) cleanups.push(() => Object.values(listeners).forEach(listener => listener.mockRestore()))
  const stop = bindKeyboardInput(root, state => { hint = state; hints.push(state) })
  cleanups.push(() => { stop(); root.remove() })
  const down = (key: string, options: KeyboardEventInit = {}) => {
    const target = doc.activeElement ?? doc.body
    const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options })
    target.dispatchEvent(event)
    return event
  }
  const up = (key: string, options: KeyboardEventInit = {}) => {
    const event = new win.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true, ...options })
    const target = doc.activeElement ?? doc.body
    target.dispatchEvent(event)
    return event
  }
  const key = (key: string, options: KeyboardEventInit = {}) => {
    const event = down(key, options)
    up(key, options)
    return event
  }
  const prefix = (next: string) => { key('b', { ctrlKey: true }); key(next) }
  return { win, doc, root, panes, place, key, down, up, prefix, hint: () => hint!, hints, stop, listeners }
}

test('pane prefix leaves text intact, remembers focus, shows numbers, and skips hidden panes', () => {
  const f = fixture(), input = f.root.querySelector('textarea')!
  input.focus(); input.setSelectionRange(5, 5)
  f.key('b', { ctrlKey: true })
  expect(f.hint().prefix).toBe('command')
  f.key('ArrowUp')
  expect(f.doc.activeElement === f.panes[1]!.querySelector('input')).toBe(true)
  f.prefix(';')
  expect(f.doc.activeElement === input).toBe(true)
  expect(input.selectionStart).toBe(5)
  expect(input.value).toBe('hello world')
  f.prefix('q')
  expect(f.hint().panes.map(pane => pane.label)).toEqual(['Sidebar', 'Conversation', 'Chat'])
  f.key('0')
  expect(f.doc.activeElement?.textContent).toBe('One')
  f.key('j')
  expect(f.doc.activeElement?.textContent).toBe('Two')
  f.prefix('o'); f.prefix(';')
  expect(f.doc.activeElement?.textContent).toBe('Two')
})

test('Vim editing dispatches native input updates, keeps selection and never calls shell shortcuts', () => {
  const f = fixture(), input = f.root.querySelector('textarea')!
  let shells = 0, saved = ''
  const shell = () => shells++
  f.doc.addEventListener('keydown', shell)
  cleanups.push(() => f.doc.removeEventListener('keydown', shell))
  input.addEventListener('input', () => { saved = input.value })
  input.focus(); input.setSelectionRange(0, 0)
  f.key('Escape'); f.key('w'); f.key('d'); f.key('w')
  expect(saved).toBe('hello ')
  expect(f.hint().mode).toBe('normal')
  expect(f.doc.activeElement === input).toBe(true)
  expect(shells).toBe(0)
  f.key('u')
  expect(input.value).toBe('hello world')
  f.key('0'); f.key('v'); f.key('l')
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 2])
  f.key('Escape'); f.key('i')
  expect(f.key('x').defaultPrevented).toBe(false)
  expect(shells).toBe(1)
})

test('prefix cancellation, repeat, composition and cleanup do not leave stuck shortcuts', () => {
  const f = fixture(), input = f.root.querySelector('textarea')!
  input.focus()
  f.key('b', { ctrlKey: true }); f.key('b', { ctrlKey: true, repeat: true })
  expect(f.hint().prefix).toBe('command')
  f.key('Escape'); expect(f.hint().prefix).toBe('off')
  f.key('b', { ctrlKey: true }); f.key('Process', { isComposing: true })
  expect(f.hint().prefix).toBe('off')
  f.key('b', { ctrlKey: true })
  expect(f.key('b', { ctrlKey: true }).defaultPrevented).toBe(false)
  f.key('b', { ctrlKey: true }); f.win.dispatchEvent(new f.win.Event('blur'))
  expect(f.hint().prefix).toBe('off')
  f.stop()
  expect(f.key('b', { ctrlKey: true }).defaultPrevented).toBe(false)
  expect(input.hasAttribute('data-vim-mode')).toBe(false)
})

test('a modal dialog contains pane navigation and a terminal retains unprefixed keys', () => {
  const f = fixture()
  const dialog = f.doc.createElement('dialog')
  dialog.setAttribute('open', ''); dialog.innerHTML = '<section data-keyboard-pane="Confirm"><button>Cancel</button></section>'
  f.root.append(dialog)
  f.place(dialog, 20, 20)
  for (const node of dialog.querySelectorAll<HTMLElement>('*')) f.place(node, 20, 20)
  dialog.querySelector('button')!.focus()
  f.prefix('q'); expect(f.hint().panes.map(pane => pane.label)).toEqual(['Confirm'])
  f.key('0'); f.prefix('h')
  expect(f.doc.activeElement?.textContent).toBe('Cancel')
  dialog.remove()
  const input = f.root.querySelector('textarea')!
  input.parentElement!.className = 'xterm'; input.focus()
  expect(f.key('Escape').defaultPrevented).toBe(false)
  expect(f.key('h').defaultPrevented).toBe(false)
  f.prefix('o')
  expect(f.doc.activeElement?.textContent).toBe('One')
})

test('returning to a list restores an option instead of an implicitly focused scroller', () => {
  const f = fixture(), pane = f.panes[1]!
  pane.innerHTML = '<div tabindex="-1"><button role="option" tabindex="-1" aria-selected="true">First</button><button role="option" tabindex="-1">Second</button></div>'
  const wrapper = pane.firstElementChild as HTMLElement
  for (const node of pane.querySelectorAll<HTMLElement>('*')) f.place(node, 220, 0)
  focusPane(pane, wrapper)
  expect(f.doc.activeElement?.textContent).toBe('First')
})

test('the unnamed copy register works between independent text buffers', () => {
  const f = fixture(), first = f.root.querySelector('textarea')!, second = f.root.querySelector('input')!
  first.focus(); first.setSelectionRange(0, 0)
  f.key('Escape'); f.key('y'); f.key('w')
  second.focus(); second.setSelectionRange(0, 0)
  f.key('Escape'); f.key('P')
  expect(second.value).toBe('hello title')
  expect(first.value).toBe('hello world')
})

for (const tag of ['input', 'textarea']) {
  function fieldFixture() {
    const f = fixture(), pane = f.panes[1]!
    pane.innerHTML = `<button>Before</button><${tag}>${tag === 'textarea' ? 'draft' : ''}</${tag}><button>After</button>`
    const field = pane.querySelector<HTMLInputElement | HTMLTextAreaElement>(tag)!
    field.value = 'draft'
    for (const node of pane.children) f.place(node as HTMLElement, 220, 0)
    pane.querySelector('button')!.focus()
    return { ...f, pane, field }
  }

  test(`roving arrives at ${tag} in normal mode and j continues past it`, () => {
    const f = fieldFixture()
    f.key('j')
    expect(f.doc.activeElement === f.field).toBe(true)
    expect(f.field.dataset.vimMode).toBe('normal')
    expect(f.key('j').defaultPrevented).toBe(true)
    expect(f.doc.activeElement?.textContent).toBe('After')
    f.key('k')
    expect(f.field.dataset.vimMode).toBe('normal')
    f.key('h')
    expect(f.doc.activeElement?.textContent).toBe('Before')
    f.key('l'); f.key('l')
    expect(f.doc.activeElement?.textContent).toBe('After')
    expect(f.field.value).toBe('draft')
  })

  for (const insert of ['i', 'Enter']) test(`${insert} inserts in a roved ${tag}; Escape returns to normal, then leaves`, () => {
    const f = fieldFixture()
    f.key('j')
    expect(f.key(insert).defaultPrevented).toBe(true)
    expect(f.field.dataset.vimMode).toBe('insert')
    expect(f.key('j').defaultPrevented).toBe(false)
    f.field.value = 'typed draft'
    f.field.dispatchEvent(new f.win.Event('input', { bubbles: true }))
    f.key('Escape')
    expect(f.doc.activeElement === f.field).toBe(true)
    expect(f.field.dataset.vimMode).toBe('normal')
    f.key('Escape')
    expect(f.doc.activeElement === f.pane).toBe(true)
    expect(f.field.value).toBe('typed draft')
    f.key('j')
    expect(f.doc.activeElement?.textContent).toBe('Before')
    f.key('j')
    expect(f.field.dataset.vimMode).toBe('normal')
  })
}

test('pane navigation arrives at a field in normal mode even after earlier insertion', () => {
  const f = fixture(), input = f.root.querySelector('input')!
  input.focus()
  expect(f.hint().mode).toBe('insert')
  f.prefix('o'); f.prefix(';')
  expect(f.doc.activeElement === input).toBe(true)
  expect(f.hint().mode).toBe('normal')
})

test('lesson roving skips unrelated fields while retaining lesson controls and Chat', () => {
  const f = fixture(), pane = f.panes[1]!
  pane.setAttribute('data-keyboard-skip-fields', '')
  const field = pane.querySelector('input')!
  const after = f.doc.createElement('button')
  after.textContent = 'After'; pane.append(after)
  f.place(after, 220, 0)
  pane.querySelector('button')!.focus()
  f.key('j')
  expect(f.doc.activeElement?.textContent).toBe('After')
  expect(field.value).toBe('title')
  expect(controlsIn(f.panes[2]!).some(node => node.tagName === 'TEXTAREA')).toBe(true)
  pane.removeAttribute('data-keyboard-skip-fields')
  f.key('k')
  expect(f.doc.activeElement === field).toBe(true)
  expect(f.hint().mode).toBe('normal')
})

test('lesson checkbox controls can be toggled natively and roved past', () => {
  const f = fixture(), pane = f.panes[1]!
  const field = pane.querySelector('input')!
  field.type = 'checkbox'
  const after = f.doc.createElement('button')
  after.textContent = 'After'; pane.append(after)
  f.place(after, 220, 0)
  pane.querySelector('button')!.focus()
  f.key('j')
  expect(f.doc.activeElement === field).toBe(true)
  expect(f.key(' ').defaultPrevented).toBe(false)
  f.key('j')
  expect(f.doc.activeElement?.textContent).toBe('After')
})

test.each([
  { name: 'Meta+B', options: { metaKey: true } },
  { name: 'Alt+B', options: { altKey: true } },
  { name: 'Ctrl+Meta+B', options: { ctrlKey: true, metaKey: true } },
  { name: 'Ctrl+Alt+B', options: { ctrlKey: true, altKey: true } },
  { name: 'Ctrl+Shift+B', options: { ctrlKey: true, shiftKey: true } },
] satisfies Array<{ name: string; options: KeyboardEventInit }>)(
  '$name retains native/platform behavior instead of opening the pane prefix', ({ options }) => {
    const f = fixture(), field = f.root.querySelector('textarea')!
    field.focus(); field.setSelectionRange(3, 3)
    expect(f.key('b', options).defaultPrevented).toBe(false)
    expect(f.hint().prefix).toBe('off')
    expect([field.value, field.selectionStart, field.dataset.vimMode]).toEqual(['hello world', 3, 'insert'])
  },
)

test.each(['metaKey', 'altKey'] as const)('an active pane prefix yields to %s shortcuts without editing or navigation', modifier => {
  const f = fixture(), field = f.root.querySelector('textarea')!
  field.focus(); field.setSelectionRange(3, 3)
  f.key('b', { ctrlKey: true })
  expect(f.key('j', { [modifier]: true }).defaultPrevented).toBe(false)
  expect(f.hint().prefix).toBe('off')
  expect(f.doc.activeElement === field).toBe(true)
  expect([field.value, field.selectionStart]).toEqual(['hello world', 3])
})

test.each([
  { name: 'a composing event', key: 'x', options: { isComposing: true } },
  { name: 'the Process key', key: 'Process', options: {} },
  { name: 'legacy IME keycode 229', key: 'Unidentified', options: { keyCode: 229 } },
] satisfies Array<{ name: string; key: string; options: KeyboardEventInit }>)(
  '$name cancels pane commands and stays available to the editor', ({ key, options }) => {
    const f = fixture(), field = f.root.querySelector('textarea')!
    field.focus(); field.setSelectionRange(3, 3)
    f.prefix('q')
    expect(f.key(key, options).defaultPrevented).toBe(false)
    expect(f.hint().prefix).toBe('off')
    expect(f.doc.activeElement === field).toBe(true)
    expect([field.value, field.selectionStart]).toEqual(['hello world', 3])
  },
)

test.each(['pointerdown', 'compositionstart', 'focusin'])('%s cancels help without clearing or moving the draft', kind => {
  const f = fixture(), field = f.root.querySelector('textarea')!
  field.focus(); field.setSelectionRange(3, 3)
  f.prefix('?')
  expect(f.hint().prefix).toBe('help')
  field.dispatchEvent(new f.win.Event(kind, { bubbles: true }))
  expect(f.hint().prefix).toBe('off')
  expect(f.hint().panes).toEqual([])
  expect([field.value, field.selectionStart]).toEqual(['hello world', 3])
  expect(f.doc.activeElement === field).toBe(true)
})

test('only keyup for a consumed key is suppressed; blur releases a held key', () => {
  const f = fixture(), field = f.root.querySelector('textarea')!
  field.focus()
  expect(f.down('b', { ctrlKey: true, code: 'KeyB' }).defaultPrevented).toBe(true)
  expect(f.up('b', { code: 'OtherKey' }).defaultPrevented).toBe(false)
  expect(f.up('b', { code: 'KeyB' }).defaultPrevented).toBe(true)
  expect(f.up('b', { code: 'KeyB' }).defaultPrevented).toBe(false)
  f.key('Escape')
  expect(f.down('b', { ctrlKey: true, code: 'KeyB' }).defaultPrevented).toBe(true)
  f.win.dispatchEvent(new f.win.Event('blur'))
  expect(f.hint().prefix).toBe('off')
  expect(f.up('b', { code: 'KeyB' }).defaultPrevented).toBe(false)
})

test('a previously prevented key is ignored by the capture boundary', () => {
  const f = fixture(), field = f.root.querySelector('textarea')!
  field.focus()
  const event = new f.win.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
  event.preventDefault()
  const before = f.hints.length
  field.dispatchEvent(event)
  expect(f.hint().prefix).toBe('off')
  expect(f.hints).toHaveLength(before)
  expect(field.value).toBe('hello world')
})

test.each(['readOnly', 'disabled', 'native', 'terminal', 'email'] as const)('%s fields retain their native keys and have no Vim marker', name => {
  const f = fixture(), field = f.root.querySelector('input')!
  field.focus()
  if (name === 'readOnly') field.readOnly = true
  else if (name === 'disabled') field.disabled = true
  else if (name === 'native') field.setAttribute('data-vim-native', '')
  else if (name === 'terminal') field.parentElement!.classList.add('xterm')
  else field.type = 'email'
  f.win.dispatchEvent(new f.win.Event('resize'))
  expect(field.hasAttribute('data-vim-mode')).toBe(false)
  expect(f.key('Escape').defaultPrevented).toBe(false)
  expect(f.key('h').defaultPrevented).toBe(false)
  expect(field.value).toBe('title')
})

test.each(['menu', 'listbox', 'tree', 'grid'])('a native %s keeps unprefixed HJKL navigation', role => {
  const f = fixture(), pane = f.panes[1]!
  pane.innerHTML = `<div role="${role}"><button>First</button><button>Second</button></div>`
  for (const node of pane.querySelectorAll<HTMLElement>('*')) f.place(node, 220, 0)
  const first = pane.querySelector('button')!
  first.focus()
  expect(f.key('j').defaultPrevented).toBe(false)
  expect(f.doc.activeElement === first).toBe(true)
  f.prefix('o')
  expect(f.doc.activeElement === f.root.querySelector('textarea')).toBe(true)
})

test('pane numbers keep original visible DOM indexes when another pane becomes hidden', () => {
  const f = fixture(), field = f.root.querySelector('textarea')!
  field.focus()
  f.prefix('q')
  expect(f.hint().panes.map(({ label, index }) => ({ label, index }))).toEqual([
    { label: 'Sidebar', index: 0 }, { label: 'Conversation', index: 1 }, { label: 'Chat', index: 2 },
  ])
  f.panes[1]!.hidden = true
  f.win.dispatchEvent(new f.win.Event('resize'))
  expect(f.hint().panes.map(({ label, index }) => ({ label, index }))).toEqual([
    { label: 'Sidebar', index: 0 }, { label: 'Chat', index: 2 },
  ])
  f.key('2')
  expect(f.doc.activeElement === field).toBe(true)
  expect(f.hint().mode).toBe('normal')
  expect(f.hint().prefix).toBe('off')
})

test('cleanup removes Vim/pane marks and all keyboard, focus and cancellation listeners', () => {
  const f = fixture(true), field = f.root.querySelector('textarea')!
  field.focus()
  f.prefix('q')
  expect(field.dataset.vimMode).toBe('insert')
  expect(field.closest('[data-keyboard-active]') === f.panes[2]).toBe(true)
  const listeners = f.listeners!
  expect(listeners.windowAdded.mock.calls.map(([event, , capture]) => [event, capture])).toEqual([
    ['keydown', true], ['keyup', true], ['blur', undefined], ['resize', undefined],
  ])
  expect(listeners.documentAdded.mock.calls.map(([event, , capture]) => [event, capture])).toEqual([
    ['input', undefined], ['focusin', undefined], ['pointerdown', true], ['compositionstart', true],
    ['visibilitychange', undefined], ['scroll', true],
  ])
  f.stop()
  expect(listeners.windowRemoved.mock.calls).toEqual(listeners.windowAdded.mock.calls)
  expect(listeners.documentRemoved.mock.calls).toEqual(listeners.documentAdded.mock.calls)
  const before = f.hints.length
  expect(field.hasAttribute('data-vim-mode')).toBe(false)
  expect(f.root.querySelector('[data-keyboard-active]')).toBeNull()
  expect(f.down('b', { ctrlKey: true }).defaultPrevented).toBe(false)
  expect(f.up('b').defaultPrevented).toBe(false)
  for (const kind of ['focusin', 'input', 'pointerdown', 'compositionstart', 'scroll']) field.dispatchEvent(new f.win.Event(kind, { bubbles: true }))
  f.doc.dispatchEvent(new f.win.Event('visibilitychange'))
  for (const kind of ['blur', 'resize']) f.win.dispatchEvent(new f.win.Event(kind))
  expect(f.hints).toHaveLength(before)
  expect(field.value).toBe('hello world')
})

test('a Vim mutation emits one native bubbling input; motions, undo availability and insertion do not invent updates', () => {
  const f = fixture(), field = f.root.querySelector('textarea')!
  const changes: Array<{ value: string; bubbles: boolean; target: boolean }> = []
  const observed = (event: Event) => changes.push({ value: field.value, bubbles: event.bubbles, target: event.target === field })
  f.doc.addEventListener('input', observed)
  cleanups.push(() => f.doc.removeEventListener('input', observed))
  field.focus(); field.setSelectionRange(0, 0)
  f.key('Escape'); f.key('w')
  expect(changes).toEqual([])
  f.key('x')
  expect(changes).toEqual([{ value: 'hello orld', bubbles: true, target: true }])
  expect(field.selectionStart).toBe(6)
  f.key('u')
  expect(changes).toEqual([
    { value: 'hello orld', bubbles: true, target: true },
    { value: 'hello world', bubbles: true, target: true },
  ])
  f.key('i')
  expect(changes).toHaveLength(2)
  expect(f.key('x').defaultPrevented).toBe(false)
  expect(changes).toHaveLength(2)
})

test('a word change delivers the complete Unicode replacement through the field input boundary', () => {
  const f = fixture(), field = f.root.querySelector('textarea')!
  field.value = 'cafe\u0301 word'; field.setSelectionRange(0, 0); field.focus()
  const changes: string[] = []
  const observed = (event: Event) => { if (event.target === field) changes.push(field.value) }
  f.doc.addEventListener('input', observed)
  cleanups.push(() => f.doc.removeEventListener('input', observed))
  f.key('Escape'); f.key('c'); f.key('w')
  expect(field.value).toBe(' word')
  expect(changes).toEqual([' word'])
  expect([field.selectionStart, field.selectionEnd, field.dataset.vimMode]).toEqual([0, 0, 'insert'])
})

test('an external value update in normal mode clears stale undo and redo before the next edit', () => {
  const f = fixture(), field = f.root.querySelector('textarea')!
  field.focus(); field.setSelectionRange(0, 0)
  f.key('Escape'); f.key('x'); f.key('x'); f.key('u')
  expect(field.value).toBe('ello world')
  field.value = 'remote draft'; field.setSelectionRange(3, 3)
  f.key('e')
  expect([field.value, field.selectionStart, field.dataset.vimMode]).toEqual(['remote draft', 5, 'normal'])
  f.key('u'); f.key('r', { ctrlKey: true })
  expect([field.value, field.selectionStart]).toEqual(['remote draft', 5])
  f.key('x')
  expect(field.value).toBe('remot draft')
  f.key('u')
  expect([field.value, field.selectionStart]).toEqual(['remote draft', 5])
})

test('an insert-mode field update joins the current insertion snapshot and can be undone after Escape', () => {
  const f = fixture(), field = f.root.querySelector('textarea')!
  field.setSelectionRange(0, 0); field.focus()
  field.value = 'remote draft'; field.setSelectionRange(6, 6)
  expect(f.key('ArrowLeft').defaultPrevented).toBe(false)
  expect(field.dataset.vimMode).toBe('insert')
  f.key('Escape')
  expect([field.value, field.selectionStart, field.dataset.vimMode]).toEqual(['remote draft', 5, 'normal'])
  f.key('u')
  expect([field.value, field.selectionStart]).toEqual(['hello world', 0])
})

test.each([{ key: 'o', cursor: 7 }, { key: 'O', cursor: 2 }])('single-line input $key enters insertion without adding a newline', ({ key, cursor }) => {
  const f = fixture(), field = f.root.querySelector('input')!
  field.value = '  draft'; field.setSelectionRange(3, 3); field.focus()
  f.key('Escape')
  expect(f.key(key, { shiftKey: key === 'O' }).defaultPrevented).toBe(true)
  expect([field.value, field.selectionStart, field.selectionEnd, field.dataset.vimMode]).toEqual(['  draft', cursor, cursor, 'insert'])
  expect(f.key('x').defaultPrevented).toBe(false)
})

const modifierKeys = [
  { key: 'Control', options: { ctrlKey: true } }, { key: 'Meta', options: { metaKey: true } },
  { key: 'Alt', options: { altKey: true } }, { key: 'Shift', options: { shiftKey: true } },
] satisfies Array<{ key: string; options: KeyboardEventInit }>
test.each(modifierKeys.flatMap(row => [false, true].map(prefix => ({ ...row, prefix }))))(
  '$key alone preserves the draft and active prefix $prefix', ({ key, options, prefix }) => {
    const f = fixture(), field = f.root.querySelector('textarea')!
    field.focus(); field.setSelectionRange(3, 3)
    if (prefix) f.key('b', { ctrlKey: true })
    const before = f.hints.length
    expect(f.key(key, options).defaultPrevented).toBe(false)
    expect(f.hints).toHaveLength(before)
    expect(f.hint().prefix).toBe(prefix ? 'command' : 'off')
    expect([field.value, field.selectionStart, field.dataset.vimMode]).toEqual(['hello world', 3, 'insert'])
  },
)

test.each(['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const)('modified %s navigation from a button stays available to the platform', modifier => {
  const f = fixture(), button = f.root.querySelector('button')!
  button.focus()
  const before = f.hints.length
  expect(f.key('j', { [modifier]: true }).defaultPrevented).toBe(false)
  expect(f.doc.activeElement === button).toBe(true)
  expect(f.hints).toHaveLength(before)
})

test.each([
  { prefix: 'command', opener: '', key: 'z' },
  { prefix: 'numbers', opener: 'q', key: '9' },
  { prefix: 'help', opener: '?', key: 'z' },
])('an unknown $prefix command $key cancels without moving focus or editing text', ({ prefix, opener, key }) => {
  const f = fixture(), field = f.root.querySelector('textarea')!
  field.focus(); field.setSelectionRange(3, 3)
  f.key('b', { ctrlKey: true }); if (opener) f.key(opener)
  expect(f.hint().prefix).toBe(prefix)
  expect(f.key(key).defaultPrevented).toBe(true)
  expect(f.hint().prefix).toBe('off')
  expect(f.hint().panes).toEqual([])
  expect(f.doc.activeElement === field).toBe(true)
  expect([field.value, field.selectionStart]).toEqual(['hello world', 3])
})

test('repeated prefix and overlay keys keep the first command state until their real release', () => {
  const f = fixture(), field = f.root.querySelector('textarea')!
  field.focus()
  f.down('b', { ctrlKey: true, code: 'KeyB' })
  const commandHints = f.hints.length
  expect(f.down('b', { ctrlKey: true, code: 'KeyB', repeat: true }).defaultPrevented).toBe(true)
  expect(f.hint().prefix).toBe('command')
  expect(f.hints).toHaveLength(commandHints)
  expect(f.up('b', { code: 'KeyB' }).defaultPrevented).toBe(true)
  f.down('q', { code: 'KeyQ' })
  const numberHints = f.hints.length
  expect(f.down('q', { code: 'KeyQ', repeat: true }).defaultPrevented).toBe(true)
  expect(f.hint().prefix).toBe('numbers')
  expect(f.hints).toHaveLength(numberHints)
  expect(f.up('q', { code: 'KeyQ' }).defaultPrevented).toBe(true)
  expect(f.doc.activeElement === field).toBe(true)
  expect(field.value).toBe('hello world')
})

test.each(['hidden', 'visible'] as const)('document visibility %s releases or retains prefix and held key ownership', state => {
  const f = fixture(), field = f.root.querySelector('textarea')!, descriptor = Object.getOwnPropertyDescriptor(f.doc, 'visibilityState')
  Object.defineProperty(f.doc, 'visibilityState', { configurable: true, get: () => state })
  cleanups.push(() => { if (descriptor) Object.defineProperty(f.doc, 'visibilityState', descriptor); else Reflect.deleteProperty(f.doc, 'visibilityState') })
  field.focus(); field.setSelectionRange(3, 3)
  f.down('b', { ctrlKey: true, code: 'KeyB' })
  f.doc.dispatchEvent(new f.win.Event('visibilitychange'))
  expect(f.hint().prefix).toBe(state === 'hidden' ? 'off' : 'command')
  expect(f.up('b', { code: 'KeyB' }).defaultPrevented).toBe(state !== 'hidden')
  expect([field.value, field.selectionStart]).toEqual(['hello world', 3])
})

test.each([{ label: 'Workspace', expected: 'Workspace' }, { label: undefined, expected: 'Dialog' }])('an unmarked root uses accessible label fallback $expected in pane hints', ({ label, expected }) => {
  const f = fixture()
  f.root.innerHTML = '<button>Action</button>'; f.place(f.root, 20, 20)
  if (label !== undefined) f.root.setAttribute('aria-label', label)
  const button = f.root.querySelector('button')!; f.place(button, 20, 20); button.focus()
  f.prefix('q')
  expect(f.hint().panes.map(({ label, index }) => ({ label, index }))).toEqual([{ label: expected, index: 0 }])
  expect(f.hint().portal === f.root).toBe(true)
})

test('a visible pane with no controls keeps focus when there is nothing to rove to', () => {
  const f = fixture(), pane = f.panes[2]!
  pane.replaceChildren(); focusPane(pane)
  expect(f.key('j').defaultPrevented).toBe(true)
  expect(f.doc.activeElement === pane).toBe(true)
  expect(pane.childElementCount).toBe(0)
  expect(f.hint().mode).toBeUndefined()
})

test('native select input events stay outside Vim buffer editing and retain native navigation', () => {
  const f = fixture(), field = f.root.querySelector('textarea')!, select = f.doc.createElement('select')
  select.innerHTML = '<option value="first">First</option><option value="second">Second</option>'
  f.panes[2]!.append(select); f.place(select, 220, 200)
  field.focus(); f.key('Escape'); select.focus()
  const before = f.hints.length
  select.value = 'second'; select.dispatchEvent(new f.win.Event('input', { bubbles: true }))
  expect(f.hints).toHaveLength(before)
  expect(select.value).toBe('second')
  expect(field.value).toBe('hello world')
  expect(f.key('j').defaultPrevented).toBe(false)
  expect(f.doc.activeElement === select).toBe(true)
})

test('Escape from a field outside marked panes returns to the binding root', () => {
  const f = fixture(), field = f.doc.createElement('input')
  field.value = 'unmarked draft'; f.root.append(field); f.place(field, 20, 20); f.place(f.root, 0, 0, 500, 500)
  field.focus(); f.key('Escape')
  expect(field.dataset.vimMode).toBe('normal')
  expect(f.key('Escape').defaultPrevented).toBe(true)
  expect(f.doc.activeElement === f.root).toBe(true)
  expect(field.hasAttribute('data-vim-mode')).toBe(false)
  expect(field.value).toBe('unmarked draft')
})

test.each([
  { key: '𐐀', expected: '𐐀bc' }, { key: 'ḍ̇', expected: 'ḍ̇bc' }, { key: '1', expected: '1bc' }, { key: 'u', expected: 'ubc' },
])('replacement key $key reaches the field through one native input update and undo', ({ key, expected }) => {
  const f = fixture(), field = f.root.querySelector('textarea')!, changes: string[] = []
  field.value = 'abc'; field.setSelectionRange(0, 0); field.focus()
  const observed = (event: Event) => { if (event.target === field) changes.push(field.value) }
  f.doc.addEventListener('input', observed); cleanups.push(() => f.doc.removeEventListener('input', observed))
  f.key('Escape'); f.key('r'); f.key(key)
  expect([field.value, field.selectionStart, field.selectionEnd, field.dataset.vimMode]).toEqual([expected, 0, 0, 'normal'])
  expect(f.hint().pending).toBe('')
  expect(changes).toEqual([expected])
  f.key('u')
  expect([field.value, field.selectionStart]).toEqual(['abc', 0])
  expect(changes).toEqual([expected, 'abc'])
})

test('end-word motion on the final empty textarea line keeps its native cursor and emits no text update', () => {
  const f = fixture(), field = f.root.querySelector('textarea')!, changes: string[] = []
  field.value = 'a\n'; field.setSelectionRange(2, 2); field.focus()
  const observed = (event: Event) => { if (event.target === field) changes.push(field.value) }
  f.doc.addEventListener('input', observed); cleanups.push(() => f.doc.removeEventListener('input', observed))
  f.key('Escape')
  expect([field.selectionStart, field.selectionEnd, field.dataset.vimMode]).toEqual([2, 2, 'normal'])
  f.key('e')
  expect([field.value, field.selectionStart, field.selectionEnd, field.dataset.vimMode]).toEqual(['a\n', 2, 2, 'normal'])
  expect(f.hint().pending).toBe('')
  expect(changes).toEqual([])
})

test('Ctrl+R with a pending replacement redoes the edit through one native input update', () => {
  const f = fixture(), field = f.root.querySelector('textarea')!, changes: string[] = []
  field.value = 'abc'; field.setSelectionRange(0, 0); field.focus()
  const observed = (event: Event) => { if (event.target === field) changes.push(field.value) }
  f.doc.addEventListener('input', observed); cleanups.push(() => f.doc.removeEventListener('input', observed))
  f.key('Escape'); f.key('x'); f.key('u'); f.key('r')
  expect([field.value, f.hint().pending]).toEqual(['abc', 'r'])
  expect(f.key('r', { ctrlKey: true }).defaultPrevented).toBe(true)
  expect([field.value, field.selectionStart, field.selectionEnd, field.dataset.vimMode, f.hint().pending]).toEqual(['bc', 0, 0, 'normal', ''])
  expect(changes).toEqual(['bc', 'abc', 'bc'])
  f.key('u')
  expect([field.value, field.selectionStart]).toEqual(['abc', 0])
  expect(changes).toEqual(['bc', 'abc', 'bc', 'abc'])
})
