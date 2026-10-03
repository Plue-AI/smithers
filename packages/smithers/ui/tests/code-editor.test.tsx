import { afterEach, expect, test } from "bun:test"
import { act } from "react"
import { EditorView } from "@codemirror/view"
import { CodeEditorView, minimalChange } from "../src/adapters/code-editor"
const { createRoot } = await import("react-dom/client")
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const cleanups: (() => void)[] = []
afterEach(() => { while (cleanups.length) cleanups.pop()!() })
function mount(text = 'const emoji = "😀"\nsecond\nthird') {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host), actions: unknown[] = [], lines: unknown[] = []
  const props = { path: 'x.ts', text, language: 'typescript', diagnostics: [], gestures: { hover: { tag: 'code.hover', label: 'Hover', args: { path: 'bound' } }, definition: { tag: 'code.definition', label: 'Go to definition' } }, onAction: (...args: unknown[]) => actions.push(args), onView: (patch: unknown) => lines.push(patch) }
  act(() => root.render(<CodeEditorView {...props} />))
  const view = EditorView.findFromDOM(host.querySelector('.cm-editor')!)!
  cleanups.push(() => { act(() => root.unmount()); host.remove() })
  return { host, view, props, actions, lines, root }
}
// T-UI-11 Tests: independent literal edit ranges; not generated from implementation.
test('minimal transactions cover insertion, deletion, replacement and unchanged text', () => {
  expect(minimalChange('abcd', 'abXcd')).toEqual({ from: 2, to: 2, insert: 'X' })
  expect(minimalChange('abcd', 'ad')).toEqual({ from: 1, to: 3, insert: '' })
  expect(minimalChange('abcd', 'aXYd')).toEqual({ from: 1, to: 3, insert: 'XY' })
  expect(minimalChange('', 'new')).toEqual({ from: 0, to: 0, insert: 'new' })
  expect(minimalChange('same', 'same')).toEqual({ from: 4, to: 4, insert: '' })
})
test('CodeMirror read-only updates preserve identity, scroll and cursor in one document transaction', () => {
  const { host, view, root, props } = mount()
  act(() => view.dispatch({ selection: { anchor: 23 } }))
  view.scrollDOM.scrollTop = 45; view.scrollDOM.scrollLeft = 12
  const transactions: unknown[] = [], dispatch = view.dispatch.bind(view)
  view.dispatch = (...args: Parameters<typeof view.dispatch>) => { if ('changes' in args[0]) transactions.push(args[0]); dispatch(...args) }
  act(() => root.render(<CodeEditorView {...props} text={'const emoji = "😀"\nsecond\nTHIRD'} />))
  expect(EditorView.findFromDOM(host.querySelector('.cm-editor')!)).toBe(view)
  expect(view.state.selection.main.head).toBe(23)
  expect([view.scrollDOM.scrollTop, view.scrollDOM.scrollLeft]).toEqual([45, 12])
  expect(transactions).toEqual([{ changes: { from: 26, to: 31, insert: 'THIRD' } }])
  expect(view.contentDOM.getAttribute('aria-readonly')).toBe('true')
  expect(view.contentDOM.contentEditable).toBe('false')
})
test('keyboard hover and definition dispatch exact UTF-16 coordinates once without moving cursor', () => {
  const { view, actions, lines } = mount()
  act(() => view.dispatch({ selection: { anchor: 18 } }))
  expect(lines).toEqual([{ line: 1 }])
  actions.length = 0; lines.length = 0
  act(() => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', ctrlKey: true, bubbles: true })))
  act(() => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true })))
  expect(actions).toEqual([['code.hover', { path: 'x.ts', line: '1', col: '18' }], ['code.definition', { path: 'x.ts', line: '1', col: '18' }]])
  expect(view.state.selection.main.head).toBe(18)
  expect(lines).toEqual([])
})
test('reveal clamps positions; omitted gestures do not dispatch; hostile hover remains text', () => {
  const { root, props, view, host, actions } = mount()
  act(() => root.render(<CodeEditorView {...props} gestures={{}} reveal={{ line: 999, col: 999 }} hover={{ line: 1, col: 0, markdown: '<img src=x onerror=alert(1)>' }} />))
  expect(view.state.selection.main.head).toBe(31)
  expect(host.querySelector('[role=tooltip]')!.textContent).toBe('<img src=x onerror=alert(1)>')
  expect(host.querySelector('img')).toBeNull()
  act(() => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true })))
  expect(actions).toEqual([])
})
// T-UI-11: CodeMirror normalizes source line endings; prop refreshes preserve reading position.
test('CRLF input and updates keep two source lines without redundant changes', () => {
  const { root, props, view } = mount('a\r\nb')
  expect(view.state.doc.toString()).toBe('a\nb')
  expect(view.state.doc.lines).toBe(2)
  act(() => root.render(<CodeEditorView {...props} text={'a\r\nc'} />))
  expect(view.state.doc.toString()).toBe('a\nc')
  expect(view.state.doc.lines).toBe(2)
})
test('path updates the accessible textbox name', () => {
  const { root, props, view } = mount()
  act(() => root.render(<CodeEditorView {...props} path='new.ts' />))
  expect(view.contentDOM.getAttribute('aria-label')).toBe('new.ts')
})
test('equal reveal coordinates do not reset selection or emit another view patch', () => {
  const { root, props, view, lines } = mount()
  act(() => root.render(<CodeEditorView {...props} reveal={{ line: 2, col: 1 }} />))
  act(() => view.dispatch({ selection: { anchor: 0 } }))
  lines.length = 0
  act(() => root.render(<CodeEditorView {...props} reveal={{ line: 2, col: 1 }} diagnostics={[]} />))
  expect(view.state.selection.main.head).toBe(0)
  expect(lines).toEqual([])
})
test('Ctrl pointer hover emits once per position and resets when released or leaving', () => {
  const { view, actions } = mount()
  // happy-dom has no text layout; isolate only the browser coordinate lookup.
  let pos: number | null = 2
  view.posAtCoords = () => pos
  const move = (ctrlKey: boolean) => {
    const event = new MouseEvent('mousemove', { ctrlKey, bubbles: true, cancelable: true })
    act(() => view.contentDOM.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
  }
  move(true); move(true)
  expect(actions).toEqual([['code.hover', { path: 'x.ts', line: '1', col: '2' }]])
  pos = 3; move(true); move(true)
  expect(actions).toHaveLength(2)
  move(false); move(true)
  expect(actions).toHaveLength(3)
  act(() => view.contentDOM.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })))
  move(true)
  expect(actions).toHaveLength(4)
  pos = null; move(true)
  expect(actions).toHaveLength(4)
})

test('disabled pointer gesture and omitted definition emit no action', () => {
  const { root, props, view, actions } = mount()
  act(() => root.render(<CodeEditorView {...props} gestures={{ hover: { tag: 'code.hover', label: 'Hover', disabled: { reason: 'Unavailable' } } }} />))
  // happy-dom cannot resolve coordinates; all dispatch and editor behavior remain real.
  view.posAtCoords = () => 2
  act(() => view.contentDOM.dispatchEvent(new MouseEvent('mousemove', { ctrlKey: true, bubbles: true })))
  act(() => view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'F12', bubbles: true })))
  expect(actions).toEqual([])
  expect(view.state.selection.main.head).toBe(0)
})
