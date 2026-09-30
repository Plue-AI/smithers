/**
 * The trampoline: one `execute` call follows a whole lineage of rounds, and
 * the two refusals that loop raises.
 *
 * `docs/specs/Concepts/Trampoline Loops.md` makes every round its own
 * execution. This module owns the loop that walks them — the handoff that
 * opens the next round, and the poll that waits out a suspended one — so
 * `make.ts` is left holding the adapter and nothing else.
 *
 * @since 0.1.0
 */

import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { Flow, FlowRuntime, RetryPolicy } from "@smthrs/flow"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type { Encoded } from "./Encoded.ts"
import * as Round from "./Round.ts"

/**
 * A suspended execution spent the caller's resume retry policy.
 *
 * @category errors
 * @since 1.0.0
 */
export class SuspendedResumeGaveUp extends Schema.TaggedError<SuspendedResumeGaveUp>()(
  "@smthrs/engine/SuspendedResumeGaveUp",
  {
    code: Schema.Literal("suspended_resume_gave_up").pipe(
      Schema.withConstructorDefault(Effect.succeed("suspended_resume_gave_up"))
    ),
    flowName: Schema.String,
    executionId: Schema.String,
    attempt: Schema.Number,
    elapsedMs: Schema.Number,
    reason: Schema.Literals(["expired", "exhausted"]),
    message: Schema.String
  }
) {}

/**
 * A flow operation named a declaration this engine has not registered.
 *
 * @category errors
 * @since 1.0.0
 */
export class FlowNotRegistered extends Schema.TaggedError<FlowNotRegistered>()(
  "@smthrs/engine/FlowNotRegistered",
  {
    code: Schema.Literal("flow_not_registered").pipe(
      Schema.withConstructorDefault(Effect.succeed("flow_not_registered"))
    ),
    flowName: Schema.String,
    message: Schema.String
  }
) {}

/**
 * The declarations an engine has been told about, by tag. A handoff names its
 * target by tag — it is serializable data that crossed a journal — so
 * following the lineage needs the declaration back to decode the next round's
 * payload and to read its round budget.
 *
 * @category models
 * @since 0.1.0
 */
export type Declarations = Map<
  string,
  Array<{ readonly flow: Flow.Any; readonly scope: Scope.Scope }>
>

/**
 * The lineage position one dispatch is made from. The loop replaces this
 * value whole on each handoff, so the round the linked-cancellation finalizer
 * addresses and the round the loop dispatches cannot drift apart, and no
 * dispatch parameter shadows the state it was derived from.
 *
 * @private
 */
interface LineageRound {
  readonly flow: Flow.Any
  readonly executionId: string
  readonly payload: object
  readonly round: Round.Round
}

