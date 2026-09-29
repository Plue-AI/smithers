/** Private native receipt contracts shared by the Effect adapter and browser projections. */
import * as Fault from "@smthrs/flow/Fault"
import { Schema } from "effect"

export const ChangeId = Schema.String.check(Schema.isPattern(/^[k-z]{32}$/))
const CommitId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/))
const OperationId = Schema.String.check(Schema.isPattern(/^[0-9a-f]{128}$/))
const RequestId = Schema.String.check(
  Schema.isPattern(
    /^(?!00000000-0000-0000-0000-000000000000$)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
  )
)
const revisionFields = {
  changeId: ChangeId,
  commitId: CommitId,
  operationId: OperationId,
  parentCommitIds: Schema.Array(CommitId),
  description: Schema.optionalKey(Schema.String),
  empty: Schema.optionalKey(Schema.Boolean)
}
export const Resolved = Schema.Struct({ ...revisionFields, kind: Schema.Literal("resolved"), treeId: CommitId })
export const Conflicted = Schema.Struct({
  ...revisionFields,
  kind: Schema.Literal("conflicted"),
  treeTerms: Schema.Array(Schema.Struct({ treeId: CommitId, positive: Schema.Boolean }))
})
export const NativeRevision = Schema.Union([Resolved, Conflicted])
export type NativeRevision = typeof NativeRevision.Type
const expected = {
  requestId: RequestId,
  expectedOperationId: OperationId,
  target: Schema.Struct({ ...revisionFields, kind: Schema.optionalKey(Schema.Literal("resolved")), treeId: CommitId })
}
const Expected = Schema.Struct(expected.target.fields)
export const Operation = Schema.Union([
  Schema.Struct({ ...expected, operation: Schema.Literal("create"), description: Schema.String }),
  Schema.Struct({ ...expected, operation: Schema.Literal("describe"), description: Schema.String }),
  Schema.Struct({ ...expected, operation: Schema.Literal("snapshot") }),
  Schema.Struct({ ...expected, operation: Schema.Literal("edit") }),
  Schema.Struct({
    ...expected,
    operation: Schema.Literal("apply_files"),
    files: Schema.Array(Schema.Struct({
      path: Schema.NonEmptyString.check(Schema.isMaxLength(1000)),
      beforeDigest: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
      content: Schema.NullOr(Schema.String.check(Schema.isMaxLength(65536)))
    })).check(Schema.isMinLength(1), Schema.isMaxLength(30))
  }),
  Schema.Struct({ ...expected, operation: Schema.Literal("amend"), source: Expected }),
  Schema.Struct({ ...expected, operation: Schema.Literal("reorder"), after: Expected })
])
export type Operation = typeof Operation.Type
export const ReadResult = Schema.Struct({
  status: Schema.Literal("read"),
  operationId: OperationId,
  head: NativeRevision,
  revisions: Schema.Array(NativeRevision),
  capabilities: Schema.optionalKey(Schema.Array(Schema.String)),
  history: Schema.optionalKey(Schema.Array(NativeRevision)),
  historyComplete: Schema.optionalKey(Schema.Boolean)
})
const sourceIdentity = Schema.Struct({
  changeId: ChangeId,
  commitId: CommitId,
  treeId: CommitId,
  parentCommitIds: Schema.Array(CommitId)
})
export const SourcePublication = Schema.Struct({
  status: Schema.Literal("retained"),
  requestId: RequestId,
  workspaceId: RequestId,
  repositoryId: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  ref: Schema.String,
  source: sourceIdentity
})
export type SourcePublication = typeof SourcePublication.Type
export const CreationProof = Schema.Struct({
  requestId: RequestId,
  requestDigest: Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))
})
export const PublishSource = Schema.Struct({
  requestId: RequestId,
  source: Resolved,
  creation: Schema.optionalKey(CreationProof)
})
/** Creates an immutable child without moving or writing any editing workspace. */
export const CreateSource = Schema.Struct({
  requestId: RequestId,
  expectedOperationId: OperationId,
  base: Resolved,
  description: Schema.NonEmptyString.check(Schema.isMaxLength(16384)),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.NonEmptyString.check(Schema.isMaxLength(1000)),
      beforeDigest: Schema.NullOr(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/))),
      content: Schema.NullOr(Schema.String.check(Schema.isMaxLength(65536)))
    })
  ).check(Schema.isMinLength(1), Schema.isMaxLength(30))
})
export const SourceCreation = Schema.Struct({
  status: Schema.Literal("created"),
  replayed: Schema.Boolean,
  ...CreationProof.fields,
  workspaceId: RequestId,
  repositoryId: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  operationId: OperationId,
  parentOperationId: OperationId,
  base: sourceIdentity,
  head: Resolved,
  source: Resolved,
  publicationReady: Schema.Boolean
})
/** Object import is a native store operation, never an edit or source URL. */
export const ImportSource = Schema.Struct({
  requestId: RequestId,
  commits: Schema.Array(
    Schema.Struct({ commitId: CommitId, ref: Schema.NonEmptyString.check(Schema.isMaxLength(200)) })
  ).check(Schema.isMinLength(1), Schema.isMaxLength(2))
})
export const SourceImport = Schema.Struct({
  status: Schema.Literal("imported"),
  requestId: RequestId,
  workspaceId: RequestId,
  repositoryId: Schema.Number.check(Schema.isInt(), Schema.isGreaterThan(0)),
  operationId: OperationId,
  head: NativeRevision,
  revisions: Schema.Array(NativeRevision).check(Schema.isMinLength(1), Schema.isMaxLength(2))
})
export const FileRecovery = Schema.Struct({
  requestId: RequestId,
  path: Schema.String,
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      preimage: Schema.NullOr(Schema.String),
      proposed: Schema.NullOr(Schema.String)
    })
  )
})
export const OperationResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("accepted"),
    replayed: Schema.optionalKey(Schema.Boolean),
    operationId: OperationId,
    parentOperationId: OperationId,
    timestamp: Schema.String,
    head: NativeRevision,
    revision: NativeRevision,
    revisions: Schema.Array(NativeRevision),
    // The local native receipt is durable. Its asynchronous cloud projection
    // is acknowledged only by the head reporter, not by this guest process.
    provenance: Schema.Literal("pending"),
    recovery: Schema.optionalKey(FileRecovery)
  }),
  Schema.Struct({ status: Schema.Literal("unchanged"), operationId: OperationId, revision: NativeRevision })
])
export type OperationResult = typeof OperationResult.Type
/**
 * Every code a native coding failure can carry.
 *
 * It used to be `Schema.String`. The guest adapter's JSON error envelope is
 * decoded straight onto this field (`native.ts`), so an unconstrained `code`
 * let a program outside this repo choose the code on a `{ code, message }`
 * record — and that record is what `agent/internal/FailureSummary.ts` puts on
 * a run's first journal line, off which a run card picks the sentence a person
 * reads. A guest answering `{"error":{"code":"model_failed", …}}` made a
 * `repository/inspection` run say "a turn opened and the model never answered"
 * with no model in the run and no source change anywhere. Nothing in this repo
 * could see it: it is not a raise site, it is a string.
 *
 * So the field is closed, and the boundary decodes into it. The set is the
 * union of three declarations this repo already holds:
 *
 * - what this repo's own native paths raise (`native.ts`, `flows/repository`),
 * - what the guest adapter answers, as Plue's own failure registry spells it
 *   without the `coding_` prefix (`packages/rpc/src/PlueFailureCodes.ts`),
 * - and what the same adapter answers in its `--engine` mode, as
 *   `flows/coding/snapshots.ts` `ENGINE_CODES` admits it.
 *
 * A code outside the set is not lost: `native.ts` raises `invalid_receipt` and
 * keeps the guest's own code and sentence in the message, which is where a
 * foreign sentence already belonged. That is a smaller failure than the one it
 * replaces — the adapter's word is still on the card, and it can no longer be
 * mistaken for another vocabulary's.
 */
