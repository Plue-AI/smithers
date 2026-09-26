/** Early slow-check feedback, recorded in the existing native deferred store. */
import * as Digest from "@smthrs/core/Digest"
import { DurableEngineState } from "@smthrs/engine-store"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter, Poll, Sleep } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { RunStore } from "@smthrs/run-store"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import * as RunLifecycle from "../../packages/smithers/flows/engine-store/src/internal/RunLifecycle.ts"
import { EarlyFeedback } from "./feedback-schema.ts"
import { Check, CodingError, Implementation, Plan, Receipt, receiptMatches, Result, ValidatedChange } from "./schema.ts"
import { Assess, FastGate, Implement, receiptFindings, RunCheck, ValidatePlan } from "./workflow.ts"
export { EarlyFeedback } from "./feedback-schema.ts"

export const FeedbackError = Schema.Union([CodingError, EarlyFeedback])
const Ready = DurableDeferred.make("coding/feedback/implementations-ready", { success: Schema.Boolean })
const First = DurableDeferred.make("coding/feedback/first-actionable", { success: Receipt })
const Invalid = DurableDeferred.make("coding/feedback/invalid-receipt", { success: CodingError })
const gated = (index: number) => DurableDeferred.make(`coding/feedback/gated/${index}`, { success: ValidatedChange })
const checked = (index: number, id: string) =>
  DurableDeferred.make(`coding/feedback/check/${index}/${Digest.digest(id)}`, { success: Receipt })
const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })

export const RecordGate = Action.make("coding/record-fast-gated-progress", {
  payload: { plan: Plan, index: Schema.Int, group: ValidatedChange },
  success: ValidatedChange,
  error: FeedbackError,
  nondeterministic: true
})
export const RecordSlow = Action.make("coding/record-slow-feedback", {
  payload: { plan: Plan, index: Schema.Int, implementation: Implementation, check: Check, receipt: Receipt },
  success: Receipt,
  error: FeedbackError,
  nondeterministic: true
})

const record = <S extends Schema.Constraint>(deferred: DurableDeferred.DurableDeferred<S>, value: S["Type"]) =>
  Effect.gen(function*() {
    const instance = yield* FlowRuntime.FlowInstance
    return yield* (yield* FlowRuntime.FlowRuntime).deferredDone(deferred, {
      flowName: instance.flow._tag,
      executionId: instance.executionId,
      deferredName: deferred.name,
      exit: Exit.succeed(value)
    })
  })

/** Both writers check after their own committed write; the pair cannot be missed. */
const interruptOnFeedback = (plan: Plan) =>
  Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    const ready = yield* runtime.deferredResult(Ready)
    if (Option.isNone(ready)) return
    yield* ready.value
    // Invalid evidence is never actionable feedback. Delay its typed refusal
    // until all native writers finish, even when a valid finding arrived first.
    const rejected = yield* runtime.deferredResult(Invalid)
    if (Option.isSome(rejected)) return yield* (yield* rejected.value)
    const first = yield* runtime.deferredResult(First)
    if (Option.isNone(first)) return
    const trigger = yield* first.value
    const changes: Array<ValidatedChange> = []
    for (const [index, change] of plan.changes.entries()) {
      const saved = yield* runtime.deferredResult(gated(index))
      if (Option.isNone(saved)) {
        return yield* invalid("The implementation-ready marker has no corresponding native implementation")
      }
      const group = yield* saved.value
      if (group.implementation.change !== change.id) {
        return yield* invalid("Recorded implementations reordered the mythical progression")
      }
      const receipts = [...group.receipts]
      for (const check of change.checks.filter((check) => check.tier === "slow")) {
        const saved = yield* runtime.deferredResult(checked(index, check.id))
        if (Option.isSome(saved)) receipts.push(yield* saved.value)
      }
      changes.push({ implementation: group.implementation, receipts })
    }
    const findings = yield* Effect.try({
      try: () =>
        changes.flatMap((group, index) =>
          group.receipts.flatMap((receipt) => {
            const check = plan.changes[index]!.checks.find((check) => check.id === receipt.checkId)
            if (!check) throw invalid("Recorded feedback names an unplanned check")
            return receiptFindings(plan, index, group.implementation, check, receipt)
          })
        ),
      catch: (error) => error instanceof CodingError ? error : invalid(String(error))
    })
    if (
      !findings.length || !changes.some((group) =>
        group.receipts.some((receipt) => Digest.canonical(receipt) === Digest.canonical(trigger))
      )
    ) {
      return yield* invalid("The first actionable feedback has no corresponding exact check receipt")
    }
    return yield* new EarlyFeedback({ result: { status: "changes-requested", changes, findings } })
  })

type Stages = Node.Node<
  ReadonlyArray<ValidatedChange>,
  typeof FeedbackError.Type,
  Action.Requirement<
    (typeof Implement | typeof RunCheck | typeof FastGate | typeof RecordGate | typeof RecordSlow)["name"]
  >
