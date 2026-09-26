/** Private browser-safe values projected from ordinary finalization receipts. */
import { Schema } from "effect"
import { GitHubPull, LandingIdentity, LaneReceipt } from "./landing-schema.ts"
import { SourcePublication } from "./native-schema.ts"
import { RequestResult, Result, Revision } from "./schema.ts"

export const VibeInput = Schema.Struct({ requestExecutionId: Schema.NonEmptyString.check(Schema.isMaxLength(1024)) })
/** Original retention gates admission; cleaned retention gates append. */
export const PublicationInput = Schema.Struct({ source: Revision, phase: Schema.Literals(["original", "cleaned"]) })
export const VibeEvidence = Schema.Struct({
  requestExecutionId: VibeInput.fields.requestExecutionId,
  controlRunId: Schema.NonEmptyString,
  planId: Schema.NonEmptyString,
  planDigest: Schema.NonEmptyString,
  // Old completed requests retain their original POC. New requests retain
  // their original prepared source without requiring an experiment.
  pocExecutionId: Schema.optionalKey(Schema.NonEmptyString),
  preparationExecutionId: Schema.optionalKey(Schema.NonEmptyString),
  originalSource: Revision,
  request: RequestResult
})
export type VibeEvidence = typeof VibeEvidence.Type
/** Admission is permission to begin cleanup, not a landed or shipped result. */
export const VibeAdmission = Schema.Struct({ ...VibeEvidence.fields, validatedHead: Revision })
export type VibeAdmission = typeof VibeAdmission.Type
/** Descriptions and checks completed; publication and append still follow. */
export const VibeCleanup = Schema.Struct({
  admission: VibeAdmission,
  summary: Schema.NonEmptyString.check(Schema.isMaxLength(16_384)),
  result: Result,
  head: Revision
})
export type VibeCleanup = typeof VibeCleanup.Type
/** One appended main commit verified from the native landing receipt. Shipped is separate. */
export const VibeLanded = Schema.Struct({
  cleanup: VibeCleanup,
  cleanedSource: SourcePublication,
  landing: LandingIdentity,
  taskId: Schema.Int.check(Schema.isGreaterThan(0)),
  mainCommitId: Revision.fields.commitId,
  landedCount: Schema.Int.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(1024))
})
export type VibeLanded = typeof VibeLanded.Type
/** A send-upstream Change: its GitHub pull request is open for a maintainer to merge. Not landed. */
export const VibeProposed = Schema.Struct({
  cleanup: VibeCleanup,
  cleanedSource: SourcePublication,
  landing: LandingIdentity,
  pullRequest: GitHubPull
})
export type VibeProposed = typeof VibeProposed.Type
/** A repository with a mythical stack: the result went to the stack service, which integrates it and proposes it. */
export const VibeSubmitted = Schema.Struct({
  cleanup: VibeCleanup,
  cleanedSource: SourcePublication,
  lane: LaneReceipt
})
export type VibeSubmitted = typeof VibeSubmitted.Type
export const VibeDelivered = Schema.Union([VibeLanded, VibeProposed, VibeSubmitted])
export type VibeDelivered = typeof VibeDelivered.Type
