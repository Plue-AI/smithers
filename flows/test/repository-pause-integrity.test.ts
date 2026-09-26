import { Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { initialSetup, setupCandidate } from "../../packages/rpc/src/RepositorySetup.ts"
import { activeRegistration, pausedRegistration, restartedRegistration } from "../repository/activation.ts"
import { SetupInput } from "../repository/schema.ts"

/** The production shape of defect D-7: one pause on the enabled `feature` job
 * whose local draft had reached revision 11 while the active registration
 * stayed at revision 6 (`.artifacts/mvp-canary-walk-20260917/D-14-state-feature.json`,
 * registration 259ef97c-e71b-4735-acaa-6c0b4363b748). */
const registrationId = "259ef97c-e71b-4735-acaa-6c0b4363b748"
const sourceRevision = "c2556c7da43868894aa8368a01d7d1ce2c736d0f"
const applied = () => ({ ...initialSetup("codeplanesmithers/canary-sandbox", "feature", "maintainer"), revision: 6 })
const appliedDigest = setupCandidate(applied())
const row = (over: Record<string, unknown> = {}) => ({
  id: registrationId,
  repository_id: 3,
  job: "feature",
  mode: "enabled",
  revision: 6,
  digest: appliedDigest,
  source_revision: sourceRevision,
  flow_id: "repository-jobs/feature",
  enabled: true,
  ...over
})
const request = (operation: "pause" | "apply", revision: number, draft = applied().draft) =>
  Schema.decodeUnknownSync(SetupInput)({
    requestId: "81ea64a9-e469-45e2-a59f-732555e83fa9",
    repo: "codeplanesmithers/canary-sandbox",
    job: "feature",
    operation,
    revision,
    digest: setupCandidate({ repo: "codeplanesmithers/canary-sandbox", job: "feature", revision, draft }),
    draft
  })

test("the pause receipt reads the job's own active registration, not the revision the request carried", () => {
  const input = request("pause", 11)
  const listed = [
    row({ job: "issues", id: "issues-row" }),
    row({ mode: "trial", id: "trial-row", revision: 11 }),
    row()
  ]
  assert.equal(activeRegistration(listed, input)?.id, registrationId)
  assert.equal(pausedRegistration(listed, input), undefined, "a live registration is not a paused receipt")
  const answered = listed.map((value) => ({ ...value, enabled: false }))
  assert.equal(pausedRegistration(answered, input)?.id, registrationId)
  assert.equal(pausedRegistration(answered, input)?.revision, 6)
  assert.equal(activeRegistration(answered, input), undefined, "an already paused job has nothing to pause")
})

test("a pause with nothing enabled refuses before the registry is written", () => {
  const input = request("pause", 11)
  for (const listed of [[], [row({ job: "chores" })], [row({ mode: "trial" })], [row({ enabled: false })]]) {
    assert.equal(activeRegistration(listed, input), undefined)
  }
  assert.equal(activeRegistration({ items: [row()] }, input)?.id, registrationId)
})

test("a paused registration is restarted by the next revision of the same reviewed draft", () => {
  const paused = row({ enabled: false })
  const restart = restartedRegistration([paused], request("apply", 7))
  assert.equal(restart?.revision, 6)
  assert.equal(restart?.digest, appliedDigest)
  assert.equal(restart?.source_revision, sourceRevision)
  assert.equal(restartedRegistration([row()], request("apply", 7)), undefined, "a live registration is not restarted")
  assert.equal(
    restartedRegistration([paused], request("apply", 6)),
    undefined,
    "Cloud re-enables only a newer revision"
  )
  const edited = applied().draft
  edited.budgetMinutes = 20
  assert.equal(
    restartedRegistration([paused], request("apply", 7, edited)),
    undefined,
    "an edited draft is a replacement, not a restart"
  )
})

/** R96 B1: a row paused before the trial's own test request left the candidate
 * carries the digest that hashed it, so the restart path reaches the real rows
 * that exist today and not only rows this build registered. */
const registeredDigest = "7d58fb03b7f0ed28a6ba637caacb19617776ea94925eea34b1a495887a2df04b"

test("a registration paused before the trial's test request left the candidate still restarts", () => {
  const paused = row({ enabled: false, digest: registeredDigest })
  assert.notEqual(appliedDigest, registeredDigest, "this build computes the other identity")
  const restart = restartedRegistration([paused], request("apply", 7))
  assert.equal(restart?.digest, registeredDigest)
  assert.equal(restart?.revision, 6)
  const edited = applied().draft
  edited.budgetMinutes = 20
  assert.equal(
    restartedRegistration([paused], request("apply", 7, edited)),
    undefined,
    "an edited draft is still a replacement"
  )
})
