/**
 * Runner-independent conformance cases for flow engine implementations.
 *
 * @since 0.0.0
 */

import type * as Effect from "effect/Effect"
import type { EngineSubject } from "./EngineSubject.ts"
import * as Identity from "./pins/Identity.ts"
import * as Interrupt from "./pins/Interrupt.ts"
import * as Race from "./pins/Race.ts"
import * as Replay from "./pins/Replay.ts"
import type { ConformanceViolation, EngineSubjectError } from "./TestingError.ts"

/**
 * A black-box assertion over an {@link EngineSubject} implementation.
 *
 * The error channel is the closed union every pin already produces, never
 * `unknown`: a subject that laundered a foreign cause into `unknown` could not
 * be matched on by the runner that reports it.
 *
 * @category models
 * @since 0.0.0
 */
export interface ConformanceCase {
  readonly name: string
  readonly run: (engine: EngineSubject) => Effect.Effect<void, ConformanceViolation | EngineSubjectError>
}

// Frozen at definition, case by case as well as as a list. `coreSuite()` with
// no filter used to hand back this very array, so a consumer could splice a
// mandatory pin out of the registry and every later call in the process
// returned the shortened list. Freezing only the array left the same hole one
// level down: the case records are shared objects, so assigning to a returned
// case's `run` replaced a mandatory pin's assertion for every later caller,
// and `ReadonlyArray`/`readonly` are erased at runtime.
const coreCases: ReadonlyArray<ConformanceCase> = Object.freeze(
  [
    ...Identity.cases,
    ...Interrupt.cases,
    ...Replay.cases,
    ...Race.cases
  ].map((conformanceCase) => Object.freeze({ ...conformanceCase }))
)

/**
 * Builds the mandatory black-box suite every `EngineSubject` must pass:
 * identity, interruption, replay, and race.
 *
 * This is the whole conformance vocabulary. A second entry point named
 * `suite`, documented as "the complete engine conformance suite" and returning
 * exactly these cases, was deleted rather than kept: two names for one list
 * claimed a superset that does not exist.
 *
 * The returned array is a frozen copy. `ReadonlyArray` is erased at runtime,
 * and losing a mandatory pin is the worst failure a conformance registry has.
 *
 * The race and interrupt cases advance time through `TestClock`, so a runner
 * must register them under a deterministic clock: `Vitest.testEffect(...)`
 * supplies one through `.effect` (and its `scoped` alias) but not through
 * `.live`.
 *
 * @category constructors
 * @since 0.0.0
 */
export const coreSuite = (options?: {
  readonly filter?: ((conformanceCase: ConformanceCase) => boolean) | undefined
}): ReadonlyArray<ConformanceCase> =>
  Object.freeze(options?.filter === undefined ? [...coreCases] : coreCases.filter(options.filter))
