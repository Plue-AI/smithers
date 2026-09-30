/** Private browser-safe values projected from ordinary finalization receipts. */
import { Schema } from "effect"
import {
  GitHubPull,
  LandingCandidate,
  LandingIdentity,
  LaneReceipt,
  LocalPull,
  MergeOutcome
} from "./landing-schema.ts"
import { SourcePublication } from "./native-schema.ts"
import { Receipt, RequestResult, Result, Revision } from "./schema.ts"

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
/** Why a cleanup is not the tip a lander may deliver, or undefined. */
export const cleanedTipRefusal = (cleanup: VibeCleanup): string | undefined => {
  const atoms = cleanup.result.changes.flatMap((change) => change.implementation.atoms)
  return cleanup.result.status !== "validated" || cleanup.result.findings.length !== 0 ||
      cleanup.head.treeId !== cleanup.admission.validatedHead.treeId ||
      atoms.at(-1)?.commitId !== cleanup.head.commitId
    ? "Landing requires the cleaned, revalidated native tip"
    : undefined
}
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
/** A host without the backend fast-forwarded main to the one verified candidate commit. */
export const VibeFastForwarded = Schema.Struct({
  cleanup: VibeCleanup,
  prepared: LandingCandidate,
  mainCommitId: Revision.fields.commitId,
  receipts: Schema.Array(Receipt)
})
export type VibeFastForwarded = typeof VibeFastForwarded.Type
/** A host without the backend opened the candidate's GitHub pull request; GitHub merged it or keeps it open. */
export const VibePullRequested = Schema.Struct({
  cleanup: VibeCleanup,
  prepared: LandingCandidate,
  pullRequest: LocalPull,
  merge: MergeOutcome
})
export type VibePullRequested = typeof VibePullRequested.Type
export const VibeDelivered = Schema.Union([
  VibeLanded,
  VibeProposed,
  VibeSubmitted,
  VibeFastForwarded,
  VibePullRequested
])
export type VibeDelivered = typeof VibeDelivered.Type
