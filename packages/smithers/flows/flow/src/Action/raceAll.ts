// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Races actions through durable deferred execution.
 *
 * @since 0.1.0
 */

import type { NonEmptyReadonlyArray } from "effect/Array"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as DurableDeferred from "../DurableDeferred.ts"
import type { FlowInstance, FlowRuntime } from "../FlowRuntime/index.ts"
import type { Action, Any } from "./Action.ts"

/**
 * Runs a non-empty collection of actions as a durable race and returns the
 * first success using unioned success and error schemas. A losing failure is
 * ignored while another action is still running; the race fails only when
 * every action fails. To settle on whichever action exits first, success or
 * failure, race `Effect.exit` of each action and unwrap the winning exit.
 *
 * @category racing
 * @since 0.1.0
 */
export const raceAll = <const Actions extends NonEmptyReadonlyArray<Any>>(
  name: string,
  actions: Actions
): Effect.Effect<
  Actions[number] extends Action<infer _A, infer _E, infer _R> ? _A["Type"] : never,
  Actions[number] extends Action<infer _A, infer _E, infer _R> ? _E["Type"] : never,
  | Effect.Services<Actions[number]>
  | (Actions[number] extends Action<infer Success, infer Error, infer _R>
    ? Success["DecodingServices"] | Success["EncodingServices"] | Error["DecodingServices"] | Error["EncodingServices"]
    : never)
  | FlowRuntime
  | FlowInstance
> =>
  DurableDeferred.raceAll({
    name: `Action/${name}`,
    success: Schema.Union(
      actions.map((action) => (action as any).successSchema)
    ),
    error: Schema.Union(
      actions.map((action) => (action as any).errorSchema)
    ),
    effects: actions.map((action) => (action as any)) as any
  }) as any
