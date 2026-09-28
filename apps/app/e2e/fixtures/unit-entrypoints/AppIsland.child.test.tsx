import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

GlobalRegistrator.register()
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })

const bootOptions: unknown[] = []
const roots: unknown[] = []
const reports: Array<{ input: string; init: RequestInit }> = []
let appFetchCalls = 0
const fakeFetch = async (input: string, init: RequestInit) => {
  reports.push({ input, init })
  return new Response(null, { status: 204 })
}
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
mock.module('../../../src/mainview/runtime/LocalSession', () => ({ createAppFetch: () => { appFetchCalls++; return fakeFetch } }))

test('AppIsland wires one reporter into boot and watchdog across renders', async () => {
  const { default: AppIsland } = await import('../../../src/mainview/AppIsland')
  const { browserStartupWatchdog } = await import('../../../src/mainview/StartupWatchdog')
  expect(appFetchCalls).toBe(0)
  expect(bootOptions).toHaveLength(0)
  window.dispatchEvent(new ErrorEvent('error', { error: new Error('before render'), message: 'before render' }))
  expect(reports).toHaveLength(0)
  expect(Object.is(AppIsland.mountApp, mountApp)).toBe(true)
  expect(Object.is(AppIsland.warmApp, warmApp)).toBe(true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    act(() => root.render(<AppIsland />))
    expect(host.querySelector('div')?.textContent).toBe('Smithers')
    expect(bootOptions).toHaveLength(1)
    expect(roots).toHaveLength(1)
    expect(roots[0]).toBe(browserStartupWatchdog())
    expect(appFetchCalls).toBe(1)
    const firstReporter = (bootOptions[0] as { clientErrors: unknown }).clientErrors
    expect(firstReporter).toBeDefined()
    act(() => root.render(<AppIsland />))
    expect(bootOptions).toHaveLength(2)
    expect((bootOptions[1] as { clientErrors: unknown }).clientErrors).toBe(firstReporter)
    expect(roots).toEqual([browserStartupWatchdog(), browserStartupWatchdog()])
    expect(appFetchCalls).toBe(1)

    window.dispatchEvent(new ErrorEvent('error', { error: new Error('entry boom'), message: 'entry boom' }))
    await Promise.resolve()
    expect(reports).toHaveLength(1)
    expect(reports[0]?.input).toBe('/api/telemetry/errors')
    const body = JSON.parse(String(reports[0]?.init.body)) as { kind: string; error: { message: string } }
    expect(body.kind).toBe('error')
    expect(body.error.message).toContain('entry boom')
  } finally {
    act(() => root.unmount())
    host.remove()
    await browserStartupWatchdog().stop()
    await GlobalRegistrator.unregister()
  }
})
