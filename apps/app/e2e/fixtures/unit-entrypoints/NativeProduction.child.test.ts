import { expect, mock, test } from 'bun:test'

const scenario = process.env.SMITHERS_NATIVE_PRODUCTION_SCENARIO
const realExit = process.env.SMITHERS_NATIVE_REAL_EXIT === '1'
const events = new Map<string, Array<(event: { response?: { allow: boolean } }) => void>>()
const failure = Promise.withResolvers<Error | undefined>()
const releaseStop = Promise.withResolvers<void>()
const backendStopStarted = Promise.withResolvers<void>()
const testStopStarted = Promise.withResolvers<void>()
const exited = Promise.withResolvers<number>()
const calls: string[] = []
const errors: string[] = []
const windows: Array<{ url: string }> = []
const rendererFault = new Error('packaged renderer unavailable')
const configFault = new Error('configuration refused')
const cleanupFault = new Error('backend cleanup failed')
const rendererStopFault = new Error('renderer cleanup failed')
const bridgeStopFault = new Error('bridge cleanup failed')
const windowCloseFault = new Error('window close failed')
const rollbackBackendFault = new Error('backend failed during rollback')
const rollbackQuitEvents: Array<{ response?: { allow: boolean } }> = []
let requests: Record<string, (params: unknown) => Promise<unknown>> = {}

const originalExit = process.exit
const originalError = console.error
// SDK Utils.quit asks before-quit approval before native quitGracefully.
process.exit = ((code?: number) => {
  const event: { response?: { allow: boolean } } = {}
  for (const handler of events.get('before-quit') ?? []) handler(event)
  if (event.response?.allow === false) return undefined as never
  calls.push(`exit:${code ?? 0}`)
  exited.resolve(code ?? 0)
  if (realExit) {
    const expected = ['backend:start', 'renderer:start:http://127.0.0.1:4185:', 'window:close', 'renderer:stop', 'backend:stop', 'exit:1']
    if (JSON.stringify(calls) !== JSON.stringify(expected) || code !== 1 ||
      JSON.stringify(rollbackQuitEvents) !== JSON.stringify([{ response: { allow: false } }])) {
      throw new Error('SDK-approved termination occurred before complete rollback')
    }
    process.stdout.write('native rollback cleanup complete; SDK exit approved:1\n')
    originalExit(1)
  }
  return undefined as never
}) as typeof process.exit
console.error = (value: unknown) => {
  errors.push(String(value))
  if (realExit) originalError(value)
}

