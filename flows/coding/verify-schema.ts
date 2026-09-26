/**
 * The actions and values of `coding/verify` (verify/flow.ts): import the
 * retained commit, then every required check runs on its immutable export
 * through the host's existing RunCheck delegates.
 */
import { Action } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import { NativeCoding, NativeCodingError, requestIdFor } from "./native.ts"
import { Check, CodingError, type Implementation, Receipt, receiptMatches, Revision, StackBase } from "./schema.ts"
export const VerifyInput = Schema.Struct({
  source: StackBase,
  checks: Schema.Array(Check).check(Schema.isMinLength(1), Schema.isMaxLength(64))
})
export const VerifyResult = Schema.Struct({
  status: Schema.Literals(["passed", "failed"]),
  failed: Schema.Array(Schema.String),
  receipts: Schema.Array(Receipt)
})
export type VerifyResult = typeof VerifyResult.Type

/** Imports the retained commit and answers its exact revision. */
export const AdmitVerifySource = Action.make("coding/admit-verify-source", {
  payload: { source: StackBase, checks: Schema.Array(Check) },
  success: Revision,
  error: CodingError,
  nondeterministic: true
})

/** The implementation every verify receipt is bound to: the one retained commit. */
export const verifyImplementation = (head: typeof Revision.Type): typeof Implementation.Type => ({
  change: "mythical-candidate",
  parent: head,
  atoms: [head],
  head,
  reads: [],
  writes: []
})

/** Why a check set cannot verify anything (repeated ids, no required fast and slow check), or undefined. */
export const verifyChecksRefusal = (checks: ReadonlyArray<typeof Check.Type>): CodingError | undefined => {
  const ids = checks.map((check) => check.id)
  if (new Set(ids).size !== ids.length) {
    return new CodingError({ code: "invalid_request", message: "Verification checks repeat an id" })
  }
  if (
    !checks.some((check) => check.required && check.tier === "fast") ||
    !checks.some((check) => check.required && check.tier === "slow")
  ) {
    return new CodingError({
      code: "invalid_request",
      message: "Verification needs a required fast check and a required slow check"
    })
  }
  return undefined
}

/**
 * Passed only when every required check has a passing receipt without
 * findings that is bound to exactly the verified commit, tree and inputs.
 */
export const verifySummary = (
  checks: ReadonlyArray<typeof Check.Type>,
  implementation: typeof Implementation.Type,
  receipts: ReadonlyArray<typeof Receipt.Type>
): VerifyResult => {
  const failed = checks.filter((check) =>
    check.required && !receipts.some((receipt) =>
      receipt.checkId === check.id &&
      receipt.status === "passed" && receipt.findings.length === 0 && receiptMatches(implementation, check, receipt)
    )
  )
    .map((check) => check.id)
  return { status: failed.length === 0 ? "passed" : "failed", failed, receipts: [...receipts] }
}

export const admitVerifySource = (source: StackBase, checks: ReadonlyArray<typeof Check.Type>, executionId: string) =>
  Effect.gen(function*() {
    const refusal = verifyChecksRefusal(checks)
    if (refusal !== undefined) return yield* refusal
    const native = yield* NativeCoding
    if (!native.importSource) {
      return yield* new CodingError({
        code: "source_refused",
        message: "This workspace's native helper cannot import a stack commit"
      })
    }
    const imported = yield* native.importSource({
      requestId: requestIdFor(executionId, "verify/import"),
      commits: [{ commitId: source.commitId, ref: source.ref }]
    })
    const revision = imported.revisions.find((value) => value.commitId === source.commitId)
    if (revision === undefined || revision.kind !== "resolved") {
      return yield* new CodingError({
        code: "source_refused",
        message: "The stack commit was not imported as a resolved commit"
      })
    }
    return {
      changeId: revision.changeId,
      commitId: revision.commitId,
      treeId: revision.treeId,
      operationId: revision.operationId,
      parentCommitIds: [...revision.parentCommitIds]
    }
  }).pipe(Effect.mapError((error) =>
    error instanceof CodingError ? error : new CodingError({
      code: error instanceof NativeCodingError && (error.code === "source_missing" || error.code === "source_changed")
        ? error.code
        : "source_unavailable",
      message: "The stack commit could not be imported: " + error.message
    })
  ))
