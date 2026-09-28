import { expect, mock, test } from 'bun:test'

const scenario = process.env.SMITHERS_SERVE_SCENARIO
const failure = Promise.withResolvers<Error | undefined>()
const stopped = Promise.withResolvers<void>()
const started = Promise.withResolvers<string>()
const calls: Array<{ stateDir: string; webRoot: string }> = []
const logs: string[] = []
const errors: string[] = []
let stopCalls = 0

const originalLog = console.log
const originalError = console.error
console.log = (value: unknown) => {
  const line = String(value)
  logs.push(line)
  if (line.startsWith('SMITHERS_LOCAL_ORIGIN=')) started.resolve(line)
}
console.error = (value: unknown) => { errors.push(String(value)) }

mock.module('../../../src/bun/NativeBackendProcess', () => ({
  startNativeBackend: async (options: { stateDir: string; webRoot: string }) => {
    calls.push(options)
    return {
      mode: scenario === 'missing-origin' || scenario === 'plue-origin' ? 'plue' : 'own',
      origin: 'http://127.0.0.1:4185',
      failure: failure.promise,
      stop: () => {
        stopCalls++
        return scenario === 'signal' ? stopped.promise
          : scenario === 'stop-error' ? Promise.reject(new Error('stop failed'))
            : Promise.resolve()
      }
    }
  }
}))
mock.module('../../../src/bun/NativeState', () => ({ nativeStateDirectory: () => '/state' }))
mock.module('../../../src/bun/server', () => ({ defaultDistDir: () => '/web' }))

const within = async <T>(promise: Promise<T>): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('serve entrypoint did not settle')), 2_000) })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

test('headless serve entrypoint handles its lifecycle', async () => {
  try {
    const entry = import('../../../src/bun/serve')
    if (scenario === 'missing-origin') {
      await expect(within(entry)).rejects.toThrow('SMITHERS_API_ORIGIN is required in Plue mode.')
      expect(logs).toEqual([])
      expect(stopCalls).toBe(1)
      return
    }

    const line = await within(started.promise)
    expect(line).toBe(scenario === 'plue-origin'
      ? 'SMITHERS_LOCAL_ORIGIN=https://plue.example'
      : 'SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:4185')
    expect(calls).toEqual([{ stateDir: scenario === 'plue-origin' ? '/configured' : '/state/headless', webRoot: '/web' }])
    expect(stopCalls).toBe(0)

    if (scenario === 'signal') {
      process.emit('SIGTERM')
      process.emit('SIGINT')
      expect(stopCalls).toBe(1)
      stopped.resolve()
      await within(entry)
      expect(errors).toEqual([])
      expect(process.exitCode).toBeUndefined()
    } else if (scenario === 'backend-failure') {
      failure.resolve(new Error('backend crashed'))
      await within(entry)
      expect(stopCalls).toBe(1)
      expect(errors).toEqual(['backend crashed'])
      expect(process.exitCode).toBe(1)
    } else if (scenario === 'stop-error') {
      process.emit('SIGINT')
      await within(entry)
      expect(stopCalls).toBe(1)
      expect(errors).toEqual(['Error: stop failed'])
      expect(process.exitCode).toBe(1)
    } else if (scenario === 'plue-origin') {
      process.emit('SIGTERM')
      await within(entry)
      expect(stopCalls).toBe(1)
      expect(errors).toEqual([])
    } else {
      throw new Error(`unknown serve scenario: ${String(scenario)}`)
    }
  } finally {
    console.log = originalLog
    console.error = originalError
    process.exitCode = 0
  }
})
