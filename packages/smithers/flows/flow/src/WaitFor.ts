/**
 * The system wait point, as an ordinary declared action.
 *
 * `docs/concepts/flows-and-actions.md` names wait-for-event the
 * other half of the timer gap and says how to close it: ship it over the
 * existing `DurableDeferred`, so an external signal is a visible, keyed plan
 * node. That is this module. {@link action} is a plain `Action.make`
 * declaration — catalogable, `.call()`-able, one node in the built plan — and
 * {@link layer} is the implementation.
 *
 * Nothing about resolution is new. The wait is a `DurableDeferred`, so whoever
 * satisfies it completes it the way every other durable deferred is completed:
 * a token, and `DurableDeferred.succeed`, `fail`, `failCause`, or `done`.
 * {@link deferred} is how a resolver names the same wait point the action
 * awaits. The park is declared through the ordinary waiting vocabulary
 * ({@link module:WaitingAnnotation.annotateWaiting}) under `event`, carrying
 * that token as the compare-and-swap material a wake handler matches. Replay is
 * the deferred's: once a result is recorded, a re-driven round reads it and
 * runs through instead of parking again.
 *
 * @since 0.1.0
 */

import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Action from "./Action/index.ts"
import * as DurableDeferred from "./DurableDeferred.ts"
import { FlowInstance } from "./FlowRuntime/FlowInstance.ts"
import type { FlowRuntime } from "./FlowRuntime/FlowRuntime.ts"
import { annotateWaiting } from "./FlowRuntime/WaitingAnnotation.ts"

/**
 * A wait whose payload does not name exactly one reachable wait point.
 *
 * A payload names the wait point by `name`, relative to the running execution,
 * or by an absolute `token`. Naming both, or neither, leaves nothing to await;
 * a token that does not parse names nothing either; and a token addressed to a
 * different flow or a different execution names a wait point this execution
 * cannot observe, because a durable deferred result is recorded against the
 * flow and execution that own it.
 *
 * @category errors
 * @since 0.1.0
 */
export class WaitForRequestInvalid extends Schema.TaggedError<WaitForRequestInvalid>()(
  "@smthrs/flow/WaitForRequestInvalid",
  {
    code: Schema.Literals([
      "missing_target",
      "ambiguous_target",
      "malformed_token",
      "foreign_execution"
    ]),
    message: Schema.String
  }
) {}

/**
 * The tag the wait declaration is catalogued and resolved under.
 *
 * @category constructors
 * @since 0.1.0
 */
export const tag = "system/wait-for"

/**
 * The durable deferred a named wait point resolves through.
 *
 * This is the resolver's half of {@link action}: the value to hand
 * `DurableDeferred.tokenFromExecutionId` and `DurableDeferred.succeed`, so a
 * wait that a body declared by name is completed through the existing deferred
 * completion path rather than a second one.
 *
 * ```ts
 * const gate = WaitFor.deferred("approval")
 * const token = DurableDeferred.tokenFromExecutionId(gate, { flow, executionId })
 * yield* DurableDeferred.succeed(gate, { token, value: { approved: true } })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const deferred = (name: string): DurableDeferred.DurableDeferred<typeof Schema.Json> =>
  DurableDeferred.make(`WaitFor/${name}`, { success: Schema.Json })

/**
 * The declared wait action: a wait point named by `name` or by `token`.
 *
 * **When to use**
 *
 * Use it in a body wherever a round has to wait for something outside the run —
 * an approval, a webhook, a human — `WaitFor.action.call({ name: "approval"
 * })`. The node settles with whatever value resolved the wait, so downstream
 * steps read it the way they read any other step result.
 *
 * @category constructors
 * @since 0.1.0
 */
export const action: Action.Declared<
  typeof tag,
  Schema.Struct<{
    readonly token: Schema.optional<Schema.String>
    readonly name: Schema.optional<Schema.String>
  }>,
  typeof Schema.Json,
  typeof WaitForRequestInvalid,
  never
> = Action.makeSystem(tag, {
  payload: {
    token: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String)
  },
  success: Schema.Json,
  error: WaitForRequestInvalid,
  tier: "sealed"
})

