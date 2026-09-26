/** The leaves a linear implementation names, and the policy that validates them. */
import { Action } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
import {
  Change,
  Check,
  CodingError,
  Implementation,
  Plan,
  Receipt,
  receiptMatches,
  Result,
  Revision,
  sameRevision,
  ValidatedChange,
  validatePlan
} from "./schema.ts"

/** These leaves are implemented by existing project flows and repository/build hosts. */
export const ValidatePlan = Action.make("coding/validate-plan", {
  payload: { plan: Plan },
  success: Plan,
  error: CodingError
})
export const Implement = Action.make("coding/implement-change", {
  payload: { change: Change, parent: Revision, memoryRevision: Schema.NonEmptyString },
  success: Implementation,
  error: CodingError,
  nondeterministic: true
})
export const RunCheck = Action.make("coding/check", {
  payload: { implementation: Implementation, check: Check },
  success: Receipt,
  error: CodingError
})
export const FastGate = Action.make("coding/fast-gate", {
  payload: {
    change: Change,
    parent: Revision,
    implementation: Implementation,
    receipts: Schema.Record(Schema.String, Receipt)
  },
  success: ValidatedChange,
  error: CodingError
})
export const Assess = Action.make("coding/assess", {
  payload: { plan: Plan, changes: Schema.Array(ValidatedChange) },
  success: Result,
  error: CodingError
})

/** Validate a completed check before either early feedback or final assessment. */
export const receiptFindings = (
  plan: Plan,
  index: number,
  implementation: Implementation,
  check: Check,
  receipt: Receipt
) => {
  const group = plan.changes[index]
  if (
    !group || group.id !== implementation.change ||
    !group.checks.some((value) =>
      value.id === check.id && value.flow === check.flow && value.flowDigest === check.flowDigest &&
      value.target === check.target && value.tier === check.tier && value.required === check.required
    ) ||
    !receiptMatches(implementation, check, receipt)
  ) {
    throw new CodingError({
      code: "invalid_receipt",
      message: `${implementation.change}: ${check.id} has no exact receipt for the implemented revision`
    })
  }
  for (const finding of receipt.findings) {
    const owner = plan.changes.findIndex((change) => change.id === finding.owner)
    if (owner < 0 || owner > index || finding.sourceCommitId !== implementation.head.commitId) {
      throw new CodingError({
        code: "invalid_receipt",
        message: `${check.id} supplied a finding with invalid owner or source revision`
      })
    }
  }
  return check.required && receipt.status !== "passed" && receipt.findings.length === 0
    ? [{ owner: group.id, sourceCommitId: implementation.head.commitId, message: `${check.target}: ${receipt.status}` }]
    : receipt.findings
}

/** Policy-only implementations. No clock, database, lease, process, or second event log. */
export const policyLayers = Layer.mergeAll(
  ValidatePlan.toLayer(({ plan }) =>
    Effect.try({
      try: () => {
        validatePlan(plan)
        return plan
      },
      catch: (cause) =>
        cause instanceof CodingError ? cause : new CodingError({ code: "invalid_plan", message: String(cause) })
    })
  ),
  FastGate.toLayer(({ change, parent, implementation, receipts }) =>
    Effect.gen(function*() {
      if (
        implementation.change !== change.id || implementation.atoms.length !== change.atoms.length ||
        !sameRevision(implementation.atoms.at(-1)!, implementation.head) ||
        !sameRevision(implementation.parent, parent)
      ) {
        return yield* Effect.fail(
          new CodingError({
            code: "stale_revision",
            message: `Implementation does not match the planned atoms of ${change.id}`
          })
        )
      }
      let previous = parent
      const identities = new Set([parent.changeId])
      for (const [index, atom] of change.atoms.entries()) {
        const actual = implementation.atoms[index]!
        if (
          actual.parentCommitIds.length !== 1 || actual.parentCommitIds[0] !== previous.commitId ||
          identities.has(actual.changeId)
        ) {
          return yield* Effect.fail(
            new CodingError({
              code: "stale_revision",
              message: `JJ atoms of ${change.id} do not form the planned linear progression`
            })
          )
        }
        identities.add(actual.changeId)
        previous = actual
        if (atom.changeId !== null && implementation.atoms[index]?.changeId !== atom.changeId) {
          return yield* Effect.fail(
            new CodingError({
              code: "stale_revision",
              message: `Implementation replaced the native JJ identity of ${change.id}`
            })
          )
        }
      }
      for (const check of change.checks.filter((check) => check.tier === "fast")) {
        const receipt = receipts[check.id]
        if (!receipt || !receiptMatches(implementation, check, receipt)) {
          return yield* Effect.fail(
            new CodingError({
              code: "invalid_receipt",
              message: `Fast receipt ${check.id} does not identify the current revision`
            })
          )
        }
        if (check.required && receipt.status !== "passed") {
          return yield* Effect.fail(
            new CodingError({
              code: "fast_gate",
              message: `${change.id}: ${check.target} did not pass on the current revision`
            })
          )
        }
      }
      return { implementation, receipts: Object.values(receipts) }
    })
  ),
  Assess.toLayer(({ plan, changes }) =>
    Effect.gen(function*() {
      const findings: Array<typeof Result.Type["findings"][number]> = []
      const identities = new Set([plan.base.changeId])
      if (changes.length !== plan.changes.length) {
        return yield* Effect.fail(
          new CodingError({ code: "invalid_receipt", message: "The result is missing planned Changes" })
        )
      }
      for (const [index, group] of plan.changes.entries()) {
        const result = changes[index]!
        if (result.implementation.change !== group.id) {
          return yield* Effect.fail(
            new CodingError({ code: "invalid_receipt", message: "The result reordered the mythical progression" })
          )
        }
        for (const atom of result.implementation.atoms) {
          if (identities.has(atom.changeId)) {
            return yield* Effect.fail(
              new CodingError({
                code: "stale_revision",
                message: `Native JJ change ${atom.changeId} has more than one implemented owner`
              })
            )
          }
          identities.add(atom.changeId)
        }
        for (const check of group.checks.filter((check) => check.tier !== "delivery")) {
          const receipt = result.receipts.find((receipt) => receipt.checkId === check.id)
          if (!receipt || !receiptMatches(result.implementation, check, receipt)) {
            return yield* Effect.fail(
              new CodingError({
                code: "invalid_receipt",
                message: `${group.id}: ${check.id} has no receipt for the implemented revision`
              })
            )
          }
          findings.push(
            ...yield* Effect.try({
              try: () => receiptFindings(plan, index, result.implementation, check, receipt),
              catch: (error) =>
                error instanceof CodingError
                  ? error
                  : new CodingError({ code: "invalid_receipt", message: String(error) })
            })
          )
        }
      }
      return { status: findings.length ? "changes-requested" as const : "validated" as const, changes, findings }
    })
  )
)
