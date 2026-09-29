import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import YAML from 'yaml'

test('Windows kernel suite runs independently of native and Node host failures', async () => {
  const workflow = YAML.parse(await readFile(new URL('../../.github/workflows/native-windows.yml', import.meta.url), 'utf8'))
  for (const event of ['push', 'pull_request']) {
    assert.ok(workflow.on[event].paths.includes('packages/smithers/flows/kernel/**'))
  }

  const kernel = workflow.jobs.kernel
  assert.equal(kernel['runs-on'], 'windows-latest')
  assert.ok(!kernel.needs, 'kernel result must not depend on the filesystem job')
  const steps = kernel.steps
  assert.ok(steps.some((step) => step.uses?.startsWith('actions/checkout@')))
  assert.ok(steps.some((step) => step.uses?.startsWith('actions/setup-node@')))
  assert.ok(steps.some((step) => step.uses?.startsWith('pnpm/action-setup@')))
  assert.ok(steps.some((step) => step.run === 'pnpm install --frozen-lockfile --ignore-scripts'))
  assert.ok(steps.some((step) => step.run === 'pnpm --dir packages/smithers/flows/kernel exec vitest run'))
})
