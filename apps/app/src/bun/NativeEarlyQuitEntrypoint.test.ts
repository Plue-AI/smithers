import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
// Erased import includes the isolated, target-keyed fixture in app typecheck.
import type {} from '../../e2e/fixtures/unit-entrypoints/NativeEarlyQuit.child'

const child = fileURLToPath(new URL('../../e2e/fixtures/unit-entrypoints/NativeEarlyQuit.child.ts', import.meta.url))

test.each([['pending-readiness', 0], ['renderer-start-error', 1], ['readiness-rejection', 1], ['pending-renderer-start-error', 1]] as const)(
  'native early quit %s waits for owned lease cleanup', (scenario, code) => {
  const result = spawnSync(process.execPath, ['run', child], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env,
      SMITHERS_NATIVE_EARLY_QUIT_SCENARIO: scenario,
      SMITHERS_CHAT_STUB: '', SMITHERS_LOCAL_HEADLESS: '',
      SMITHERS_API_ORIGIN: '', SMITHERS_API_TOKEN: '', SMITHERS_OPEN_URL: '',
      SMITHERS_E2E_BRIDGE: '', SMITHERS_NATIVE_E2E_VISIBLE: ''
    },
    encoding: 'utf8', timeout: 3_000, killSignal: 'SIGKILL'
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(code)
  expect(result.signal).toBeNull()
  const lines = result.stdout.split('\n').filter((entry) => entry.startsWith('native early quit cleanup complete:'))
  expect(lines).toHaveLength(1)
  expect(result.stdout).not.toContain('duplicate SDK-approved quit:')
  const receipt = JSON.parse(lines[0]!.slice('native early quit cleanup complete:'.length))
  expect(receipt.code).toBe(code)
  expect(receipt.approvedQuitCodes).toEqual([code])
  expect(receipt.quitVetoes).toBe(2)
  expect(receipt.resources.backend).toEqual({ started: 1, stopped: 1 })
  for (const name of ['renderer', 'bridge']) {
    expect([0, 1]).toContain(receipt.resources[name].started)
    expect(receipt.resources[name].stopped).toBe(receipt.resources[name].started)
  }
  // Normal SDK exit owns window lifetime; no new close policy is required.
  expect([0, 1]).toContain(receipt.windowsOpened)
  if (scenario === 'renderer-start-error' || scenario === 'pending-renderer-start-error') expect(result.stderr).toContain('renderer acquisition failed')
  if (scenario === 'readiness-rejection') expect(result.stderr).toContain('owned backend readiness failed')
})
