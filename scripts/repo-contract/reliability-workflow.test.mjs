/**
 * The scheduled reliability workflow keeps its signal campaign reproducible.
 *
 * The `signal-state-machine` job in `.github/workflows/reliability.yml` must
 * record its rotating seed, preserve histories and results even on failure,
 * verify the evidence is complete, and prove mutation sensitivity.
 *
 * Run it with `node --test scripts/repo-contract/reliability-workflow.test.mjs`.
 */
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { it } from "node:test"

import { evaluateExpression, interpolate, parseWorkflow } from "../release-rehearsal.mjs"
import { repoRoot as root } from "../workspace-packages.mjs"

it("scheduled durable histories retain reproducible seeds and operation artifacts", () => {
  const workflow = parseWorkflow(readFileSync(join(root, ".github/workflows/reliability.yml"), "utf8"))
  assert.ok(workflow.on.schedule[0].cron)
  const job = workflow.jobs["signal-state-machine"]
  const steps = job.steps
  const campaign = steps.find((step) => step.name === "Run generated durable histories")
  assert.match(campaign.run, /@smthrs\/control exec vitest run test\/SignalInboxModel\.test\.ts/)
  assert.match(campaign.env.SMITHERS_FUZZ_ARTIFACT_DIR, /reliability-artifacts/)
  const seed = steps.find((step) => step.name === "Select and record reproducible campaign").run
  assert.match(seed, /SMITHERS_FUZZ_SEED=/)
  assert.match(seed, /SMITHERS_FUZZ_CASES=50/)
  assert.match(seed, /SMITHERS_FUZZ_STEPS=500/)
  const artifact = steps.find((step) => step.name === "Preserve history and seed evidence")
  assert.equal(artifact.if, "always()")
  assert.match(artifact.with.path, /reliability-results\.json/)
  assert.match(artifact.with.path, /reliability-artifacts/)
  assert.equal(artifact.with["if-no-files-found"], "error")
  assert.match(steps.find((step) => step.name === "Verify complete campaign evidence").run, /check-signal-campaign\.mjs reliability-artifacts/)
  assert.match(steps.find((step) => step.name === "Prove signal transition mutation sensitivity").run, /check-signal-mutations\.mjs/)
  assert.notEqual(job["continue-on-error"], true)
})

it("scheduled run lifecycle histories retain the rotating seed and shrunk case", () => {
  const workflow = parseWorkflow(readFileSync(join(root, ".github/workflows/reliability.yml"), "utf8"))
  const job = workflow.jobs["run-lifecycle-state-model"]
  const steps = job.steps
  const seed = steps.find((step) => step.name === "Select and record reproducible campaign")
  assert.match(seed.env.REQUESTED_SEED, /inputs\.seed/)
  assert.match(seed.run, /SMITHERS_FUZZ_SEED=/)
  assert.match(seed.run, /SMITHERS_FUZZ_CASES=\d+/)
  assert.match(seed.run, /SMITHERS_FUZZ_STEPS=\d+/)
  const campaign = steps.find((step) => step.name === "Run generated run lifecycle histories")
  assert.match(campaign.run, /@smthrs\/engine-store exec vitest run test\/RunLifecycleModel\.test\.ts/)
  assert.match(campaign.env.SMITHERS_FUZZ_ARTIFACT_DIR, /reliability-artifacts/)
  assert.match(steps.find((step) => step.name === "Verify campaign evidence").run, /run-lifecycle-\$\{seed\}\.json/)
  const artifact = steps.find((step) => step.name === "Preserve seed and shrunk case")
  assert.equal(artifact.if, "always()")
  assert.match(artifact.with.path, /reliability-artifacts/)
  assert.equal(artifact.with["if-no-files-found"], "error")
  assert.notEqual(job["continue-on-error"], true)
})