/**
 * The deferred name a token addresses, refused when the token does not parse.
 *
 * @private
 */
const parseToken = (token: string): Effect.Effect<DurableDeferred.TokenParsed, WaitForRequestInvalid> =>
  Effect.mapError(
    DurableDeferred.TokenParsed.parse(token),
    (error) =>
      new WaitForRequestInvalid({
        code: "malformed_token",
        message: `${tag} was called with a token that is not a durable deferred token. ${error.message}`
      })
  )

/**
 * The wait point a payload names, resolved against the running execution.
 *
 * DECIDED: a payload names EXACTLY one of `name`
 * and `token`, and a token must address the execution that is waiting. A
 * deferred result is recorded against (flow name, execution id, deferred name)
 * and read back the same way, so awaiting a foreign token would park forever
 * while the value it names was recorded elsewhere; refusing it names the
 * mistake instead. BOTH halves of the owning execution's identity are compared:
 * a token carries its own flow name, so a same-execution token minted for
 * another flow completes under that flow while this one reads under its own,
 * which is the same permanent park by a different route.
 *
 * DECIDED: a wait point is addressed by the
 * PAYLOAD, and the per-dispatch identity {@link module:Sleep} derives its clock
 * from is deliberately NOT applied here. A wait is a rendezvous with something
 * outside the run, and a resolver has to name the same wait point to complete
 * it, so the name is the author's and two calls naming one wait point await one
 * fact — which is the intended reading, not an aliasing bug. A sleep has no
 * counterpart to agree with, which is why it takes its identity from the node.
 *
 * @private
 */
const target = (
  payload: { readonly token?: string | undefined; readonly name?: string | undefined },
  flowName: string,
  executionId: string
): Effect.Effect<DurableDeferred.DurableDeferred<typeof Schema.Json>, WaitForRequestInvalid> => {
  if (payload.token !== undefined && payload.name !== undefined) {
    return Effect.fail(
      new WaitForRequestInvalid({
        code: "ambiguous_target",
        message: `${tag} was called with both "token" and "name". A wait names one wait point: ` +
          "a name relative to this execution, or an absolute token."
      })
    )
  }
  if (payload.name !== undefined) return Effect.succeed(deferred(payload.name))
  if (payload.token !== undefined) {
    return Effect.flatMap(
      parseToken(payload.token),
      (parsed) =>
        parsed.flowName !== flowName || parsed.executionId !== executionId
          ? Effect.fail(
            new WaitForRequestInvalid({
              code: "foreign_execution",
              message: `${tag} was called with a token addressed to flow "${parsed.flowName}" in execution ` +
                `"${parsed.executionId}", but it is running as flow "${flowName}" in execution ` +
                `"${executionId}". A durable deferred result is recorded against the execution that owns it, ` +
                "so only that execution can await it."
            })
          )
          : Effect.succeed(
            DurableDeferred.make(parsed.deferredName, { success: Schema.Json })
          )
    )
  }
  return Effect.fail(
    new WaitForRequestInvalid({
      code: "missing_target",
      message: `${tag} was called with neither "token" nor "name", so there is no wait point to await.`
    })
  )
}

/**
 * The wait implementation: park under `event` with the wake token, and settle
 * with the value that resolved the wait.
 *
 * Provide it beside the other action implementation layers a body calls, over
 * the {@link module:Implementations.layerImplementations} table they file
 * themselves in:
 *
 * ```ts
 * Layer.mergeAll(WaitFor.layer, Interpreter.layer(Pipeline)).pipe(
 *   Layer.provideMerge(Action.layerImplementations)
 * )
 * ```
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<never, never, Crypto.Crypto | FlowRuntime> = action.toLayer((payload) =>
  Effect.gen(function*() {
    const instance = yield* FlowInstance
    const waitPoint = yield* target(payload, instance.flow._tag, instance.executionId)
    const token = DurableDeferred.tokenFromExecutionId(waitPoint, {
      flow: instance.flow,
      executionId: instance.executionId
    })
    yield* annotateWaiting({ reason: "event", token })
    return yield* DurableDeferred.await(waitPoint)
  })
)
