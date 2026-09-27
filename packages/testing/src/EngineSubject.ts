/**
 * The black-box engine *subject* seam used by conformance pins.
 *
 * This is the test-owned port: a pin drives an arbitrary engine implementation
 * through `run`/`result`/`interrupt`/`resume`/`journal` and asserts on the
 * journal it produced. It is deliberately distinct from the production harness
 * port `/harness/EngineLike` (`sealStep`/`splice`/`suspend`), which is
 * the seam the built-in harness *consumes*. The two are never interchangeable
 * and no longer share a name.
 *
 * Governing design: `packages/testing/docs/concepts/engine-subject.md`.
 *
 * @since 0.0.0
 */

import { Context, Effect, Layer } from "effect"
import type { EngineSubjectError } from "./TestingError.ts"
import { EngineUnavailableError } from "./TestingError.ts"

/**
 * One step of a conformance flow: either a body to run or a race between
 * branches.
 *
 * `sealed` selects the step's **identity**, not whether a replay may reuse a
 * recorded result: both kinds replay their recorded outcome. Sealed means
 * content identity, so every aliased occurrence of the key shares one recorded
 * result; unsealed means occurrence (ordinal) identity, so duplicate declared
 * keys run and journal separately. For a key that occurs once the two are
 * indistinguishable, which is why the earlier wording — "whether a replay may
 * reuse a recorded result" — read as a re-execution switch it never was.
 *
 * @category models
 * @since 0.0.0
 */
export type StepSpec =
  | {
    readonly key: string
    readonly sealed: boolean
    readonly kind: "step"
    /**
     * A pin-supplied step body. Its error channel is `unknown` because the
     * *pin* chooses the failure value it wants the subject to journal; it is
     * not a laundered engine error.
     */
    readonly run: (input: unknown) => Effect.Effect<unknown, unknown>
  }
  | {
    readonly key: string
    readonly sealed: boolean
    readonly kind: "race"
    readonly branches: ReadonlyArray<StepSpec>
  }

/**
 * A conformance flow, described only by its ordered steps. This is the
 * subject-neutral shape every engine under test is driven with.
 *
 * @category models
 * @since 0.0.0
 */
export interface FlowSpec {
  readonly name: string
  readonly steps: ReadonlyArray<StepSpec>
}

/**
 * One journal entry, in the shape the conformance assertions read. An
 * engine's own richer entry is projected onto this before comparison.
 *
 * @category models
 * @since 0.0.0
 */
export interface JournalEntryLike {
  readonly index: number
  readonly stepKey: string
  readonly kind: string
  readonly outcome: "completed" | "aborted" | "failed" | "suspended"
  readonly value?: unknown
}

/**
 * How one execution ended.
 *
 * @category models
 * @since 0.0.0
 */
export interface ExecutionResult {
  readonly executionId: string
  readonly status: "completed" | "aborted" | "failed" | "suspended"
  readonly value?: unknown
}

/**
 * The engine under test, reduced to what conformance needs: start, read a
 * result, interrupt, resume, and read the journal.
 *
 * @category services
 * @since 0.0.0
 */
export interface EngineSubject {
  readonly name: string
  readonly run: (options: {
    readonly flow: FlowSpec
    readonly payload: unknown
    readonly executionId?: string
    readonly idempotencyKey?: string
  }) => Effect.Effect<ExecutionResult, EngineSubjectError>
  readonly result: (executionId: string) => Effect.Effect<ExecutionResult, EngineSubjectError>
  readonly interrupt: (executionId: string) => Effect.Effect<void, EngineSubjectError>
  readonly resume: (executionId: string) => Effect.Effect<ExecutionResult, EngineSubjectError>
  readonly journal: (executionId: string) => Effect.Effect<ReadonlyArray<JournalEntryLike>, EngineSubjectError>
}

/**
 * The {@link EngineSubject} service tag.
 *
 * @category services
 * @since 0.0.0
 */
export const EngineSubject: Context.Service<EngineSubject, EngineSubject> = Context.Service(
  "flows/testing/EngineSubject"
)

/**
 * Builds an {@link EngineSubject} from an implementation of its methods.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (implementation: EngineSubject): EngineSubject => EngineSubject.of(implementation)

/**
 * Provides {@link EngineSubject} from an implementation.
 *
 * @category layers
 * @since 0.0.0
 */
export const layer = (implementation: EngineSubject): Layer.Layer<EngineSubject> =>
  Layer.succeed(EngineSubject)(make(implementation))

const unavailable = (operation: string): EngineUnavailableError =>
  new EngineUnavailableError({ message: `no engine subject is available for ${operation}` })

/**
 * An {@link EngineSubject} that fails every operation as unavailable.
 * Overrides replace individual methods.
 *
 * @category constructors
 * @since 0.0.0
 */
export const makeNoop = (overrides: Partial<EngineSubject> = {}): EngineSubject =>
  EngineSubject.of({
    name: "unavailable",
    run: () => Effect.fail(unavailable("run")),
    result: () => Effect.fail(unavailable("result")),
    interrupt: () => Effect.fail(unavailable("interrupt")),
    resume: () => Effect.fail(unavailable("resume")),
    journal: () => Effect.fail(unavailable("journal")),
    ...overrides
  })

/**
 * Provides {@link makeNoop}.
 *
 * @category layers
 * @since 0.0.0
 */
export const layerNoop = (overrides: Partial<EngineSubject> = {}): Layer.Layer<EngineSubject> =>
  Layer.succeed(EngineSubject)(makeNoop(overrides))
