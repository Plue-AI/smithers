/**
 * Adapts a low-level `Encoded` implementation into the typed `FlowRuntime`
 * port `@smthrs/flow` declares.
 *
 * The two long-running concerns this adapter delegates to live beside it:
 * `Trampoline.ts` follows a lineage of rounds for `execute`, and
 * `Dispatch.ts` allocates, admits, and retries one action for
 * `actionExecute`.
 *
 * @since 0.1.0
 */

import { type DurableClock, type DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Exit from "effect/Exit"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { renderDiagnostic } from "../internal/Diagnostic.ts"
import { toJsonExit } from "../internal/JsonExit.ts"
import { makeActionExecute } from "./Dispatch.ts"
import type { Encoded } from "./Encoded.ts"
import { placeExecute, placeInterrupt, placeResume } from "./Placed.ts"
import { type Declarations, makeExecute } from "./Trampoline.ts"

/**
 * Builds a typed `FlowRuntime` service from a low-level encoded
 * implementation.
 *
 * **When to use**
 *
 * Use when wiring a trusted low-level flow engine implementation into the
 * typed `FlowRuntime` port.
 *
 * **Gotchas**
 *
 * The implementation must correctly persist, resume, and encode flow state.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeUnsafe = (options: Encoded): FlowRuntime.FlowRuntime["Service"] => {
  /**
   * The declarations this engine has been told about, by tag. A handoff names
   * its target by tag — it is serializable data that crossed a journal — so
   * following the lineage needs the declaration back to decode the next
   * round's payload and to read its round budget.
   */
  const declarations: Declarations = new Map()
  return FlowRuntime.FlowRuntime.of({
    // Untraced because registering a flow recursively re-enters the engine.
    register: Effect.fnUntraced(function*(flow, execute) {
      const services = yield* Effect.context<FlowRuntime.FlowRuntime>()
      const registration = { flow, scope: yield* Effect.scope }
      const existing = declarations.get(flow._tag)
      const entries = existing ?? []
      if (existing === undefined) declarations.set(flow._tag, entries)
      entries.push(registration)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          entries.splice(entries.indexOf(registration), 1)
          if (entries.length === 0) declarations.delete(flow._tag)
        })
      )
      yield* options.register(
        flow,
        (payload, executionId) =>
          Effect.matchEffect(Effect.suspend(() => execute(payload, executionId)), {
            onFailure: (error) =>
              Effect.matchEffect(flow.errorSchema.makeEffect(error), {
                // A body failure outside the flow's declared error schema is a
                // defect, and the defect is the ERROR, not the schema issue
                // about it. `orDie` on the validation reported only the
                // mismatch: for a flow declaring no error the whole report was
                // `InvalidType(<Never>)`, which erased the one message the
                // operator needed — the interpreter's refusal naming the
                // action it could not resolve. Dying with the error itself
                // keeps that message, and keeps it durably: the driver encodes
                // a settled exit through `Flow.Result({ success, error:
                // flow.errorSchema })`, whose defect channel is
                // `Schema.Defect`, so an undeclared failure delivered as a
                // FAILURE could not be encoded at all and left the run row
                // `running` and owned forever.
                //
                // The raw error stays IN THIS PROCESS. `FlowProxyServer` is
                // the boundary that must not republish it: a defect crossing
                // that boundary is rewritten to a redacted refusal there.
                onFailure: () =>
                  Effect.andThen(
                    Effect.annotateLogs(
                      Effect.logError("A flow body failed with an error outside its declared error schema"),
                      { flow: flow._tag, error: renderDiagnostic(error) }
                    ),
                    Effect.die(error)
                  ),
                onSuccess: () => Effect.fail(error)
              }),
            onSuccess: (value) =>
              Effect.flatMap(FlowRuntime.FlowInstance, (instance) =>
                // A handoff has no success value for this round. Its handler
                // returns `undefined` only to leave through `Flow.intoResult`,
                // which replaces that value with the recorded handoff.
                instance.handoff === undefined
                  ? Effect.as(Effect.orDie(flow.successSchema.makeEffect(value)), value)
                  : Effect.succeed(value))
          }).pipe(
            Flow.attenuateCapabilities(Flow.capabilityCeilings(flow.annotations)),
            Effect.updateContext(
              (input) => Context.merge(services, input) as Context.Context<any>
            )
          )
      )
    }),
    // A placement the `Hosts` table binds elsewhere runs on that engine.
    execute: placeExecute(makeExecute(options, declarations)),
    poll: options.poll,
    interrupt: placeInterrupt(options.interrupt),
    interruptUnsafe: options.interruptUnsafe,
    resume: placeResume(options.resume),
    actionExecute: makeActionExecute(options),
    // Untraced because the explicit span below carries deferred attributes.
    deferredResult: Effect.fnUntraced(
      function*<Success extends Schema.Constraint, Error extends Schema.Constraint>(
        deferred: DurableDeferred.DurableDeferred<Success, Error>
      ) {
        const instance = yield* FlowRuntime.FlowInstance
        yield* Effect.annotateCurrentSpan({
          executionId: instance.executionId
        })
        const exit = yield* options.deferredResult(deferred)
        if (Option.isNone(exit)) {
          return Option.none()
        }
        // A persisted result means the annotated wait (if any) resolved: the
        // waiting annotation is consumed here so a replayed
        // `annotateWaiting` cannot classify a later, unrelated suspension
        // (issue #42).
        instance.waiting = undefined
        return Option.some(
          yield* Effect.orDie(
            Schema.decodeEffect(deferred.exitSchema)(toJsonExit(exit.value))
          ) as Effect.Effect<Exit.Exit<Success["Type"], Error["Type"]>>
        )
      },
      Effect.withSpan(
        "FlowEngine.deferredResult",
        (deferred) => ({
          attributes: { name: deferred.name }
        }),
        { captureStackTrace: false }
      )
    ),
    // Untraced because the explicit span below carries completion attributes.
    deferredDone: Effect.fnUntraced(
      function*<Success extends Schema.Constraint, Error extends Schema.Constraint>(
        deferred: DurableDeferred.DurableDeferred<Success, Error>,
        opts: {
          readonly flowName: string
          readonly executionId: string
          readonly deferredName: string
          readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
        }
      ) {
        return yield* options.deferredDone({
          flowName: opts.flowName,
          executionId: opts.executionId,
          deferredName: opts.deferredName,
          exit: yield* Schema.encodeEffect(deferred.exitSchema)(
            opts.exit
          ) as Effect.Effect<Exit.Exit<unknown, unknown>>
        })
      },
      Effect.withSpan(
        "FlowEngine.deferredDone",
        (_, { deferredName, executionId }) => ({
          attributes: { name: deferredName, executionId }
        }),
        { captureStackTrace: false }
      )
    ),
    deferredDoneIfWaiting: Effect.fnUntraced(
      function*<Success extends Schema.Constraint, Error extends Schema.Constraint>(
        deferred: DurableDeferred.DurableDeferred<Success, Error>,
        opts: {
          readonly flowName: string
          readonly executionId: string
          readonly deferredName: string
          readonly reason: string
          readonly token: string
          readonly exit: Exit.Exit<Success["Type"], Error["Type"]>
        }
      ) {
        if (options.deferredDoneIfWaiting === undefined) return "NotWaiting" as const
        return yield* options.deferredDoneIfWaiting({
          flowName: opts.flowName,
          executionId: opts.executionId,
          deferredName: opts.deferredName,
          reason: opts.reason,
          token: opts.token,
          exit: yield* Schema.encodeEffect(deferred.exitSchema)(opts.exit) as Effect.Effect<
            Exit.Exit<unknown, unknown>
          >
        })
      },
      Effect.withSpan(
        "FlowEngine.deferredDoneIfWaiting",
        (_, { deferredName, executionId, reason }) => ({
          attributes: { name: deferredName, executionId, reason }
        }),
        { captureStackTrace: false }
      )
    ),
    // Untraced because the explicit span below carries clock attributes.
    scheduleClock: Effect.fnUntraced(
      function*(
        flow: Flow.Any,
        opts: { readonly executionId: string; readonly clock: DurableClock.DurableClock }
      ) {
        return yield* options.scheduleClock(flow, opts)
      },
      Effect.withSpan(
        "FlowEngine.scheduleClock",
        (_, opts) => ({
          attributes: { executionId: opts.executionId, name: opts.clock.name }
        }),
        { captureStackTrace: false }
      )
    ),
    // Forwarded only when the store keeps history. Left absent the property
    // is absent on the typed port too, which is what the interpreter reads to
    // decide whether to build records at all: a store with no journal must
    // not pay for a graph summary nobody will store.
    ...(options.recordNode === undefined ? {} : { recordNode: options.recordNode }),
    ...(options.nodeRecordBytes === undefined ? {} : { nodeRecordBytes: options.nodeRecordBytes })
  })
}
