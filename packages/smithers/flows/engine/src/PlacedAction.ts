/**
 * Runs one action's body on the host its placement names.
 *
 * An action's implementation is a layer, so the layer decides where the body
 * runs. `layer` implements the action with a body that runs here when the
 * `Hosts` table binds the placement here, and otherwise asks the holder's
 * engine to run `served(action)`, a one-node flow the holder serves, under the
 * action's invocation key. A secret the body uses therefore lives only on the
 * holder: the caller holds the declaration, never the value.
 *
 * @since 1.0.0
 */

import { Action, Flow } from "@smthrs/flow"
import type * as Placement from "@smthrs/plan/Placement"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import { callRemote } from "./FlowEngine/Placed.ts"
import { Hosts } from "./Hosts.ts"

/** The flows `served` has made, one per declaration, so a caller and a holder in one process share one. */
const servedFlows = new WeakMap<object, Flow.Any>()

/**
 * The one-node flow a holder serves for `action`: tag `<action>/remote`, the
 * action's payload, success and error, and a body that calls the action.
 *
 * @category constructors
 * @since 1.0.0
 */
export const served = <
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires
>(
  action: Action.Declared<Tag, Payload, Success, Error, Requires>
): Flow.Flow<`${Tag}/remote`, Payload, Success, Error, Requires> => {
  const known = servedFlows.get(action)
  if (known !== undefined) return known as never
  const flow = Flow.make(`${action.name}/remote`, {
    payload: action.payloadSchema,
    success: action.successSchema,
    error: action.errorSchema,
    body: (payload) => action.call(payload as never)
  })
  servedFlows.set(action, flow)
  return flow as never
}

/**
 * Implements `action` with `body`, run where `placement` is bound.
 *
 * `Here` runs `body` in this process. `Proxy` runs `served(action)` on the
 * holder's engine under the action's invocation key, through
 * `FlowEngine/Placed.ts` `callRemote`: a lost transport is asked again under
 * that key, so the holder joins the run it recorded instead of running the
 * body again. A caller cancelled while the holder runs the body does not cancel
 * the holder's run: an action sees the cancellation its run had at dispatch,
 * so it cannot tell a later cancel from a shutdown that must rejoin. Place a `.child()` flow when a cancel must reach
 * the remote engine. A runtime that provides no invocation key is refused:
 * aliasing every call of one declaration onto one remote run would be worse.
 *
 * @category layers
 * @since 1.0.0
 */
export const layer = <
  Tag extends string,
  Payload extends Flow.AnyStructSchema,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Requires,
  R
>(
  action: Action.Declared<Tag, Payload, Success, Error, Requires>,
  placement: Placement.Placement,
  body: (payload: Payload["Type"]) => Effect.Effect<Success["Type"], Error["Type"], R>
) =>
  action.toLayer((payload) =>
    Effect.gen(function*() {
      const binding = (yield* Hosts).resolve(placement)
      if (binding._tag === "Here") return yield* body(payload)
      const key = yield* Action.CurrentInvocationKey
      /* v8 ignore next 5 -- every engine dispatch provides the key (`FlowEngine/Dispatch.ts`), so the guard only discharges the optional a runtime that has not adopted the seam would leave */
      if (key === undefined) {
        return yield* Effect.die(
          new Error(`${action.name} is placed elsewhere and was dispatched with no invocation key`)
        )
      }
      return (yield* callRemote(binding, served(action), {
        executionId: key,
        payload
      }))
    })
  )
