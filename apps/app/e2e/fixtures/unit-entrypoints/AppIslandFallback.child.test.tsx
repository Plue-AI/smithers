import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { expect, mock, test } from 'bun:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

const originalFetch = globalThis.fetch
GlobalRegistrator.register({ url: 'https://shell.test' })
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, value: true })
document.cookie = '__csrf=fallback-csrf; Path=/'
const target = document.createElement('meta')
target.name = 'smithers-application-target'
target.content = '{invalid-json'
document.head.append(target)

const reports: Array<{ input: string; init: RequestInit }> = []
const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  reports.push({ input: String(input), init: init ?? {} })
  return new Response(null, { status: 204 })
}
globalThis.fetch = Object.assign(fakeFetch, { preconnect: originalFetch.preconnect })

mock.module('../../../src/mainview/ControllerProvider', () => ({ configureControllerBoot: () => undefined }))
mock.module('../../../src/mainview/AppRoot', () => ({ AppRoot: () => <div>Smithers</div> }))
mock.module('../../../src/mainview/AppMount', () => ({ mountApp: () => undefined, warmApp: () => undefined }))

test('AppIsland reports a malformed target through the serving origin with CSRF', async () => {
  const { default: AppIsland } = await import('../../../src/mainview/AppIsland')
  const { browserStartupWatchdog } = await import('../../../src/mainview/StartupWatchdog')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  try {
    act(() => root.render(<AppIsland />))
    window.dispatchEvent(new ErrorEvent('error', { error: new Error('target load failed') }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reports).toHaveLength(1)
    expect(reports[0]?.input).toBe('/api/telemetry/errors')
    expect(reports[0]?.init.credentials).toBe('include')
    expect(new Headers(reports[0]?.init.headers).get('x-csrf-token')).toBe('fallback-csrf')
    expect(new Headers(reports[0]?.init.headers).has('authorization')).toBe(false)
  } finally {
    act(() => root.unmount())
    host.remove()
    await browserStartupWatchdog().stop()
    globalThis.fetch = originalFetch
    await GlobalRegistrator.unregister()
  }
}, 30_000)
