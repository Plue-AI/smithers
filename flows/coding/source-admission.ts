/** Request admission uses captured JJ source facts, never a silently refreshed tip. */
import { Action, FlowRuntime } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding, NativeCodingError, requestIdFor } from "./native.ts"
import { sameCode } from "./planning.ts"
import { CodingError, Plan, Revision, validatePlan } from "./schema.ts"

// Older prepared-source receipts prove no retention; use a distinct durable action identity.
export const AdmitSource = Action.make("coding/admit-retained-source", {
  payload: { plan: Plan },
  success: Schema.Struct({ ...Plan.fields, observedHead: Revision }),
  error: CodingError,
  nondeterministic: true
})

/** The existing per-operation native fences still guard every later mutation. */
export const admitSource = (plan: Plan, requestId?: string) =>
  Effect.gen(function*() {
    yield* Effect.try({
      try: () => validatePlan(plan),
      catch: (error) =>
        error instanceof CodingError ?
          error :
          new CodingError({ code: "invalid_plan", message: String(error) })
    })
    if (!plan.observedHead) {
      return yield* new CodingError({
        code: "stale_revision",
        message: "This request needs the observed native source head; prepare a new plan"
      })
    }
    const jj = yield* Jj.Jj, native = yield* NativeCoding
    const current = yield* native.read([...new Set([plan.base.changeId, plan.observedHead.changeId])])
    const base = current.revisions.find((row) => row.changeId === plan.base.changeId)
    if (
      current.head.kind !== "resolved" || !sameCode(current.head, plan.observedHead) ||
      !base || base.kind !== "resolved" || !sameCode(base, plan.base)
    ) {
      return yield* new CodingError({
        code: "stale_revision",
        message: "Native source changed after this plan; gather and plan again before implementation"
      })
    }
    if (native.sourcePublication === "cloud") {
      if (!requestId) {
        return yield* new CodingError({
          code: "unavailable",
          message: "Cloud source admission requires its durable request identity"
        })
      }
      yield* native.publishOriginalSource({ requestId, source: current.head })
    }
    // Retain the observed immutable commit before even the admission snapshot
    // may rewrite it. Dirty files then refuse this plan without losing its base.
    yield* jj.snapshot("coding request source admission")
    {
      const after = yield* native.read([plan.base.changeId])
      const afterBase = after.revisions.find((row) => row.changeId === plan.base.changeId)
      if (
        after.head.kind !== "resolved" || !sameCode(after.head, plan.observedHead) ||
        !afterBase || afterBase.kind !== "resolved" || !sameCode(afterBase, plan.base)
      ) {
        return yield* new CodingError({
          code: "stale_revision",
          message: "Native source changed during publication; gather and plan again before implementation"
        })
      }
    }
    return { ...plan, observedHead: plan.observedHead }
  }).pipe(Effect.mapError((error) =>
    error instanceof CodingError ? error : new CodingError({
      code: error instanceof NativeCodingError && error.code.startsWith("source_publication_")
        ? "unavailable"
        : "stale_revision",
      message: "Prepared source could not be verified: " + (error instanceof Error ? error.message : String(error))
    })
  ))

export const sourceAdmission = AdmitSource.toLayer(({ plan }) =>
  Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    return yield* admitSource(
      plan,
      requestIdFor(instance.executionId, JSON.stringify(["publish-source", plan.observedHead?.commitId]))
    )
  })
)
