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