it('durability runs nightly and reference execution refuses before branch tools', () => {
  const workflow = parseWorkflow(readFileSync(join(root, '.github/workflows/reliability.yml'), 'utf8'))
  const job = workflow.jobs['e2e-faults']
  assert.deepEqual(faultHosts(job, {}), ['linux', 'reference'])
  assert.equal(job.strategy['fail-fast'], false)
  const refusal = job.steps.findIndex((step) => step.name === 'Refuse unapproved reference-host execution')
  const build = job.steps.findIndex((step) => step.name === 'Install native smithers-jj-export')
  assert.ok(refusal >= 0 && refusal < build)
  assert.match(job.steps[refusal].run, /C-SEC-02/)
  assert.match(job.steps[refusal].run, /approved main-bundle provenance/)
  const suite = job.steps.find((step) => step.name === 'Exclusive fault matrix')
  assert.match(suite.run, /--jobs 1/)
  // The release tier and the long tier run nightly side by side; the long tier
  // has its own budget, the hosted runner's six-hour ceiling (#3459).
  assert.deepEqual(job.strategy.matrix.tier, ['release', 'long'])
  assert.match(suite.if, /matrix\.tier == 'release'/)
  const longTier = job.steps.find((step) => step.name === 'Long fault tier')
  assert.equal(longTier.run, `pnpm exec smthrs test '//packages/smithers:faultsLong' --jobs 1 --results-file "$RUNNER_TEMP/smthrs-results/$GITHUB_ACTION.json" --verbose`)
  assert.match(longTier.if, /matrix\.tier == 'long'/)
  assert.equal(job['timeout-minutes'], "${{ matrix.tier == 'long' && 360 || 60 }}")
  // The runner passes a case only the host bootstrap environment, so the fault
  // targets declare the PostgreSQL service and URL, the host class and the
  // programs they build; a value the workflow set never reached a case.
  assert.equal(job.services, undefined)
  assert.equal(job.env, undefined)
  assert.equal(suite.env?.SMITHERS_TEST_DATABASE_URL, undefined)
  assert.doesNotMatch(JSON.stringify(job), /SMITHERS_FAULT_POSTGRES_BIN|postgresql-18\.0\.tar/)
  const faults = readFileSync(join(root, 'packages/smithers/PACKAGE.ts'), 'utf8')
  assert.match(faults, /services: \[faultPostgresDatabase\]/)
  assert.match(faults, /SMITHERS_TEST_DATABASE_URL: "postgres:\/\/smithers:smithers-fault-test@127\.0\.0\.1:55439\//)
  assert.match(faults, /SMITHERS_FAULT_HOST: "linux"/)
  assert.match(faults, /SMITHERS_FAULT_POSTGRES_BIN: "\.artifacts\/fault-postgres\/bin"/)
  assert.doesNotMatch(suite.run, /known-red/)
  assert.doesNotMatch(longTier.run, /known-red/)
  assert.doesNotMatch(JSON.stringify(job), /secrets\./)
  const ci = parseWorkflow(readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8'))
  assert.equal(ci.jobs['e2e-faults'], undefined)
})

// Reuse the rehearsal's GitHub expression evaluator; the runner's fromJSON
// converts its selected literal into the matrix array.
function faultHosts(job, inputs) {
  const expression = job.strategy.matrix.host.match(/^\$\{\{ fromJSON\((.*)\) \}\}$/)
  assert.ok(expression, "fault host selection must use fromJSON")
  return JSON.parse(evaluateExpression(expression[1], { inputs }))
}

it("manual Linux faults run only the existing fault job and keep nightly campaigns", () => {
  const workflow = parseWorkflow(readFileSync(join(root, ".github/workflows/reliability.yml"), "utf8"))
  const choice = workflow.on.workflow_dispatch.inputs.campaign
  assert.equal(choice.type, "choice")
  assert.equal(choice.default, "all")
  assert.deepEqual(choice.options, ["all", "faults-linux"])
  const allJobs = ["benchmark-observations", "sync-long-soak", "signal-state-machine",
    "run-lifecycle-state-model", "jj-native-wasm-abi", "e2e-faults"]
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [...allJobs].sort())
  for (const [inputs, expectedJobs, expectedHosts] of [
    [{}, allJobs, ["linux", "reference"]],
    [{ campaign: "all" }, allJobs, ["linux", "reference"]],
    [{ campaign: "faults-linux" }, ["e2e-faults"], ["linux"]]
  ]) {
    const selected = Object.entries(workflow.jobs).filter(([, job]) => {
      if (!job.if) return true
      const expression = job.if.match(/^\$\{\{ (.*) \}\}$/)
      assert.ok(expression)
      return evaluateExpression(expression[1], { inputs })
    }).map(([name]) => name)
    assert.deepEqual(selected.sort(), [...expectedJobs].sort())
    assert.deepEqual(faultHosts(workflow.jobs["e2e-faults"], inputs), expectedHosts)
  }
  const group = (inputs) => interpolate(workflow.concurrency.group, { github: { ref: "refs/heads/main" }, inputs })
  assert.equal(group({}), group({ campaign: "all" }))
  assert.notEqual(group({ campaign: "faults-linux" }), group({}))
  assert.equal(workflow.concurrency["cancel-in-progress"], false)
  assert.equal(workflow.permissions.contents, "read")
  assert.notEqual(workflow.jobs["e2e-faults"]["continue-on-error"], true)
})
