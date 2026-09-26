import assert from "node:assert/strict"
import { test } from "node:test"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { normalEvents } from "../repository/activation.ts"
import { sourceEvent } from "../repository/events.ts"
import { selectedSteps } from "../repository/execution.ts"
import type { Event } from "../repository/schema.ts"

const push: typeof Event.Type = {
  source: "github",
  type: "push",
  action: "",
  deliveryKey: "github:verified-body-digest",
  issueNumber: 0,
  payload: {
    ref: "refs/heads/main",
    before: "a".repeat(40),
    after: "b".repeat(40),
    created: false,
    deleted: false,
    forced: false,
    repository: { id: 42, full_name: "original/source" },
    sender: { login: "maintainer" },
    commits: []
  }
}
test("signed GitHub push envelopes retain before/after and match a registration without invented actions", () => {
  const setup = initialSetup("local/mirror", "ci", "maintainer")
  const input = {
    requestId: "setup",
    operation: "apply" as const,
    repo: setup.repo,
    job: setup.job,
    revision: setup.revision,
    digest: setupCandidate(setup),
    draft: { ...setup.draft, cases: [] }
  }
  assert.deepEqual(normalEvents(input).find((rule) => rule.type === "push"), { type: "push", actions: [] })
  const normalized = sourceEvent(push)
  assert.equal(normalized.sourceRevision, "b".repeat(40))
  assert.equal((normalized.payload as any).baseCommitId, "a".repeat(40))
  assert.equal((normalized.payload as any).candidateCommitId, "b".repeat(40))
  assert.deepEqual((normalized.payload as any).repository, (push.payload as any).repository)
})
test("new refs compare against the empty root and deleted refs do not launch checks", () => {
  const payload = push.payload as Record<string, any>, setup = initialSetup("local/mirror", "ci", "maintainer")
  const created = sourceEvent({ ...push, payload: { ...payload, before: "0".repeat(40), created: true } })
  assert.equal((created.payload as any).baseCommitId, "0".repeat(40))
  const deleted = { ...push, payload: { ...payload, after: "0".repeat(40), deleted: true } }
  assert.equal(sourceEvent(deleted).ignored, true)
  assert.deepEqual(selectedSteps({ job: "ci", configuration: { ...setup.draft, cases: [] }, event: deleted }), [])
  for (const bad of [{ after: "main" }, { before: "0".repeat(40) }, { after: "0".repeat(40) }, { ref: "../../main" }]) {
    assert.throws(() => sourceEvent({ ...push, payload: { ...payload, ...bad } }))
  }
})
