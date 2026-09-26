import assert from "node:assert/strict"
import { test } from "node:test"
import { initialSetup } from "../../packages/rpc/src/RepositorySetup.ts"
import { selectedSteps } from "../repository/execution.ts"
import type { JobInput } from "../repository/schema.ts"

const input = (job: JobInput["job"]): Pick<JobInput, "job" | "configuration" | "event"> => ({
  job,
  configuration: { ...initialSetup("example/repo", job, "owner").draft, cases: [] },
  event: {
    source: "smithers-cloud",
    type: "issues",
    action: "opened",
    deliveryKey: "trial",
    trial: true,
    payload: { issue: { title: "What greeting is exported?", body: "Inspect source" } }
  }
})

test("issue initialization never invokes deliberately manual fixes, POCs, or splitting", () => {
  const trial = input("issues")
  assert.deepEqual(selectedSteps(trial).map((step) => step.id), ["research", "duplicates", "reproduce"])
  assert.deepEqual(
    selectedSteps({ ...trial, event: { ...trial.event, type: "manual", action: "manual:fix", manualStep: "fix" } }).map(
      (step) => step.id
    ),
    ["fix"]
  )
  assert.deepEqual(
    selectedSteps({ ...trial, event: { ...trial.event, action: "manual:fix" } }).map((step) => step.id),
    ["research", "duplicates", "reproduce"]
  )
})

test("other setup trials select their one responsibility and still respect disabled steps", () => {
  for (
    const [job, expected] of [["review", "review"], ["ci", "checks"], ["feature", "feature"], [
      "chores",
      "chore"
    ]] as const
  ) {
    const trial = input(job)
    assert.deepEqual(selectedSteps(trial).map((step) => step.id), [expected])
    assert.deepEqual(
      selectedSteps({
        ...trial,
        configuration: {
          ...trial.configuration,
          steps: trial.configuration.steps.map((step) => ({ ...step, mode: "off" }))
        }
      }),
      []
    )
  }
  const feature = input("feature")
  assert.deepEqual(selectedSteps({ ...feature, event: { ...feature.event, trial: false } }), [])
})
