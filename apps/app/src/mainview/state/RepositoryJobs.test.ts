import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import type { RepositoryJob, RepositorySetup } from "@smthrs/rpc/RepositorySetup"
import { expect, test } from "bun:test"
import type { Card, RepositoryJobObservation } from "./AppState"
import { registeredRepositoryJobs, repositoryJobState, repositoryJobStates } from "./RepositoryJobs"

const REPO = "codeplanesmithers/canary-sandbox"
const OWNER = "codeplanesmithers"

const setup = (job: RepositoryJob, active: { readonly enabled: boolean; readonly revision: number }): RepositorySetup => {
  const payload = initialSetup(REPO, job, OWNER)
  const digest = setupCandidate(payload)
  const state: RepositorySetup = {
    ...payload,
    revision: active.revision,
    active: { revision: active.revision, digest, registrationId: `reg-${job}`, sourceRevision: "c9785dea", enabled: active.enabled, owned: true }
  }
  return { ...state, recovery: { id: `rec-${job}`, baseRevision: state.revision, baseDigest: setupCandidate(state), state: "completed", registrationState: "known" } }
}

const card = (job: RepositoryJob, payload: RepositorySetup): Card => ({
  id: `setup:${OWNER}:${encodeURIComponent(REPO)}:${job}`, kind: "repository-setup", title: job,
  status: "active", createdAt: 1, ordinal: 1, payload
})

const observed = (job: RepositoryJob, payload: RepositorySetup): RepositoryJobObservation => ({
  id: job, owner: OWNER, repo: REPO, job, selectedWorkspaceId: null, state: "completed",
  registration: { state: "known", ...(payload.active === undefined ? {} : { active: {
    ...payload.active, owned: true, workspaceId: "de29f26b-e593-4ec2-99fc-583d4711f20a", draft: payload.draft
  } }) }
})

test("verified registrations label a fresh conversation without setup cards", () => {
  const issues = setup("issues", { enabled: false, revision: 4 })
  const feature = setup("feature", { enabled: true, revision: 57 })
  expect(repositoryJobState(issues)).toBe("Paused")
  expect(repositoryJobState(feature)).toBe("Enabled")
  expect(repositoryJobStates([observed("issues", issues), observed("feature", feature)], [], REPO, OWNER))
    .toEqual({ issues: "Paused", feature: "Enabled" })
})

test("cards alone cannot claim current registration state", () => {
  const issuesCard = card("issues", setup("issues", { enabled: false, revision: 4 }))
  expect(repositoryJobStates([], [issuesCard], REPO, OWNER)).toEqual({})
})

test("pending and failed observations do not imply Off", () => {
  const row = observed("review", initialSetup(REPO, "review", OWNER))
  expect(repositoryJobStates([{ ...row, state: "requested" }], [], REPO, OWNER)).toEqual({})
  expect(repositoryJobStates([{ ...row, state: "failed", error: "Unavailable" }], [], REPO, OWNER)).toEqual({})
  expect(repositoryJobStates([row], [], REPO, OWNER)).toEqual({ review: "Off" })
})

test("only verified registrations count as completed repository jobs", () => {
  const failed = initialSetup(REPO, "review", OWNER)
  const inspectFailed = { ...failed, request: { id: "inspect", operation: "inspect" as const, revision: failed.revision,
    digest: setupCandidate(failed), state: "failed" as const, error: "invalid_receipt" } }
  const base = initialSetup(REPO, "issues", OWNER)
  const registered = { ...base, active: { revision: base.revision, digest: setupCandidate(base), registrationId: "reg-issues",
    sourceRevision: "c9785dea", enabled: false, owned: true } }
  const observations = [observed("review", inspectFailed), observed("issues", registered)]
  expect([...registeredRepositoryJobs(observations, REPO, OWNER)]).toEqual(["issues"])
  expect(registeredRepositoryJobs(observations, "other/repo", OWNER).size).toBe(0)
  expect(registeredRepositoryJobs(observations, undefined, OWNER).size).toBe(0)
  expect(registeredRepositoryJobs(observations, REPO, null).size).toBe(0)
  const issues = observations[1]!
  const active = issues.registration?.state === "known" ? issues.registration.active : undefined
  if (active === undefined) throw new Error("The issues fixture must carry an active registration")
  const withActive = (patch: Partial<typeof active>): RepositoryJobObservation =>
    ({ ...issues, registration: { state: "known", active: { ...active, ...patch } } })
  expect(registeredRepositoryJobs([withActive({ owned: false })], REPO, OWNER).size).toBe(0)
  expect(registeredRepositoryJobs([withActive({ digest: "0".repeat(64) })], REPO, OWNER).size).toBe(0)
  expect([...registeredRepositoryJobs([withActive({ enabled: false })], REPO, OWNER)]).toEqual(["issues"])
  // A card draft alone never completes setup.
  expect(registeredRepositoryJobs([], REPO, OWNER).size).toBe(0)
})
