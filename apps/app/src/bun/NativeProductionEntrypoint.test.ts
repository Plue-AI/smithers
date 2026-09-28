import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
// Erased by Bun; pulls the isolated production-path fixture into app typecheck.
import type {} from '../../e2e/fixtures/unit-entrypoints/NativeProduction.child.test'

const cases = [['normal'], ['config-error'], ['startup-renderer-stop-error'], ['renderer-error'],
  ['startup-backend-stop-error'], ['backend-failure'], ['duplicate-shutdown'],
  ['shutdown-renderer-stop-error'], ['shutdown-bridge-stop-error-stub'],
  ['window-start-error'], ['bridge-start-error'], ['bridge-window-close-error'], ['bridge-rollback-backend-failure']] as const
const child = fileURLToPath(new URL('../../e2e/fixtures/unit-entrypoints/NativeProduction.child.test.ts', import.meta.url))

test.each(cases)('native production entrypoint %s runs in an isolated process', (scenario) => {
  const result = spawnSync(process.execPath, ['test', child], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env,
      SMITHERS_NATIVE_PRODUCTION_SCENARIO: scenario,
      SMITHERS_NATIVE_REAL_EXIT: '',
      SMITHERS_CHAT_STUB: scenario === 'shutdown-bridge-stop-error-stub' ? '1' : '',
      SMITHERS_LOCAL_HEADLESS: '',
      SMITHERS_API_ORIGIN: '',
      SMITHERS_API_TOKEN: '',
      SMITHERS_OPEN_URL: '',
      SMITHERS_E2E_BRIDGE: scenario === 'bridge-start-error' || scenario === 'bridge-window-close-error' || scenario === 'bridge-rollback-backend-failure' ? '1' : '',
      SMITHERS_E2E_BRIDGE_PORT: '0',
      SMITHERS_E2E_BRIDGE_TOKEN: '',
      SMITHERS_NATIVE_E2E_VISIBLE: ''
    },
    encoding: 'utf8',
    timeout: 10_000
  })
  expect(result.error).toBeUndefined()
  if (result.status !== 0) throw new Error(`native production child failed:\n${result.stderr}`)
  expect(result.stderr).toContain('1 pass')
  expect(result.stderr).toContain('0 fail')
})


test('failed native startup completes rollback and terminates through SDK quit approval', () => {
  const result = spawnSync(process.execPath, ['run', child], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env,
      SMITHERS_NATIVE_PRODUCTION_SCENARIO: 'bridge-start-error',
      SMITHERS_NATIVE_REAL_EXIT: '1',
      SMITHERS_CHAT_STUB: '',
      SMITHERS_LOCAL_HEADLESS: '',
      SMITHERS_API_ORIGIN: '',
      SMITHERS_API_TOKEN: '',
      SMITHERS_OPEN_URL: '',
      SMITHERS_E2E_BRIDGE: '1',
      SMITHERS_E2E_BRIDGE_PORT: '0',
      SMITHERS_E2E_BRIDGE_TOKEN: '',
      SMITHERS_NATIVE_E2E_VISIBLE: ''
    },
    encoding: 'utf8',
    timeout: 3_000,
    killSignal: 'SIGKILL'
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(1)
  expect(result.signal).toBeNull()
  expect(result.stdout).toContain('native rollback cleanup complete; SDK exit approved:1')
  expect(result.stderr).toContain('SMITHERS_E2E_BRIDGE_PORT must be an integer from 1 through 65535.')
})
