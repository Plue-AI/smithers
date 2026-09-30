/** Private receipt projections of Plue's existing landing service. Browser safe. */
import { Schema } from "effect"
import { ChangeId, Resolved, SourcePublication } from "./native-schema.ts"

const CommitId = Resolved.fields.commitId
const PositiveId = Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
export const AppendPreparationInput = Schema.Struct({
  target_bookmark: Schema.Literal("main"),
  expected_commit_id: CommitId,
  source_commit_id: CommitId,
  source_base_commit_id: CommitId
})
export type AppendPreparationInput = typeof AppendPreparationInput.Type
export const AppendPreparation = Schema.Struct({
  ...AppendPreparationInput.fields,
  status: Schema.Literal("prepared"),
  changes: Schema.Array(Schema.Struct({ change_id: ChangeId, commit_id: CommitId })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(1024)
  )
})
export type AppendPreparation = typeof AppendPreparation.Type
export const LandingIdentity = Schema.Struct({ requestId: SourcePublication.fields.requestId, number: PositiveId })
export type LandingIdentity = typeof LandingIdentity.Type
export const AppendRequest = Schema.Struct({
  commit_id: CommitId,
  expected_commit_id: CommitId,
  source_base_commit_id: CommitId,
  description: Schema.NonEmptyString.check(Schema.isMaxLength(32_768))
})
export type AppendRequest = typeof AppendRequest.Type
export const QueuedAppend = Schema.Struct({
  ...LandingIdentity.fields,
  taskId: PositiveId,
  preparation: AppendPreparation,
  request: AppendRequest
})
export type QueuedAppend = typeof QueuedAppend.Type
// The durable append request pins the exact ordered commits (40-hex commit ids),
// not change ids: plue's validateLandingAppend requires the last entry to equal
// append.source_commit_id, and endpoint 4 returns that request verbatim.
const NativeAppendRequest = Schema.Struct({
  change_ids: Schema.Array(CommitId).check(Schema.isMinLength(1), Schema.isMaxLength(1024)),
  target_bookmark: Schema.Literal("main"),
  expected_commit_id: CommitId,
  operation_key: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  lookup_only: Schema.optionalKey(Schema.Literal(false)),
  append: Schema.Struct({
    source_commit_id: CommitId,
    source_base_commit_id: CommitId,
    description: AppendRequest.fields.description
  })
})
export const AppendObservation = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(["pending", "running", "failed"]),
    task_id: PositiveId,
    request: NativeAppendRequest,
    result: Schema.optionalKey(Schema.Never)
  }),
  Schema.Struct({
    status: Schema.Literal("landed"),
    task_id: PositiveId,
    request: NativeAppendRequest,
    result: Schema.Struct({
      landed_count: PositiveId,
      target_bookmark: Schema.Literal("main"),
      target_commit_id: CommitId
    })
  })
])
export type AppendObservation = typeof AppendObservation.Type
/** What the repository's declared GitHub policy does with a Change. */
export const Delivery = Schema.Literals(["append", "pull-request"])
export type Delivery = typeof Delivery.Type
/** GitHub's pull request for one landing, keyed by its smithers/landing-<n> head branch. */
export const GitHubPull = Schema.Struct({
  landing_number: PositiveId,
  repository: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)),
  number: PositiveId,
  url: Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/), Schema.isMaxLength(2048)),
  state: Schema.Literals(["open", "closed"]),
  merged: Schema.Boolean,
  head_ref: Schema.String.check(Schema.isMaxLength(255)),
  head_sha: CommitId,
  base_ref: Schema.Literal("main"),
  created: Schema.Boolean
})
export type GitHubPull = typeof GitHubPull.Type
/** The repository's mythical stack as `coding/vibe` needs it: only whether it is active. */
export const StackState = Schema.Struct({ state: Schema.Literals(["absent", "bootstrapping", "active", "frozen"]) })
/** A lane result handed to the stack service (PUT /mythical/lanes). */
export const LaneSubmission = Schema.Struct({
  workspaceId: Schema.String,
  base: CommitId,
  source: CommitId,
  requestRunId: Schema.NonEmptyString.check(Schema.isMaxLength(1024)),
  summary: Schema.NonEmptyString.check(Schema.isMaxLength(16_384))
})
export type LaneSubmission = typeof LaneSubmission.Type
/** The stack service's receipt: the item that now carries this candidate. */
export const LaneReceipt = Schema.Struct({
  itemId: Schema.NonEmptyString,
  state: Schema.NonEmptyString,
  source: CommitId
})
export type LaneReceipt = typeof LaneReceipt.Type
/**
 * Landing without the backend: `.smithers/coding-project.json` `landing`
 * selects it for a host that has no provisioned repository binding.
 */
export const LocalLander = Schema.Literals(["pull-request", "fast-forward"])
export type LocalLander = typeof LocalLander.Type
/** Which lander a vibe run delivers through; recorded once per run. */
export const Lander = Schema.Literals(["backend", ...LocalLander.literals])
export type Lander = typeof Lander.Type
/** The one candidate commit a local lander built: the cleaned tip merged onto main, with main as its sole parent. */
const LandingRevision = Schema.Struct({
  changeId: ChangeId,
  commitId: CommitId,
  treeId: CommitId,
  operationId: Schema.NonEmptyString,
  parentCommitIds: Schema.Array(CommitId)
})
export const LandingCandidate = Schema.Struct({
  lander: LocalLander,
  /** Main as the candidate was built on it. */
  main: LandingRevision,
  /** The candidate's commit message: the cleanup summary. */
  summary: Schema.NonEmptyString.check(Schema.isMaxLength(16_384)),
  candidate: LandingRevision
})
export type LandingCandidate = typeof LandingCandidate.Type
/** GitHub's pull request for a candidate, keyed by its `smithers/landing-<request>` head branch. */
export const LocalPull = Schema.Struct({
  number: PositiveId,
  url: Schema.String.check(Schema.isPattern(/^https:\/\/\S+$/), Schema.isMaxLength(2048)),
  state: Schema.Literals(["open", "closed", "merged"]),
  headRef: Schema.String.check(Schema.isMaxLength(255)),
  headSha: CommitId,
  baseRef: Schema.String.check(Schema.isMaxLength(255)),
  mergeCommitId: Schema.NullOr(CommitId)
})
export type LocalPull = typeof LocalPull.Type
/** One observation of a pull request's required checks (`gh pr checks --required`). */
export const PullChecks = Schema.Struct({
  status: Schema.Literals(["passed", "failed", "pending"]),
  checks: Schema.Array(Schema.Struct({ name: Schema.String, bucket: Schema.String })).check(Schema.isMaxLength(256))
})
export type PullChecks = typeof PullChecks.Type
/** GitHub merged the candidate, or keeps the pull request open and says why. */
export const MergeOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal("merged"), mainCommitId: CommitId }),
  Schema.Struct({ status: Schema.Literal("open"), reason: Schema.String.check(Schema.isMaxLength(2048)) })
])
export type MergeOutcome = typeof MergeOutcome.Type
