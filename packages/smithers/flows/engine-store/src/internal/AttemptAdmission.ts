/**
 * The in-process attempt admission mutex.
 *
 * One instance lives per store incarnation (per `EngineStore.make`, alongside
 * the owner nonce). Every durable action dispatch holds the key's permit
 * for its whole admission-execute-finish span, so at most one fiber of this
 * process can be driving a given `(runId, stepKeyDigest, attempt)` at a time.
 *
 * That exclusion is the liveness evidence adoption needs (issues #86, #102,
 * #103): a persisted `running` row observed *while holding the key's permit*
 * cannot belong to a live fiber of this process — a live same-key dispatch
 * would be holding the permit — so it is crash or interruption evidence and
 * safe to adopt, whether the admitting incarnation was another process
 * (superseded by the run fence) or this very one (a dead fiber after an
 * in-process re-drive). The recorded incarnation nonce alone could not make
 * that distinction, which both let a TOCTOU window double-execute an
 * irreversible body (issue #102) and permanently failed a same-incarnation
 * re-drive with `AttemptAdmissionRejected` (issue #103).
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RcMap from "effect/RcMap"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"

/**
 * The single operation the admission mutex exposes: run something while
 * holding a key's exclusive permit.
 *
 * It is deliberately not a lock/unlock pair. Handing out a permit a caller
 * must remember to return would make an interrupted dispatch leak exclusion
 * for the rest of the process's life; a bracketing combinator cannot.
 *
 * @since 0.1.0
 * @category services
 */
export interface Service {
  /**
   * Runs `effect` while holding this process's exclusive permit for `key`.
   * Concurrent same-key callers wait; the permit is released on any exit,
   * including interruption.
   */
  readonly withPermit: (
    key: string
  ) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

/**
 * Constructs the keyed admission mutex synchronously.
 *
 * Gates are reference-counted and removed once no fiber holds or awaits
 * them, so the map does not grow with the number of distinct keys a
 * long-lived process dispatches.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeUnsafe = (): Service => {
  // One layer identity per incarnation; each operation borrows its owner
  // through a shared memo map, so the last operation releases the RcMap.
  const Locks = Context.Service<RcMap.RcMap<string, Semaphore.Semaphore>>("AttemptAdmission/Locks")
  const layer = Layer.effect(Locks, RcMap.make({ lookup: (_key: string) => Semaphore.make(1) }))
  const owners = Layer.makeMemoMapUnsafe()
  return {
    withPermit: (key) => (effect) =>
      Effect.scoped(Effect.gen(function*() {
        const services = yield* Layer.buildWithMemoMap(layer, owners, yield* Scope.Scope)
        const lock = yield* RcMap.get(Context.get(services, Locks), key)
        return yield* lock.withPermit(effect)
      }))
  }
}
