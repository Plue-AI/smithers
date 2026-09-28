import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
// Erased by Bun, but keeps the isolated fixture inside the app's typecheck.
import type {} from '../../e2e/fixtures/unit-entrypoints/Serve.child.test'

const cases = [['signal'], ['backend-failure'], ['stop-error'], ['missing-origin'], ['plue-origin']] as const
const child = fileURLToPath(new URL('../../e2e/fixtures/unit-entrypoints/Serve.child.test.ts', import.meta.url))

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
