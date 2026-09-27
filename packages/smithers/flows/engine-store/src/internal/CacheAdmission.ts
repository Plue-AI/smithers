/**
 * Pure, phase-specific cache evidence admission. Storage decoding, current-read
 * measurement, TTL history, output replay and publication I/O stay with their owners.
 * @since 1.0.0-rc.0
 */

import type { Action } from "@smthrs/flow"
import type { FileBoundary } from "@smthrs/flow/FileBoundary"
import * as FileSet from "@smthrs/plan/FileSet"
import type * as StepBoundary from "../StepBoundary.ts"

/** Reasons an existing declaration cannot name reusable results.
 * @category models
 * @since 1.0.0-rc.0
 */
export type DisabledReason = "unsealed" | "missing-boundary" | "expected-boundary" | "unresolved-read-glob"

/** Declaration eligibility is separate from proof that a result may be reused.
 * @category models
 * @since 1.0.0-rc.0
 */
export type Declaration =
  | { readonly _tag: "Eligible"; readonly metadata: FileBoundary }
  | { readonly _tag: "Disabled"; readonly reason: DisabledReason }

/** The proof-bearing part of already-decoded attempt metadata.
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Metadata {
  readonly tier: Action.Tier
  readonly boundary?: StepBoundary.BoundaryEvidence | undefined
  readonly readSetVerified?: true | undefined
  readonly boundaryQuarantined?: true | undefined
}

/** A refusal is not a failure of an already durable action outcome.
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Refused {
  readonly _tag: "Refused"
  readonly reason:
    | DisabledReason
    | "invalid-meta"
    | "unsealed-meta"
    | "missing-evidence"
    | "deviation"
    | "unverified-writes"
    | "unverified-hermetic-reads"
    | "unverified-recorded-reads"
    | "quarantined-evidence"
    | "contradictory-evidence"
}

/** Necessary historical evidence, not yet a hit: current reads and outputs still need verification.
 * @category models
 * @since 1.0.0-rc.0
 */
export interface CandidateEvidence<M extends Metadata> {
  readonly _tag: "CandidateEvidence"
  readonly meta: M
  readonly evidence: StepBoundary.BoundaryEvidence
}

/** Shared gate for fresh completion and durable-completion convergence.
 * @category models
 * @since 1.0.0-rc.0
 */
export interface PublishCompletion<M extends Metadata> {
  readonly _tag: "PublishCompletion"
  readonly meta: M
}

/** Classifies existing declaration policy without changing keys or measuring the host.
 * @category classifiers
 * @since 1.0.0-rc.0
 */
export const declaration = (
  input: { readonly tier: Action.Tier; readonly metadata?: FileBoundary | undefined }
): Declaration => {
  if (input.tier !== "sealed") return { _tag: "Disabled", reason: "unsealed" }
  if (input.metadata === undefined) return { _tag: "Disabled", reason: "missing-boundary" }
  if (input.metadata.boundaryMode !== "hard") return { _tag: "Disabled", reason: "expected-boundary" }
  if (input.metadata.readSet.some(FileSet.isGlob)) return { _tag: "Disabled", reason: "unresolved-read-glob" }
  return { _tag: "Eligible", metadata: input.metadata }
}

/** Candidate reads are remeasured, so do not require a historical readSetVerified flag here.
 * @category classifiers
 * @since 1.0.0-rc.0
 */
export const candidate = <M extends Metadata>(meta: M | undefined): CandidateEvidence<M> | Refused => {
  if (meta === undefined) return { _tag: "Refused", reason: "invalid-meta" }
  // Legacy flags never override quarantine. Retain the durable outcome and
  // the original metadata, but refuse to promote contradictory proof to reuse.
  if (meta.boundaryQuarantined === true) {
    return {
      _tag: "Refused",
      reason: meta.boundary !== undefined || meta.readSetVerified === true
        ? "contradictory-evidence"
        : "quarantined-evidence"
    }
  }
  if (meta.readSetVerified === true && meta.boundary === undefined) {
    return { _tag: "Refused", reason: "contradictory-evidence" }
  }
  if (meta.tier !== "sealed") return { _tag: "Refused", reason: "unsealed-meta" }
  const evidence = meta.boundary
  if (evidence === undefined) return { _tag: "Refused", reason: "missing-evidence" }
  if (evidence.deviation !== undefined) return { _tag: "Refused", reason: "deviation" }
  if (evidence.wholeTreeWritesVerified !== true) return { _tag: "Refused", reason: "unverified-writes" }
  if (evidence.hermeticReadsVerified !== true) return { _tag: "Refused", reason: "unverified-hermetic-reads" }
  return { _tag: "CandidateEvidence", meta, evidence }
}

/** Publication additionally requires the read proof associated with the completed body.
 * Both stored quarantine and the caller's current integrity verdict forbid publication.
 * @category classifiers
 * @since 1.0.0-rc.0
 */
export const completion = <M extends Metadata>(
  declared: Declaration,
  meta: M | undefined,
  quarantined: boolean
): PublishCompletion<M> | Refused => {
  if (quarantined) return { _tag: "Refused", reason: "quarantined-evidence" }
  if (declared._tag === "Disabled") return { _tag: "Refused", reason: declared.reason }
  const checked = candidate(meta)
  if (checked._tag === "Refused") return checked
  if (checked.meta.readSetVerified !== true) return { _tag: "Refused", reason: "unverified-recorded-reads" }
  return { _tag: "PublishCompletion", meta: checked.meta }
}
