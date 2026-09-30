import { initialSetup, setupCandidate } from "@smthrs/rpc/RepositorySetup"
import type { RepositoryJob, RepositorySetup } from "@smthrs/rpc/RepositorySetup"
import { expect, test } from "bun:test"
import type { Card } from "./AppState"
import { registeredRepositoryJobs, repositoryJobState, repositoryJobStates } from "./RepositoryJobs"

/*
 * The canary's own census, verbatim (.artifacts/mvp-canary-walk-20260917/
 * W1-a-buttons-and-chat.json, W1-g-discard-and-retry.json), and the host
 * answers behind it (W1-00-state-issues.json, W1-00-state-feature.json):
 *
 *   23:22:41.531  state-issues   registrationActive {enabled:false, revision:4}   registrationState "known"
 *   23:22:42.113  state-feature  registrationActive {enabled:true,  revision:57}  registrationState "known"
 *   23:22:59.523  cardsAfterClear []
 *   23:22:59.522  L83-freshConversationJobButtons  "Handle issues" … "Build a feature"   (every label plain)
 *   23:24:34      cardsAfterOpen  ['issues']
 *   23:42:25.546  jobButtonsWithState  "Handle issues · Paused" … "Build a feature"
 *   23:42:52.300  featureCard     ['feature']   ← the feature card's first appearance
 *
 * Every registration the walk read was "known"; no receipt in it carries
 * "unknown" or "unavailable". What moved between the two button censuses was
 * the CARD: with none open no button read a state, and with the issues card
 * open only that button did. `repositoryJobStates` reads cards and nothing
 * else, because a registration reaches this app only through a setup card's
 * own recovery (controller/repositorySetup.ts `recover()`, GET
 * /api/repository-setup/state?repo&job, asked per job for a card that already
 * exists). Both tests below are that census, held in place.
 */
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

test("a job reads the state of the registration its own card recovered", () => {
  const issues = setup("issues", { enabled: false, revision: 4 })
  const feature = setup("feature", { enabled: true, revision: 57 })
  expect(repositoryJobState(issues)).toBe("Paused")
  expect(repositoryJobState(feature)).toBe("Enabled")
  expect(repositoryJobStates([card("issues", issues), card("feature", feature)], REPO, OWNER))
    .toEqual({ issues: "Paused", feature: "Enabled" })
})

/*
 * The defect W1 filed, held exactly as production produced it, because no
 * code in this app closes it: the button's state has no source but the card.
 * A fresh conversation holds no setup card at all (`cardsAfterClear []`), so
 * every job reads as its own name however its registration stands upstream;
 * with only the issues card open, only that button reads a state. When a job's
 * registrations reach the app without its card, this test is what changes.
 */
test("a job whose setup card is not open reads no state, whatever the host holds", () => {
  const issuesCard = card("issues", setup("issues", { enabled: false, revision: 4 }))
  expect(repositoryJobStates([], REPO, OWNER)).toEqual({})
  expect(repositoryJobStates([issuesCard], REPO, OWNER)).toEqual({ issues: "Paused" })
})

test("a registration nothing has answered for yet is still not a state", () => {
  const fresh = initialSetup(REPO, "review", OWNER)
  const pending = { ...fresh, recovery: { id: "rec-3", baseRevision: fresh.revision, baseDigest: setupCandidate(fresh), state: "requested" as const, registrationState: "unknown" as const } }
  expect(repositoryJobState(pending)).toBeUndefined()
  expect(repositoryJobStates([card("review", pending)], REPO, OWNER)).toEqual({})
})

test("only verified registrations count as completed repository jobs", () => {
  const failed = initialSetup(REPO, "review", OWNER)
  const inspectFailed = { ...failed, request: { id: "inspect", operation: "inspect" as const, revision: failed.revision,
    digest: setupCandidate(failed), state: "failed" as const, error: "invalid_receipt" } }
  const base = initialSetup(REPO, "issues", OWNER)
  const registered = { ...base, active: { revision: base.revision, digest: setupCandidate(base), registrationId: "reg-issues",
    sourceRevision: "c9785dea", enabled: false, owned: true } }
  expect([...registeredRepositoryJobs([card("review", inspectFailed), card("issues", registered)], REPO, OWNER)]).toEqual(["issues"])
  expect(registeredRepositoryJobs([card("issues", registered)], "other/repo", OWNER).size).toBe(0)
})
