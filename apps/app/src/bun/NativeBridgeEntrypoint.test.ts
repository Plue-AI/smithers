import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
// Erased by Bun; typechecks the isolated child without sharing its module mocks.
import type {} from '../../e2e/fixtures/unit-entrypoints/NativeBridge.child.test'

test.each([['visible'], ['hidden']] as const)('native bridge %s callbacks run in an isolated production-path process', (scenario) => {
  const child = fileURLToPath(new URL('../../e2e/fixtures/unit-entrypoints/NativeBridge.child.test.ts', import.meta.url))
  const result = spawnSync(process.execPath, ['test', child], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env,
      SMITHERS_CHAT_STUB: '',
      SMITHERS_LOCAL_HEADLESS: '',
      SMITHERS_E2E_BRIDGE: scenario === 'hidden' ? '1' : '',
      SMITHERS_NATIVE_E2E_VISIBLE: '',
      SMITHERS_API_ORIGIN: '',
      SMITHERS_API_TOKEN: '',
      SMITHERS_OPEN_URL: '',
      SMITHERS_NATIVE_BRIDGE_SCENARIO: scenario
    },
    encoding: 'utf8',
    timeout: 10_000
  })
  expect(result.error).toBeUndefined()
  if (result.status !== 0) throw new Error(`native bridge child failed:\n${result.stderr}`)
  expect(result.stderr).toContain('1 pass')
  expect(result.stderr).toContain('0 fail')
})
