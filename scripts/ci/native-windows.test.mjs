import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import YAML from 'yaml'

const portableSuites = [
  {
    name: 'Test complete sandbox and flow package suites',
    commands: [
      '--dir packages/smithers/flows/sandbox exec vitest run --coverage.reportOnFailure --coverage.reportsDirectory "$RUNNER_TEMP/portable-package-coverage/sandbox"',
      '--dir packages/smithers/flows exec vitest run --coverage.reportOnFailure --coverage.reportsDirectory "$RUNNER_TEMP/portable-package-coverage/flows"'
    ]
  },
  {
    name: 'Test remaining Windows package suites',
    commands: [
      '--dir packages/smithers/build/infra exec vitest run --coverage.reportOnFailure --coverage.reportsDirectory "$RUNNER_TEMP/portable-package-coverage/infra"',
      '--dir packages/testing exec vitest run --coverage.reportOnFailure --coverage.reportsDirectory "$RUNNER_TEMP/portable-package-coverage/testing"',
      '--dir packages/smithers/mcp exec vitest run --coverage.reportOnFailure --coverage.reportsDirectory "$RUNNER_TEMP/portable-package-coverage/mcp"',
      '--dir packages/smithers/flows/platform-bun exec vitest run --coverage.reportOnFailure --coverage.reportsDirectory "$RUNNER_TEMP/portable-package-coverage/platform-bun"',
      '--dir packages/smithers/flows/platform-bun exec bun scripts/run-bun-tests.mjs',
      '--dir packages/smithers/ui exec bun test tests'
    ]
  }
]

async function filesystemSteps() {
  const workflow = YAML.parse(await readFile(new URL('../../.github/workflows/native-windows.yml', import.meta.url), 'utf8'))
  return workflow.jobs.filesystem.steps
}

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

test('opt-in portable Windows suites collect results after the Node host suite fails', async () => {
  const steps = await filesystemSteps()
  const nodeHostIndex = steps.findIndex((step) => step.name === 'Test the complete Node host suite')
  assert.ok(nodeHostIndex >= 0)
  const helperIndex = steps.findIndex((step) => step.name === 'Expose the built Windows helper')
  assert.ok(helperIndex >= 0 && helperIndex < nodeHostIndex, 'helper setup precedes all package suites')
  assert.equal(steps[helperIndex].id, 'atomic_helper', 'portable suite guard identifies a successful helper setup')
  const bunSetupIndex = steps.findIndex((step) => step.name === 'Install Bun for portable package suites')
  for (const name of ['Install Bun for portable package suites', ...portableSuites.map((suite) => suite.name)]) {
    const index = steps.findIndex((step) => step.name === name)
    assert.ok(index > nodeHostIndex, `${name} follows the Node host suite`)
    if (name !== 'Install Bun for portable package suites') assert.ok(index > bunSetupIndex, `${name} follows Bun setup`)
    assert.equal(steps[index].if, "inputs.portablePackages == true && !cancelled() && steps.atomic_helper.outcome == 'success'", `${name} runs after a Node host failure with dependencies ready, honors opt-in, and stops on cancellation`)
  }
  const artifactIndex = steps.findIndex((step) => step.name === 'Preserve portable package coverage diagnostics')
  assert.ok(artifactIndex > Math.max(...portableSuites.map((suite) => steps.findIndex((step) => step.name === suite.name))), 'diagnostics upload follows every package suite')
  assert.equal(steps[artifactIndex].if, 'always() && inputs.portablePackages == true', 'failed suites still upload diagnostics')
})

for (const suite of portableSuites) {
  test(`${suite.name} runs every complete suite and retains each failure`, async () => {
    const step = (await filesystemSteps()).find((step) => step.name === suite.name)
    assert.ok(step, `${suite.name} is present`)
    assert.equal(step.shell, 'bash')
    for (const command of suite.commands) assert.ok(step.run.includes(`pnpm ${command}`), `full suite command: ${command}`)
    assert.ok(!step.run.includes('--coverage.enabled=false'), 'Node coverage remains enabled')

    // Exercise the actual shell block. The command probe records every argv and
    // fails one selected suite; later suites must still execute before exit 1.
    const runnerTemp = '/windows-suite-probe'
    const expected = suite.commands.map((command) => command.replaceAll('"', '').replaceAll('$RUNNER_TEMP', runnerTemp))
    for (const failedCommand of ['', ...expected]) {
      const result = spawnSync('bash', ['-eo', 'pipefail', '-c', `
pnpm() {
  printf '%s\\n' "$*"
  [ "$*" != "$FAILED_COMMAND" ]
}
${step.run}`], {
        encoding: 'utf8',
        env: { ...process.env, RUNNER_TEMP: runnerTemp, FAILED_COMMAND: failedCommand },
        timeout: 5000
      })
      assert.ifError(result.error)
      assert.equal(result.signal, null)
      assert.deepEqual(result.stdout.trim().split('\n'), expected, `all suites execute when ${failedCommand || 'none'} fails`)
      assert.equal(result.status, failedCommand === '' ? 0 : 1, result.stderr)
    }
  })
}
