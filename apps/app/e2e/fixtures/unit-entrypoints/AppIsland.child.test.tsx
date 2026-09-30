import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const originalFetch = globalThis.fetch
GlobalRegistrator.register({ url: 'https://shell.test' })
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
document.cookie = '__csrf=entry-csrf; Path=/'

const bootOptions: unknown[] = []
const roots: unknown[] = []
const reports: Array<{ input: string; init: RequestInit }> = []
const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  reports.push({ input: String(input), init: init ?? {} })
  return new Response(null, { status: 204 })
}
globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect })
const mountApp = () => 'mounted by site'
const warmApp = () => 'warmed by site'

mock.module('../../../src/mainview/ControllerProvider', () => ({
  configureControllerBoot: (options: unknown) => bootOptions.push(options)
}))
mock.module('../../../src/mainview/AppRoot', () => ({
  AppRoot: ({ watchdog }: { watchdog: unknown }) => {
    roots.push(watchdog)
    return <div>Smithers</div>
  }
}))
mock.module('../../../src/mainview/AppMount', () => ({ mountApp, warmApp }))
test('AppIsland wires one reporter into boot and watchdog across renders', async () => {
  const { default: AppIsland } = await import('../../../src/mainview/AppIsland')
  const { browserStartupWatchdog, startStartupWatchdog } = await import('../../../src/mainview/StartupWatchdog')
  expect(bootOptions).toHaveLength(0)
  window.dispatchEvent(new ErrorEvent('error', { error: new Error('before render'), message: 'before render' }))
  expect(reports).toHaveLength(0)
  expect(Object.is(AppIsland.mountApp, mountApp)).toBe(true)
  expect(Object.is(AppIsland.warmApp, warmApp)).toBe(true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let fallbackWatchdog: ReturnType<typeof startStartupWatchdog> | undefined
  try {
    act(() => root.render(<AppIsland />))
    expect(host.querySelector('div')?.textContent).toBe('Smithers')
    expect(bootOptions).toHaveLength(1)
    expect(roots).toHaveLength(1)
    expect(roots[0]).toBe(browserStartupWatchdog())
    const firstReporter = (bootOptions[0] as { clientErrors: unknown }).clientErrors
    expect(firstReporter).toBeDefined()
    act(() => root.render(<AppIsland />))
    expect(bootOptions).toHaveLength(2)
    expect((bootOptions[1] as { clientErrors: unknown }).clientErrors).toBe(firstReporter)
    expect(roots).toEqual([browserStartupWatchdog(), browserStartupWatchdog()])

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('entry boom'), message: 'entry boom' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports).toHaveLength(1)
    expect(reports[0]?.input).toBe('/api/telemetry/errors')
    expect(reports[0]?.init.credentials).toBe('include')
    expect(new Headers(reports[0]?.init.headers).get('x-csrf-token')).toBe('entry-csrf')
    const body = JSON.parse(String(reports[0]?.init.body)) as { kind: string; error: { message: string } }
    expect(body.kind).toBe('error')
    expect(body.error.message).toContain('entry boom')

    await browserStartupWatchdog().stop()
    fallbackWatchdog = startStartupWatchdog({ timeoutMs: 60_000 })
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('default reporter boom') }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports).toHaveLength(2)
    expect(reports[1]?.input).toBe('/api/telemetry/errors')
    expect(new Headers(reports[1]?.init.headers).get('x-csrf-token')).toBe('entry-csrf')
  } finally {
    act(() => root.unmount())
    host.remove()
    await browserStartupWatchdog().stop()
    await fallbackWatchdog?.stop()
    globalThis.fetch = originalFetch
    await GlobalRegistrator.unregister()
  }
}, 30_000)