mock.module('electrobun/main', () => ({
  default: { events: { on: (name: string, listener: (event: { response?: { allow: boolean } }) => void) => {
    events.set(name, [...(events.get(name) ?? []), listener])
  } } },
  BrowserView: { defineRPC: (config: { handlers: { requests: typeof requests } }) => {
    requests = config.handlers.requests
    return { proxy: {} }
  } },
  BrowserWindow: class {
    readonly webview = { loadURL: (_url: string) => {} }
    constructor(options: { url: string }) {
      // The SDK throws this literal when its native createWindow returns falsy.
      if (scenario === 'window-start-error') throw 'Failed to create window'
      windows.push({ url: options.url })
    }
    activate() {}
    close() {
      calls.push('window:close')
      if (scenario === 'bridge-start-error' || scenario === 'bridge-window-close-error' || scenario === 'bridge-rollback-backend-failure') {
        const event: { response?: { allow: boolean } } = {}
        for (const handler of events.get('before-quit') ?? []) handler(event)
        rollbackQuitEvents.push(event)
      }
      if (scenario === 'bridge-rollback-backend-failure') failure.resolve(rollbackBackendFault)
      if (scenario === 'bridge-window-close-error') throw windowCloseFault
    }
  },
  BuildConfig: { getSync: () => ({ isPackaged: false, channel: 'dev', defaultRenderer: 'native' }) },
  Screen: { captureRegion: () => null },
  Utils: { openExternal: () => true }
}))
mock.module('../../../src/bun/NativeBackendProcess', () => ({
  startNativeBackend: async () => {
    calls.push('backend:start')
    return {
      mode: 'own',
      origin: 'http://127.0.0.1:4185',
      failure: failure.promise,
      stop: () => {
        calls.push('backend:stop')
        backendStopStarted.resolve()
        return scenario === 'duplicate-shutdown' || scenario === 'shutdown-renderer-stop-error' || scenario === 'bridge-rollback-backend-failure' ? releaseStop.promise
          : scenario === 'startup-backend-stop-error' ? Promise.reject(cleanupFault)
            : Promise.resolve()
      }
    }
  }
}))
mock.module('../../../src/bun/NativeRendererServer', () => ({
  startNativeRendererServer: (_dist: string, apiOrigin: string, token: string) => {
    calls.push(`renderer:start:${apiOrigin}:${token}`)
    if (scenario === 'renderer-error' || scenario === 'startup-backend-stop-error') {
      throw rendererFault
    }
    return {
      origin: 'http://127.0.0.1:4920',
      stop: () => {
        calls.push('renderer:stop')
        if (scenario === 'startup-renderer-stop-error' || scenario === 'shutdown-renderer-stop-error') throw rendererStopFault
      },
      setTarget: (origin: string, credential: string) => { calls.push(`renderer:target:${origin}:${credential}`) }
    }
  }
}))
mock.module('../../../src/bun/NativeState', () => ({ nativeStateDirectory: () => '/state' }))
mock.module('../../../src/bun/server', () => ({
  defaultDistDir: () => '/web',
  startLocalServer: () => {
    if (scenario !== 'shutdown-bridge-stop-error-stub') throw new Error('stub server must not start in production path')
    calls.push('test-server:start')
    return { origin: 'http://127.0.0.1:4920', stop: () => {
      calls.push('test-server:stop')
      testStopStarted.resolve()
      return releaseStop.promise
    } }
  }
}))
mock.module('../../support/ChatStub', () => ({ createChatStub: () => {} }))
if (scenario !== 'bridge-start-error' && scenario !== 'bridge-window-close-error' && scenario !== 'bridge-rollback-backend-failure') mock.module('../../../src/bun/PackagedE2EBridge', () => ({
  encodeRgbaPng: () => new Uint8Array(),
  startPackagedE2EBridge: () => ({ stop: () => {
    calls.push('bridge:stop')
    if (scenario === 'shutdown-bridge-stop-error-stub') throw bridgeStopFault
  } })
}))
if (scenario === 'config-error' || scenario === 'startup-renderer-stop-error') mock.module('../../../src/bun/NativeBackendConfig', () => ({
  nativeBackendConfig: () => { throw configFault }
}))

const within = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('native production entrypoint did not settle')), 2_000) })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const diagnostics = (error: unknown): string[] => error instanceof AggregateError
  ? [error.message, ...error.errors.flatMap(diagnostics)]
  : error instanceof Error
    ? [error.message, ...(error.cause === undefined ? [] : diagnostics(error.cause))]
    : [String(error)]

