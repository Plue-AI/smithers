import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'bun:test'
// Erased at runtime: tsc checks the isolated fixtures without loading their Bun mocks here.
import type {} from '../../e2e/fixtures/unit-entrypoints/AppIsland.child.test'
import type {} from '../../e2e/fixtures/unit-entrypoints/Main.child.test'

const cases = [
  ['AppIsland orchestration', '../../e2e/fixtures/unit-entrypoints/AppIsland.child.test.tsx'],
  ['browser main render', '../../e2e/fixtures/unit-entrypoints/Main.child.test.tsx']
] as const

test.each(cases)('%s runs in an isolated Bun process', (_name, relative) => {
  const child = fileURLToPath(new URL(relative, import.meta.url))
  const result = spawnSync(process.execPath, ['test', child], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: process.env,
    encoding: 'utf8',
    timeout: 20_000
  })
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(0)
  expect(result.stderr).toContain('1 pass')
  expect(result.stderr).toContain('0 fail')
})