>
const stages = (plan: Plan, index: number, parent: Parameters<typeof Implement.call>[0]["parent"]): Stages => {
  const change = plan.changes[index]
  if (!change) return Node.succeed([])
  return Implement.call({ change, parent, memoryRevision: plan.memoryRevision }).pipe(
    Node.bindPlanned((implementation) =>
      Node.all(Object.fromEntries(
        change.checks.filter((check) => check.tier === "fast")
          .map((check) => [check.id, RunCheck.call({ implementation, check })])
      )).pipe(
        Node.bindPlanned((receipts) => FastGate.call({ change, parent, implementation, receipts })),
        Node.bindPlanned((group) => RecordGate.call({ plan, index, group })),
        Node.bindPlanned((group) =>
          Node.all({
            current: Node.succeed(group),
            slow: Node.all(
              Object.fromEntries(
                change.checks.filter((check) => check.tier === "slow").map(
                  (check) => [
                    check.id,
                    RunCheck.call({ implementation: group.implementation, check }).pipe(
                      Node.bindPlanned((receipt) =>
                        RecordSlow.call({ plan, index, implementation: group.implementation, check, receipt })
                      )
                    )
                  ]
                )
              )
            ),
            next: stages(plan, index + 1, group.implementation.head)
          }).pipe(
            Node.map((
              { current, slow, next }
            ) => [
              { implementation: current.implementation, receipts: [...current.receipts, ...Object.values(slow)] },
              ...next
            ])
          )
        )
      )
    )
  )
}

/** Opt-in correction pass; the existing public/manual ImplementPlan is unchanged. */
export const ObservePlan = Flow.make("coding/ObservePlan", {
  payload: { plan: Plan },
  success: Result,
  error: FeedbackError,
  body: ({ plan }) =>
    ValidatePlan.call({ plan }).pipe(Node.andThen(
      stages(plan, 0, plan.base).pipe(Node.bindPlanned((changes) => Assess.call({ plan, changes })))
    ))
})

// A cancellation request is not acknowledgement. Reuse the engine's native
// lineage/DAG read, including handoffs, before permitting a new JJ writer.
const ChildrenStopped = Action.make("coding/read-feedback-cancellation", {
  payload: { executionId: Schema.String, attempt: Schema.Number },
  success: Poll.CheckResult(Schema.Boolean),
  nondeterministic: true
})
const AwaitStopped = Poll.make("coding/AwaitObsoleteChecksStopped", {
  input: { executionId: Schema.String },
  result: Schema.Boolean,
  intervalMs: 100,
  maxAttempts: 300,
  onTimeout: "fail",
  check: (input) => ChildrenStopped.call(input)
})
export const acknowledgeFeedback = (flow: Flow.Any, executionId: string) =>
  Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    yield* runtime.interrupt(flow, executionId)
    return yield* runtime.execute(AwaitStopped, {
      payload: { executionId },
      executionId: Digest.digest(Digest.canonical(["coding/feedback-stop/v1", executionId]))
    })
  })

export const feedbackLayers = Layer.mergeAll(
  Interpreter.layer(ObservePlan),
  Interpreter.layer(AwaitStopped),
  Poll.layer,
  Sleep.layer,
  RecordGate.toLayer(({ plan, index, group }) =>
    Effect.gen(function*() {
      yield* record(gated(index), group)
      if (index === plan.changes.length - 1) yield* record(Ready, true)
      yield* interruptOnFeedback(plan)
      return group
    })
  ),
  RecordSlow.toLayer(({ plan, index, implementation, check, receipt }) =>
    Effect.gen(function*() {
      const validation = yield* Effect.try({
        try: () => {
          const findings = receiptFindings(plan, index, implementation, check, receipt)
          if (check.tier !== "slow" || !receiptMatches(implementation, check, receipt)) {
            throw invalid("Only exact slow-check receipts can trigger early feedback")
          }
          return findings
        },
        catch: (error) => error instanceof CodingError ? error : invalid(String(error))
      }).pipe(
        Effect.match({ onFailure: (error) => ({ error }), onSuccess: (findings) => ({ findings }) })
      )
      if ("error" in validation) yield* record(Invalid, validation.error)
      else {
        yield* record(checked(index, check.id), receipt)
        if (validation.findings.length) yield* record(First, receipt)
      }
      yield* interruptOnFeedback(plan)
      // This is the check's recorded output, not an assertion that it is valid.
      // Ready or final Assess must expose a retained invalid-receipt refusal.
      return receipt
    })
  ),
  ChildrenStopped.toLayer(({ executionId }) =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore, state = yield* DurableEngineState.DurableEngineState
      const ids = [executionId, ...yield* RunLifecycle.make(store, state).descendants(executionId).pipe(Effect.orDie)]
      const rows = yield* Effect.forEach(ids, (id) => store.get(id).pipe(Effect.orDie))
      const stopped = rows.every((row) =>
        row.status === "completed" || row.status === "failed" || row.status === "cancelled"
      )
      return { satisfied: stopped, output: stopped }
    })
  )
)