const exercise = async () => {
  try {
    const entry = import('../../../src/bun/index')
    if (scenario === 'window-start-error' || scenario === 'bridge-start-error' || scenario === 'bridge-window-close-error' || scenario === 'bridge-rollback-backend-failure') {
      let thrown: unknown
      // Attach rejection immediately; resource completion is controlled below.
      const settled = entry.then(() => undefined, (error: unknown) => error)
      if (scenario === 'bridge-rollback-backend-failure') {
        await within(backendStopStarted.promise)
        // The failure callback was queued by close(), before backend.stop began.
        await Promise.resolve()
        expect(calls.filter((call) => call.startsWith('exit:'))).toEqual([])
        expect(calls.filter((call) => call === 'backend:stop')).toHaveLength(1)
        expect(calls.filter((call) => call === 'renderer:stop')).toHaveLength(1)
        releaseStop.resolve()
      }
      thrown = await within(settled)
      if (scenario === 'window-start-error') expect(thrown).toBe('Failed to create window')
      else {
        expect(thrown).toBeInstanceOf(Error)
        const original = scenario === 'bridge-window-close-error' ? (thrown as AggregateError).cause : thrown
        expect(original).toBeInstanceOf(Error)
        expect((original as Error).message).toBe('SMITHERS_E2E_BRIDGE_PORT must be an integer from 1 through 65535.')
        if (scenario === 'bridge-window-close-error') {
          expect(thrown).toBeInstanceOf(AggregateError)
          expect((thrown as AggregateError).errors).toEqual([original, windowCloseFault])
        }
        expect(rollbackQuitEvents).toEqual([{ response: { allow: false } }])
        expect(calls.filter((call) => call.startsWith('exit:'))).toEqual(['exit:1'])
      }
      expect(calls).toEqual([
        'backend:start', 'renderer:start:http://127.0.0.1:4185:',
        ...(scenario !== 'window-start-error' ? ['window:close'] : []),
        'renderer:stop', 'backend:stop', 'exit:1'
      ])
      expect(windows).toHaveLength(scenario === 'window-start-error' ? 0 : 1)
      return
    }
    if (scenario === 'config-error' || scenario === 'startup-renderer-stop-error' ||
      scenario === 'renderer-error' || scenario === 'startup-backend-stop-error') {
      let thrown: unknown
      try { await within(entry) } catch (error) { thrown = error }
      expect(thrown).toBeInstanceOf(Error)
      if (scenario === 'config-error') expect(thrown).toBe(configFault)
      if (scenario === 'startup-renderer-stop-error') {
        expect(thrown).toBeInstanceOf(AggregateError)
        const aggregate = thrown as AggregateError
        expect(aggregate.errors).toEqual([configFault, rendererStopFault])
        expect(aggregate.cause).toBe(configFault)
      }
      if (scenario === 'renderer-error') expect(thrown).toBe(rendererFault)
      if (scenario === 'startup-backend-stop-error') {
        expect(thrown).toBeInstanceOf(AggregateError)
        const aggregate = thrown as AggregateError
        expect(aggregate.errors).toEqual([rendererFault, cleanupFault])
        expect(aggregate.cause).toBe(rendererFault)
      }
      const messages = diagnostics(thrown)
      const configFailed = scenario === 'config-error' || scenario === 'startup-renderer-stop-error'
      expect(messages).toContain(configFailed ? 'configuration refused' : 'packaged renderer unavailable')
      if (scenario === 'startup-backend-stop-error') expect(messages).toContain('backend cleanup failed')
      if (scenario === 'startup-renderer-stop-error') expect(messages).toContain('renderer cleanup failed')
      expect(calls).toEqual([
        'backend:start', 'renderer:start:http://127.0.0.1:4185:',
        ...(configFailed ? ['renderer:stop'] : []),
        'backend:stop', 'exit:1'
      ])
      expect(windows).toEqual([])
      return
    }

    await within(entry)
    if (scenario === 'shutdown-renderer-stop-error' || scenario === 'shutdown-bridge-stop-error-stub') {
      const quitEvent: { response?: { allow: boolean } } = {}
      for (const handler of events.get('before-quit') ?? []) handler(quitEvent)
      process.emit('SIGINT')
      process.emit('SIGTERM')
      const cleanupStarted = scenario === 'shutdown-renderer-stop-error' ? backendStopStarted.promise : testStopStarted.promise
      expect(await within(Promise.race([
        cleanupStarted.then(() => 'resource-stopping'), exited.promise.then(() => 'exited')
      ]))).toBe('resource-stopping')
      expect(quitEvent.response).toEqual({ allow: false })
      expect(calls.filter((call) => call.startsWith('exit:'))).toEqual([])
      expect(calls.filter((call) => call === 'bridge:stop')).toHaveLength(1)
      if (scenario === 'shutdown-renderer-stop-error') {
        expect(calls.filter((call) => call === 'renderer:stop')).toHaveLength(1)
        expect(calls.filter((call) => call === 'backend:stop')).toHaveLength(1)
      } else {
        expect(calls.filter((call) => call === 'test-server:stop')).toHaveLength(1)
        expect(calls).not.toContain('backend:start')
      }
      releaseStop.resolve()
      expect(await within(exited.promise)).toBe(1)
      expect(errors).toEqual(['Shutdown failed: Native runtime shutdown failed.'])
      expect(calls.filter((call) => call.startsWith('exit:'))).toEqual(['exit:1'])
      return
    }
    expect(calls.slice(0, 2)).toEqual(['backend:start', 'renderer:start:http://127.0.0.1:4185:'])
    expect(windows).toEqual([{ url: 'http://127.0.0.1:4920/' }])
    expect(await requests.applicationTarget?.({})).toEqual({ target: {
      apiVersion: 1, mode: 'native-own', apiOrigin: 'http://127.0.0.1:4920',
      auth: { kind: 'session' }, cors: 'same-origin', developerExternal: false
    } })

    if (scenario === 'normal') {
      expect(await requests.switchApplicationTarget?.({ origin: 'https://plue.example', token: '  secret  ' })).toEqual({ target: {
        apiVersion: 1, mode: 'native-plue', apiOrigin: 'http://127.0.0.1:4920',
        auth: { kind: 'bearer' }, cors: 'same-origin', developerExternal: false
      } })
      expect(calls).toContain('renderer:target:https://plue.example:secret')
      expect(await requests.applicationToken?.({})).toEqual({ token: 'secret' })
      process.emit('SIGTERM')
      expect(await within(exited.promise)).toBe(0)
      expect(calls.filter((call) => call === 'backend:stop')).toHaveLength(1)
      expect(calls.filter((call) => call === 'renderer:stop')).toHaveLength(1)
      expect(calls.filter((call) => call === 'bridge:stop')).toHaveLength(1)
    } else if (scenario === 'backend-failure') {
      failure.resolve(new Error('backend crashed'))
      expect(await within(exited.promise)).toBe(1)
      expect(errors).toContain('backend crashed')
      expect(errors).toContain('Shutdown failed: Native runtime shutdown failed.')
      expect(calls.filter((call) => call === 'backend:stop')).toHaveLength(1)
      expect(calls.filter((call) => call === 'renderer:stop')).toHaveLength(1)
    } else if (scenario === 'duplicate-shutdown') {
      const quitEvent: { response?: { allow: boolean } } = {}
      for (const handler of events.get('before-quit') ?? []) handler(quitEvent)
      process.emit('SIGINT')
      process.emit('SIGTERM')
      expect(quitEvent.response).toEqual({ allow: false })
      await within(backendStopStarted.promise)
      expect(calls.filter((call) => call === 'backend:stop')).toHaveLength(1)
      expect(calls.filter((call) => call === 'renderer:stop')).toHaveLength(1)
      expect(calls.filter((call) => call.startsWith('exit:'))).toEqual([])
      releaseStop.resolve()
      expect(await within(exited.promise)).toBe(0)
      expect(calls.filter((call) => call.startsWith('exit:'))).toEqual(['exit:0'])
    } else {
      throw new Error(`unknown native production scenario: ${String(scenario)}`)
    }
  } finally {
    process.exit = originalExit
    console.error = originalError
  }
}

if (realExit) {
  // Model the SDK's live message pump and log-only rejection handler. A rejected
  // entry module must not end this child; only an approved exit may terminate it.
  setInterval(() => {}, 1_000)
  process.on('unhandledRejection', (reason) => console.error(`Unhandled rejection in worker: ${String(reason)}`))
  void import('../../../src/bun/index')
} else {
  test('native production entrypoint owns startup, rollback, and shutdown', exercise)
}
