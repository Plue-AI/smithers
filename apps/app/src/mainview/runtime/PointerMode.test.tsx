import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { useCoarsePointer } from './PointerMode'

GlobalRegistrator.register()

const originalMatchMedia = Object.getOwnPropertyDescriptor(globalThis, 'matchMedia')
const originalActEnvironment = Object.getOwnPropertyDescriptor(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
  if (originalMatchMedia) Object.defineProperty(globalThis, 'matchMedia', originalMatchMedia)
  else Reflect.deleteProperty(globalThis, 'matchMedia')
})

afterAll(async () => {
  if (originalActEnvironment) Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', originalActEnvironment)
  else Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  await GlobalRegistrator.unregister()
})

function controlledMedia(initial: boolean) {
  let matches = initial
  let additions = 0
  let removals = 0
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const media = {
    media: '(pointer: coarse)',
    get matches() { return matches },
    onchange: null,
    addEventListener(type: string, listener: (event: MediaQueryListEvent) => void) {
      if (type !== 'change') return
      additions++
      listeners.add(listener)
    },
    removeEventListener(type: string, listener: (event: MediaQueryListEvent) => void) {
      if (type !== 'change') return
      removals++
      listeners.delete(listener)
    },
    setMatches(next: boolean) {
      matches = next
      for (const listener of [...listeners]) listener(new Event('change') as MediaQueryListEvent)
    },
    counts: () => ({ additions, removals, listeners: listeners.size })
  }
  return media
}

function Probe({ label = '' }: { label?: string }) {
  return <span>{label}{useCoarsePointer() ? 'coarse' : 'fine'}</span>
}

function mount() {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let mounted = true
  const unmount = () => {
    if (!mounted) return
    mounted = false
    act(() => root.unmount())
    host.remove()
  }
  cleanups.push(unmount)
  return { host, root, unmount }
}

test('a host without matchMedia reports fine pointer capability', () => {
  Reflect.deleteProperty(globalThis, 'matchMedia')
  const { host, root } = mount()
  act(() => root.render(<Probe />))
  expect(host.textContent).toBe('fine')
})

test.each([false, true])('initial coarse pointer match %p is read from the hardware query', initial => {
  const media = controlledMedia(initial)
  const queries: string[] = []
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: (query: string) => { queries.push(query); return media as unknown as MediaQueryList }
  })
  const { host, root } = mount()
  act(() => root.render(<Probe />))
  expect(host.textContent).toBe(initial ? 'coarse' : 'fine')
  expect(queries.length).toBeGreaterThan(0)
  expect(new Set(queries)).toEqual(new Set(['(pointer: coarse)']))
  expect(media.counts()).toEqual({ additions: 1, removals: 0, listeners: 1 })
})

test('change notifications update the rendered capability without resubscribing on rerender', () => {
  const media = controlledMedia(false)
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: () => media as unknown as MediaQueryList
  })
  const { host, root, unmount } = mount()
  act(() => root.render(<Probe label="first:" />))
  expect(host.textContent).toBe('first:fine')
  act(() => media.setMatches(true))
  expect(host.textContent).toBe('first:coarse')
  act(() => root.render(<Probe label="second:" />))
  expect(host.textContent).toBe('second:coarse')
  expect(media.counts()).toEqual({ additions: 1, removals: 0, listeners: 1 })
  act(() => media.setMatches(false))
  expect(host.textContent).toBe('second:fine')
  unmount()
  expect(media.counts()).toEqual({ additions: 1, removals: 1, listeners: 0 })
  act(() => media.setMatches(true))
  expect(host.textContent).toBe('')
})

test('server rendering uses the fine-pointer snapshot even if a browser match would be coarse', () => {
  const media = controlledMedia(true)
  Object.defineProperty(globalThis, 'matchMedia', {
    configurable: true,
    value: () => media as unknown as MediaQueryList
  })
  expect(renderToStaticMarkup(<Probe />)).toBe('<span>fine</span>')
  expect(media.counts()).toEqual({ additions: 0, removals: 0, listeners: 0 })
})
