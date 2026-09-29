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

import { parseWorkflow } from "../release-rehearsal.mjs"
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
