import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { finalCheckWork, reviewChecks } from "../repository/changes.ts"
import { type CiPolicy, composeCiChecks, readCiPolicy } from "../repository/ci-policy.ts"
import type { Work } from "../repository/jobs.ts"

const repo = "example/repo", workspaceId = "11111111-1111-4111-a111-111111111111"
const registrationId = "33333333-3333-4333-a333-333333333333"
const inheritedAi = {
  id: "house-style",
  name: "House style",
  kind: "ai" as const,
  rule: "Follow the handbook",
  paths: [],
  policy: "required" as const
}
const localAi = {
  id: "scope-review",
  name: "Scope review",
  kind: "ai" as const,
  rule: "Stay in scope",
  paths: [],
  policy: "required" as const
}
const localCommand = {
  id: "unit",
  name: "Unit",
  kind: "command" as const,
  rule: "true",
  paths: [],
  policy: "required" as const
}
const pinned = () => {
  const setup = initialSetup(repo, "ci", "maintainer")
  setup.revision = 3
  setup.draft.checks = structuredClone([inheritedAi]) as typeof setup.draft.checks
  const digest = setupCandidate(setup), source = "a".repeat(40)
  const policy = readCiPolicy(repo, [{
    id: registrationId,
    repository_id: 3,
    workspace_id: workspaceId,
    user_id: 7,
    job: "ci",
    mode: "enabled",
    revision: setup.revision,
    digest,
    source_revision: source,
    flow_id: "repository-jobs/ci",
    enabled: true,
    configuration: {
      repo,
      workspace_id: workspaceId,
      flow_id: "repository-jobs/ci",
      revision: setup.revision,
      digest,
      source_revision: source,
      execution_digest: "f".repeat(64),
      mode: "enabled",
      input: setup.draft
    }
  }])
  if (policy.kind !== "pinned") throw new Error("expected a pinned policy")
  return policy
}
const workFor = (local: ReadonlyArray<typeof localAi | typeof localCommand>, policy: CiPolicy = pinned()) =>
  ({
    repo,
    job: "feature",
    step: { id: "feature", name: "Feature", mode: "manual", prompt: "Update code.txt" },
    event: { source: "smithers-cloud", type: "manual", action: "manual:feature", deliveryKey: "feature", payload: {} },
    evidence: {
      repo,
      source: {
        changeId: "k".repeat(32),
        commitId: "a1".repeat(20),
        treeId: "a2".repeat(20),
        operationId: "c3".repeat(64),
        parentCommitIds: []
      },
      files: [],
      missing: [],
      history: [],
      records: [],
      sources: []
    },
    deadlineAt: 4_000_000_000_000,
    checks: composeCiChecks(local, policy),
    landing: "checks",
    replies: "draft",
    executionMode: "live",
    policy
  }) as unknown as typeof Work.Type

test("an inherited required AI rule does not replace the proposal's own review", () => {
  const checks = reviewChecks(workFor([localCommand]))
  assert.equal(checks.length, 3)
  assert.ok(checks.some((check) => check.id === "implementation-review"), "the generic correctness review still runs")
})

test("a local required AI check replaces the proposal's own review", () => {
  const checks = reviewChecks(workFor([localCommand, localAi]))
  assert.deepEqual(checks.map((check) => check.id).filter((id) => id === "implementation-review"), [])
  assert.equal(checks.length, 3)
})

test("a job with no reviewed CI policy keeps the existing behaviour", () => {
  assert.ok(
    reviewChecks(workFor([localCommand], { kind: "none" })).some((check) => check.id === "implementation-review")
  )
  assert.equal(reviewChecks(workFor([localAi], { kind: "none" })).length, 1)
})

test("the producer and the receipt verifier share one final-check construction", () => {
  const work = workFor([localCommand])
  const head = {
    kind: "resolved" as const,
    changeId: "m".repeat(32),
    commitId: "b1".repeat(20),
    treeId: "b2".repeat(20),
    operationId: "c3".repeat(64),
    parentCommitIds: [work.evidence.source.commitId]
  }
  const produced = { head: head as unknown as typeof work.evidence.source, base: work.evidence.source.commitId }
  assert.deepEqual(finalCheckWork(work, produced), {
    ...work,
    evidence: { ...work.evidence, source: head },
    proposal: []
  })
  const source = readFileSync(fileURLToPath(new URL("../repository/changes.ts", import.meta.url)), "utf8")
  assert.match(
    source,
    /payload: \{ work: finalCheckWork\(prepared\.work, \{ head, base: prepared\.work\.evidence\.source\.commitId \}\) \}/,
    "FinishChange must send exactly the shared construction, never a rebuilt Work"
  )
})