/**
 * Builds the typed `execute` an engine answers with: it admits round 0 and
 * then follows the lineage — handoffs and suspended-resume polls alike —
 * until one round settles with an exit.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeExecute = (options: Encoded, declarations: Declarations) =>
  // Untraced because flow execution recursively invokes child flows.
  Effect.fnUntraced(function*<
    Name extends string,
    Payload extends Flow.AnyStructSchema,
    Success extends Schema.Top,
    Error extends Schema.Top,
    const Discard extends boolean = false
  >(
    self: Flow.Flow<Name, Payload, Success, Error, any>,
    opts: {
      readonly executionId: string
      readonly payload: Payload["Type"]
      readonly discard?: Discard | undefined
      readonly suspendedRetryPolicy?:
        | RetryPolicy.RetryPolicy
        | undefined
    }
  ) {
    let capabilityCeilings = (yield* CapabilitySet.current).groups
    const executionId = opts.executionId
    const lineageBudget = self.maxRounds
    const suspendedRetryPolicy = opts.suspendedRetryPolicy ?? RetryPolicy.defaultRetryPolicy
    yield* Effect.annotateCurrentSpan({ executionId })
    let result = Option.none<Flow.Result<Success["Type"], Error["Type"]>>()
    let lineage: LineageRound = {
      flow: self as Flow.Any,
      executionId,
      payload: opts.payload as object,
      round: Round.initial(executionId)
    }

    // link interruption with parent flow
    const parentInstance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
    if (Option.isSome(parentInstance)) {
      const instance = parentInstance.value
      yield* Effect.addFinalizer(() => {
        if (!instance.interrupted || (Option.isSome(result) && result.value._tag === "Complete")) {
          return Effect.void
        }
        // A finalizer cannot report, so a durable engine's
        // `CancelRequestFailed` is logged rather than swallowed silently.
        // The child is not orphaned by it: the parent's own cancellation is
        // already durable, and a durable engine cascades cancellation over
        // the persisted parent-edge table independently of this in-process
        // link (`RunDriver.cancelOwned`), so this path is the prompt
        // delivery and not the guarantee.
        return options.interrupt(lineage.flow, lineage.executionId).pipe(
          // Finalizers inherit an uninterruptible region. Restore delivery's
          // interruptibility so the timeout can stop a blocked store call.
          Effect.interruptible,
          Effect.timeoutOption("5 seconds"),
          Effect.flatMap((delivered) =>
            Option.isNone(delivered)
              ? Effect.logWarning(`engine: linked cancellation timed out for child execution ${lineage.executionId}`)
              : Effect.void
          ),
          Effect.catch((error) =>
            Effect.logWarning(
              `engine: could not record the linked cancellation of child execution ${lineage.executionId}`,
              error
            )
          )
        )
      })
    }
    /**
     * Dispatches one round. `previousExecutionId` is set only on the dispatch
     * that immediately follows a handoff, which is the one edge a durable
     * driver links the new round's row back through.
     */
    const runRound = (
      step: LineageRound,
      parent: FlowRuntime.FlowInstance["Service"] | undefined,
      previousExecutionId?: string,
      follow = false
    ): Effect.Effect<Flow.Result<Success["Type"], Error["Type"]>> =>
      options.execute(step.flow, {
        executionId: step.executionId,
        payload: step.payload,
        discard: false,
        parent,
        round: previousExecutionId === undefined
          ? step.round
          : { ...step.round, previousExecutionId },
        ...(follow ? { follow } : {})
      }).pipe(CapabilitySet.attenuateGroups(capabilityCeilings)) as Effect.Effect<
        Flow.Result<Success["Type"], Error["Type"]>
      >
    // A discarded execution was admitted below, so its follower's first
    // dispatch already follows the round.
    let current = runRound(lineage, Option.getOrUndefined(parentInstance), undefined, opts.discard === true)

    const follow = Effect.gen(function*() {
      // The retry policy is 1-based; only elapsed polls advance this counter.
      let resumeAttempt = 1
      // The expiration origin for the resume loop is in-process by design:
      // the loop itself only lives as long as this caller, and a restart
      // re-enters `execute` with a fresh budget. What must not happen is the
      // bound being silently inert (issue #45): `expirationMs` on the
      // suspended retry policy caps the wall-clock time this caller keeps
      // polling a suspended execution.
      const resumeStartMs = yield* Clock.currentTimeMillis
      while (true) {
        const wrapped = !opts.discard && Option.isSome(parentInstance)
          ? yield* Flow.wrapActionResult(
            current,
            (result) => result._tag === "Suspended"
          )
          : yield* current
        result = Option.some(wrapped)
        if (wrapped._tag === "Complete") {
          return yield* wrapped.exit as Exit.Exit<any>
        }
        if (wrapped._tag === "Handoff") {
          // The round settled by naming the next one. Following it here is
          // what makes the trampoline transparent to the caller: one
          // `execute` answers with the LINEAGE's value, and each round keeps
          // its own execution id and journal underneath.
          // DECIDED: `maxRounds` belongs to the
          // lineage originator. A multi-flow handoff cannot reset or replace
          // the budget by naming a target with a different declaration.
          const advanced = yield* Round.next(lineage.round, {
            flowName: self._tag,
            maxRounds: lineageBudget
          }).pipe(Effect.catch((error) => Effect.die(error)))
          // DECIDED: a caller that cannot
          // resolve the target dies rather than answering with the raw
          // handoff. The round is durable either way, so the lineage is not
          // lost — what is wrong is this caller's wiring, and saying so is
          // the same posture `execute` takes for an unregistered flow.
          const target = declarations.get(wrapped.flow)?.at(-1)?.flow
          if (target === undefined) {
            return yield* Effect.die(
              new FlowNotRegistered({
                flowName: wrapped.flow,
                message:
                  `${lineage.flow._tag} handed off to flow ${wrapped.flow}, which is not registered with this engine`
              })
            )
          }
          // A handoff payload travels encoded, so the next round's own schema
          // is what turns it back into the payload that round is planned with.
          const decoded = yield* Effect.orDie(
            Schema.decodeUnknownEffect(Schema.toCodecJson(target.payloadSchema))(wrapped.payload)
          ) as Effect.Effect<object>
          capabilityCeilings = [...capabilityCeilings, ...(wrapped.capabilityCeilings ?? [[]])]
          const previousExecutionId = lineage.executionId
          lineage = {
            flow: target,
            executionId: advanced.executionId,
            payload: decoded,
            round: advanced.round
          }
          // Durable handoff already admitted and scheduled the successor. Join
          // its drive so a successor that parked before this follower arrived
          // is not replayed; memory adapters admit the round while joining it.
          current = runRound(lineage, Option.getOrUndefined(parentInstance), previousExecutionId, true)
          continue
        }
        if (!opts.discard && Option.isSome(parentInstance)) {
          return yield* Flow.suspend(parentInstance.value)
        }
        // Only elapsed polls advance this caller's retry policy. A wake
        // observes work already scheduled elsewhere and spends no attempt.
        const elapsedMs = (yield* Clock.currentTimeMillis) - resumeStartMs
        const delay = yield* RetryPolicy.nextDelayEffect(
          suspendedRetryPolicy,
          resumeAttempt,
          { elapsedMs }
        )
        if (Option.isNone(delay)) {
          // Distinguish the wall-clock give-up from attempt exhaustion: the
          // delay is only elapsed-dependent when dropping `elapsedMs` would
          // have allowed another attempt.
          const expired = Option.isSome(
            RetryPolicy.nextDelay(suspendedRetryPolicy, resumeAttempt)
          )
          const reason = expired ? "expired" : "exhausted"
          return yield* Effect.die(
            new SuspendedResumeGaveUp({
              flowName: self._tag,
              executionId,
              attempt: resumeAttempt,
              elapsedMs,
              reason,
              message: `${self._tag}.execute: suspendedRetryPolicy ${reason}`
            })
          )
        }
        const sleep = Effect.as(Effect.sleep(delay.value), false)
        const woken = yield* (options.resumeSignal === undefined
          ? sleep
          : Effect.raceFirst(sleep, Effect.as(options.resumeSignal(lineage.flow, lineage.executionId), true)))
        // Only an elapsed poll resumes. A wake is published by the write that
        // already scheduled the re-drive, and resuming is itself a wake: two
        // callers following one parked run would wake each other forever,
        // re-driving it back to back with no delay.
        if (!woken) {
          resumeAttempt = resumeAttempt + 1
          yield* options.resume(lineage.flow, lineage.executionId, { poll: true })
        }
        current = runRound(lineage, Option.getOrUndefined(parentInstance), undefined, true)
      }
    })
    if (opts.discard) {
      // Acknowledge admission before returning, then follow settlements in
      // the registration's scope so closing the submitting scope cannot
      // truncate the lineage. A low-level adapter without a local handler
      // uses the caller's scope instead.
      yield* options.execute(self, {
        executionId,
        payload: lineage.payload,
        discard: true,
        parent: Option.getOrUndefined(parentInstance),
        round: lineage.round
      })
      const scope = declarations.get(self._tag)?.at(-1)?.scope ?? (yield* Effect.scope)
      yield* Effect.forkIn(follow, scope)
      return executionId
    }
    return yield* follow
  })
