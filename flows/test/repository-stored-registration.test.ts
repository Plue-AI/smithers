import { Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { JobInput, SetupInput } from "../repository/schema.ts"

/*
 * R96 B1: taking the trial's own test request out of the candidate moves the
 * digest of every draft ever stored, and a registry row keeps the digest it was
 * registered with. Plue dispatches a job straight from that row —
 * `internal/services/repository_jobs_worker.go`, `"digest": reg.Digest,
 * "configuration": config.Input` — and never recomputes it, so a registration
 * enabled before this build either decodes here or stops running its jobs.
 */
const repo = "codeplanesmithers/canary-sandbox", job = "feature"
const sourceRevision = "c2556c7da43868894aa8368a01d7d1ce2c736d0f"
// The digest the build before this change computed for the canary's `feature`
// draft at revision 6: the identity its enabled registration still carries.
const registeredDigest = "7d58fb03b7f0ed28a6ba637caacb19617776ea94925eea34b1a495887a2df04b"
const registered = () => ({ ...initialSetup(repo, job, "maintainer"), revision: 6 })
const event = {
  source: "github",
  type: "issues",
  action: "opened",
  deliveryKey: "delivery-1",
  issueNumber: 7,
  payload: { issue: { number: 7, title: "Add the greeting", body: "Append one line" } }
}
const dispatched = (over: Record<string, unknown> = {}) => {
  const setup = registered()
  return {
    repo,
    job,
    revision: setup.revision,
    digest: registeredDigest,
    sourceRevision,
    configuration: setup.draft,
    event,
    ...over
  }
}

test("a job registered before the trial's test request left the candidate still dispatches", () => {
  const input = Schema.decodeUnknownSync(JobInput)(dispatched())
  assert.equal(input.digest, registeredDigest)
  assert.notEqual(setupCandidate(registered()), registeredDigest, "this build computes the other identity")
  assert.doesNotThrow(() => Schema.decodeUnknownSync(JobInput)(dispatched({ digest: setupCandidate(registered()) })))
})

test("a registration dispatching another configuration or another revision is still refused", () => {
  const setup = registered()
  for (
    const over of [
      { configuration: { ...setup.draft, budgetMinutes: 20 } },
      { configuration: { ...setup.draft, trialTitle: "Another test issue" } },
      { revision: 7 },
      { digest: "0".repeat(64) }
    ]
  ) {
    assert.throws(
      () => Schema.decodeUnknownSync(JobInput)(dispatched(over)),
      /The job candidate changed/,
      JSON.stringify(over)
    )
  }
})

test("a setup operation stored before the trial's test request left the candidate still decodes", () => {
  const setup = registered()
  const input = Schema.decodeUnknownSync(SetupInput)({
    requestId: "stored-request",
    repo,
    job,
    operation: "apply",
    revision: setup.revision,
    digest: registeredDigest,
    draft: setup.draft
  })
  assert.equal(input.digest, registeredDigest)
  assert.throws(
    () =>
      Schema.decodeUnknownSync(SetupInput)({
        requestId: "stored-request",
        repo,
        job,
        operation: "apply",
        revision: setup.revision,
        digest: registeredDigest,
        draft: { ...setup.draft, budgetMinutes: 20 }
      }),
    /Invalid setup input or candidate digest/
  )
})
