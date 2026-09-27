// Deep reviewed and polished by a human on 2026-08-10.

/**
 * Retries effects while preserving durable action identity.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import { dual } from "effect/Function"
import type * as Types from "effect/Types"
import { CurrentAttempt, CurrentOrdinal, type OrdinalSlot } from "./Context.ts"

/**
 * Retries an effect with `Effect.retry` while updating `CurrentAttempt` for
 * each attempt.
 *
 * @category error handling
 * @since 0.1.0
 */
export const retry: {
  <E, O extends Types.NoExcessProperties<Omit<Effect.Retry.Options<E>, "schedule">, O>>(
    options: O
  ): <A, R>(self: Effect.Effect<A, E, R>) => Effect.Retry.Return<R, E, A, O>
  <A, E, R, O extends Types.NoExcessProperties<Omit<Effect.Retry.Options<E>, "schedule">, O>>(
    self: Effect.Effect<A, E, R>,
    options: O
  ): Effect.Retry.Return<R, E, A, O>
} = dual(
  2,
  (effect: Effect.Effect<any, any, any>, options: object) =>
    Effect.gen(function*() {
      // A nested retry block shares the enclosing block's slot instead of
      // shadowing it with a fresh one (issue #108): a per-invocation slot was
      // rebuilt on every outer attempt, discarding the pinned `values`, so a
      // completed irreversible inner dispatch drew a brand-new ordinal — a
      // new step key — and re-executed instead of replaying. Sharing the
      // outermost slot keeps every pin alive for the whole outer sequence.
      const enclosing = yield* CurrentOrdinal
      // One `values` map for the whole retry sequence: the engine fills each
      // action's scope with the ordinal it allocates on the first attempt,
      // and every later attempt of the same sequence reuses those ordinals
      // (issues #73, #84). The `cursors` map, however, is *per block*
      // (issue #116): #108 shared the enclosing block's mutable cursor map
      // wholesale, so a sibling block's attempt boundary — sanctioned to run
      // concurrently under keyed overlap (issue #111) — cleared every
      // scope's cursor and rewound another block's mid-flight dispatch onto
      // an already-consumed pinned ordinal, a duplicate step key. Each block
      // now owns a private cursor view seeded from the enclosing block's
      // cursors at entry, so its attempt boundaries reset only its own view.
      const slot: OrdinalSlot = {
        values: enclosing?.values ?? new Map(),
        cursors: new Map(enclosing?.cursors)
      }
      // Where each scope's dispatch cursor stood when this block was entered.
      // An inner attempt replays the block from its own first dispatch, not
      // from the outer attempt's start, so its cursors rewind to the block
      // entry rather than to zero (issues #100, #108). At the top level the
      // snapshot is empty and rewinding degenerates to a plain reset.
      const entryCursors = new Map(slot.cursors)
      let attempt = 1
      return yield* Effect.suspend(() => {
        // Every attempt replays the block from its first dispatch, so the
        // per-scope dispatch cursors restart with it (issue #100); the pinned
        // ordinal sequences in `values` persist across attempts.
        slot.cursors.clear()
        for (const [scope, cursor] of entryCursors) {
          slot.cursors.set(scope, cursor)
        }
        return effect.pipe(
          Effect.provideService(CurrentAttempt, attempt++),
          Effect.provideService(CurrentOrdinal, slot)
        )
      }).pipe(
        Effect.retry(options),
        // On exit, fold this block's final cursor positions back into the
        // enclosing block's view (max-merge, so a concurrent sibling's later
        // propagation never rewinds a scope): an enclosing dispatch of a
        // scope this block consumed must take the next pinned position, not
        // re-consume this block's ordinals.
        Effect.onExit(() =>
          Effect.sync(() => {
            if (enclosing === undefined) return
            for (const [scope, cursor] of slot.cursors) {
              const current = enclosing.cursors.get(scope) ?? 0
              if (cursor > current) enclosing.cursors.set(scope, cursor)
            }
          })
        )
      )
    })
)