export const NativeCode = Schema.Literals([
  "invalid_receipt",
  "invalid_request",
  "outcome_unknown",
  "response_too_large",
  "source_creation_unavailable",
  "source_changed",
  "source_missing",
  "source_publication_invalid_ack",
  "source_publication_unavailable",
  "source_refused",
  "file_conflict",
  "file_recovery_required",
  "gateway_not_configured",
  "guest_failure",
  "host_unavailable",
  "host_upgrade_required",
  "provenance_pending",
  "provider_refresh_required",
  "reporter_upgrade_required",
  "unsupported_jj",
  "workspace_busy",
  "invalid_ref",
  "operation_conflict",
  "request_conflict",
  "revision_conflict",
  "snapshot_incomplete",
  "snapshot_refused",
  "unsupported_version"
])
export type NativeCode = typeof NativeCode.Type
/** Whether a string the guest adapter answered is one this repo declares. */
export const isNativeCode = Schema.is(NativeCode)
export class NativeCodingError extends Schema.TaggedError<NativeCodingError>()("coding/NativeCodingError", {
  code: NativeCode,
  message: Schema.String,
  recovery: Schema.optionalKey(FileRecovery)
}) {}
// Codes with a Go twin (`coding_<code>` or `<code>` in docs/api/failure-codes.json)
// carry the registry's verdict; flows/test/coding-fault.test.ts holds them equal.
Fault.register(
  "coding/NativeCodingError",
  {
    invalid_request: "user",
    invalid_ref: "user",
    source_changed: "user",
    source_missing: "user",
    source_refused: "user",
    snapshot_refused: "user",
    file_conflict: "user",
    file_recovery_required: "user",
    revision_conflict: "factory",
    invalid_receipt: "infra",
    outcome_unknown: "wait",
    provenance_pending: "wait",
    workspace_busy: "wait",
    operation_conflict: "wait",
    source_creation_unavailable: "dependency",
    source_publication_invalid_ack: "dependency",
    source_publication_unavailable: "dependency",
    gateway_not_configured: "infra",
    provider_refresh_required: "infra",
    unsupported_jj: "infra",
    host_unavailable: "infra",
    host_upgrade_required: "infra",
    reporter_upgrade_required: "infra",
    snapshot_incomplete: "infra",
    unsupported_version: "infra",
    guest_failure: "bug",
    response_too_large: "bug",
    request_conflict: "bug"
  } satisfies Fault.Rows<NativeCode>
)
