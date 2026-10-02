import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
// Erased by Bun, but keeps the isolated fixture inside the app's typecheck.
import type {} from '../../e2e/fixtures/unit-entrypoints/Serve.child.test'
import type {} from '../../e2e/fixtures/unit-entrypoints/ServeReadiness.preload'

const cases = [['signal'], ['backend-failure'], ['stop-error'], ['missing-origin'], ['plue-origin']] as const
const child = fileURLToPath(new URL('../../e2e/fixtures/unit-entrypoints/Serve.child.test.ts', import.meta.url))
const atReadiness = fileURLToPath(new URL('../../e2e/fixtures/unit-entrypoints/ServeReadiness.preload.ts', import.meta.url))
const entrypoint = fileURLToPath(new URL('./serve.ts', import.meta.url))

test.each(cases)('serve entrypoint %s lifecycle runs in an isolated process', (scenario) => {
  const result = spawnSync(process.execPath, ['test', child], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env,
      SMITHERS_SERVE_SCENARIO: scenario,
      SMITHERS_API_ORIGIN: scenario === 'plue-origin' ? 'https://plue.example' : '',
      SMITHERS_LOCAL_STATE_DIR: scenario === 'plue-origin' ? '/configured' : ''
    },
    encoding: 'utf8',
    timeout: 10_000
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stderr).toContain('1 pass')
  expect(result.stderr).toContain('0 fail')
})

// Use the actual entrypoint and backend selector: Plue mode has no owned process to fake.
test.each(['SIGINT', 'SIGTERM'] as const)('serve handles real %s at readiness publication', (signal) => {
  const result = spawnSync(process.execPath, ['--preload', atReadiness, entrypoint], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env,
      SMITHERS_BACKEND_MODE: 'plue',
      SMITHERS_API_ORIGIN: 'https://plue.example',
      SMITHERS_SERVE_READINESS_SIGNAL: signal
    },
    encoding: 'utf8',
    timeout: 10_000
  })
  expect(result.error).toBeUndefined()
  const receipt = result.stdout.split('\n').find((line) => line.startsWith('SERVE_READINESS_RECEIPT='))
  expect(receipt).toBeDefined()
  expect({
    readiness: JSON.parse(receipt!.slice('SERVE_READINESS_RECEIPT='.length)),
    signal: result.signal,
    status: result.status
  }).toEqual({
    readiness: { signal, SIGINT: 1, SIGTERM: 1 },
    signal: null,
    status: 0
  })
  expect(result.stdout).toContain('SMITHERS_LOCAL_ORIGIN=https://plue.example')
  expect(result.stderr).toBe('')
})
