import { mock } from 'bun:test'

// Unit boundary model: the actual entrypoint waits for a backend that already
// owns a child, while the SDK asks synchronous before-quit approval.
const listeners = new Map<string, Array<(event: { response?: { allow: boolean } }) => void>>()
const ready = Promise.withResolvers<{
  mode: 'own'
  origin: string
  failure: Promise<undefined>
  stop: () => Promise<void>
}>()
const resources = {
  backend: { started: 0, stopped: 0 },
  renderer: { started: 0, stopped: 0 },
  bridge: { started: 0, stopped: 0 }
}
let windowsOpened = 0
let quitVetoes = 0
let stopCalls = 0
let quitWhileStarting = false
let stopCompleted = false
const scenario = process.env.SMITHERS_NATIVE_EARLY_QUIT_SCENARIO
const originalExit = process.exit
const approvedQuitCodes: number[] = []
let sdkQuitting = false
const requestQuit = (code: number) => {
  // Once quitting, the SDK's process.exit override calls quitGracefully again
  // directly. JavaScript still runs while the native host schedules exit.
  if (!sdkQuitting) {
    const event: { response?: { allow: boolean } } = {}
    for (const handler of listeners.get('before-quit') ?? []) handler(event)
    if (event.response?.allow === false) { quitVetoes++; return false }
  }
  approvedQuitCodes.push(code)
  if (approvedQuitCodes.length !== 1) {
    process.stdout.write(`duplicate SDK-approved quit:${JSON.stringify(approvedQuitCodes)}\n`)
    originalExit(2)
  }
  sdkQuitting = true
  setImmediate(() => {
    if (!quitWhileStarting || stopCalls !== 1 || !stopCompleted || quitVetoes !== 2 ||
      Object.values(resources).some((resource) => resource.started !== resource.stopped)) {
      process.stdout.write(`early quit approved before complete lease cleanup:${JSON.stringify({ resources, stopCalls, stopCompleted, quitVetoes })}\n`)
      originalExit(3)
    }
    process.stdout.write(`native early quit cleanup complete:${JSON.stringify({ resources, windowsOpened, quitVetoes, code, approvedQuitCodes })}\n`)
    originalExit(code)
  })
  return true
}
process.exit = ((code?: number) => { requestQuit(code ?? 0); return undefined as never }) as typeof process.exit

mock.module('electrobun/main', () => ({
  default: { events: { on: (name: string, handler: (event: { response?: { allow: boolean } }) => void) => {
    listeners.set(name, [...(listeners.get(name) ?? []), handler])
  } } },
  BrowserView: { defineRPC: () => ({ proxy: {} }) },
  BrowserWindow: class { constructor() { windowsOpened++ } activate() {} close() {} },
  BuildConfig: { getSync: () => ({ isPackaged: false, channel: 'dev', defaultRenderer: 'native' }) },
  Screen: { captureRegion: () => null },
  Utils: { openExternal: () => true }
}))
const lease = {
  mode: 'own' as const, origin: 'http://127.0.0.1:4185', failure: Promise.resolve(undefined),
  stop: async () => {
    stopCalls++
    resources.backend.stopped++
    if (scenario === 'renderer-start-error') {
      // SDK quit during rollback must not exit while stop remains unresolved.
      await new Promise<void>((resolve) => setImmediate(() => {
        quitWhileStarting = true
        if (requestQuit(0)) throw new Error('approved quit unexpectedly returned')
        if (requestQuit(0)) throw new Error('duplicate approved quit unexpectedly returned')
        resolve()
      }))
    }
    stopCompleted = true
  }
}
mock.module('../../../src/bun/NativeBackendProcess', () => ({
  startNativeBackend: () => {
    resources.backend.started++
    if (scenario === 'renderer-start-error') return Promise.resolve(lease)
    // NativeBackendProcess spawns before its readiness await and returns its
    // stop lease only after a successful probe. This deferred boundary models
    // that ownership interval; no Go process is launched in this unit child.
    setImmediate(async () => {
      quitWhileStarting = true
      if (requestQuit(0)) throw new Error('approved quit unexpectedly returned')
      if (requestQuit(0)) throw new Error('duplicate approved quit unexpectedly returned')
      if (scenario === 'readiness-rejection') {
        // The real backend launcher cleans its spawned child before rejecting.
        await lease.stop()
        ready.reject(new Error('owned backend readiness failed'))
      } else ready.resolve(lease)
    })
    return ready.promise
  }
}))
mock.module('../../../src/bun/NativeState', () => ({ nativeStateDirectory: () => '/state' }))
mock.module('../../../src/bun/server', () => ({ defaultDistDir: () => '/web', startLocalServer: () => { throw new Error('unexpected test host') } }))
mock.module('../../../src/bun/NativeRendererServer', () => ({
  startNativeRendererServer: () => {
    if (scenario === 'renderer-start-error' || scenario === 'pending-renderer-start-error') throw new Error('renderer acquisition failed')
    resources.renderer.started++
    return { origin: 'http://127.0.0.1:4920', stop: () => { resources.renderer.stopped++ }, setTarget: () => {} }
  }
}))
mock.module('../../../src/bun/NativeBackendConfig', () => ({
  nativeBackendConfig: () => ({
    rendererOrigin: 'http://127.0.0.1:4920', token: null, bootstrapToken: null,
    target: { apiVersion: 1, mode: 'native-own', apiOrigin: 'http://127.0.0.1:4920', auth: { kind: 'session' }, cors: 'same-origin', developerExternal: false }
  })
}))
mock.module('../../../src/bun/PackagedE2EBridge', () => ({
  encodeRgbaPng: () => new Uint8Array(),
  startPackagedE2EBridge: () => {
    resources.bridge.started++
    return { stop: () => { resources.bridge.stopped++ } }
  }
}))

// The SDK keeps its native pump alive and logs rejections rather than exiting.
setInterval(() => {}, 1_000)
process.on('unhandledRejection', (error) => console.error(error))
void import('../../../src/bun/index')
