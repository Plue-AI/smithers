/**
 * Time travel over the journal: replay, inspect, fork, rewind.
 *
 * The verbs are reached through ONE injectable service. `Replay`, `Fork`,
 * `Rewind`, `Recovery`, `Compensation`, and the effect-handler registry are
 * machinery under `src/internal/` — the same way every other
 * package here hides the modules a caller should never name — and the package
 * blocks `@smthrs/time-travel/internal/*` at its `exports` map.
 *
 * ```ts
 * import { Engine } from "@smthrs/flows"
 * import { MemoryTimeTravelStore, TimeTravel } from "@smthrs/time-travel"
 * import * as Effect from "effect/Effect"
 *
 * const program = Effect.gen(function*() {
 *   const timeTravel = yield* TimeTravel
 *   const lineageId = Engine.FlowEngine.Lineage.root("analyse-1")
 *   return yield* timeTravel.fork({ runId: "analyse-1", frame: { lineageId, seq: 4 } })
 * })
 * ```
 *
 * A lineage id is MINTED, never spelled. `FlowEngine.Lineage` is the one
 * constructor for it, the engine stamps its result on every record a run
 * writes, and the encoding is versioned and has already changed once. This
 * package only ever stores and compares the value, so it takes no dependency on
 * the engine; the example above reaches the constructor through `@smthrs/flows`,
 * the barrel a caller already installs. Reading `meta.lineageId` off any entry
 * the run committed is the other route, and the one a viewer takes when it
 * holds records rather than a run id.
 *
 * `TimeTravel` is exported FLAT rather than as a namespace, the way
 * `@smthrs/jj` exports its service module: the service key is the door, so
 * `yield* TimeTravel` — and `yield* Flows.TimeTravel` from the umbrella —
 * is the whole onboarding. `TimeTravel.layer` provides it.
 *
 * What stays public beside it is what a caller injects or integrates with: the
 * frame address, the error, the store contract and its two implementations,
 * `EffectBoundary` — the producer-side API engine code calls to journal an
 * effect so a rewind can assess it — `CompensationHandlers`, the door a
 * composition contributes its adapters' compensations through, and
 * `Migrations`, the ladder rung for a composition that migrates the schema
 * itself rather than letting the store create its own tables.
 *
 * @since 0.1.0
 */

/**
 * @category services
 * @since 0.1.0
 */
export { ReadOnlyTimeTravel, TimeTravel } from "./TimeTravel.ts"

/**
 * The `TimeTravel` module's types, re-exported so a caller annotates a
 * signature without reaching for the `@smthrs/time-travel/TimeTravel` subpath.
 *
 * @category models
 * @since 1.0.0
 */
export type {
  ForkOptions,
  ForkOverride,
  ForkResult,
  InputOverride,
  Options,
  OverrideSchema,
  Position,
  Projection,
  RateLimitDecision,
  ReplayOptions,
  RewindOptions,
  RewindResult,
  SealedResultOverride,
  Service
} from "./TimeTravel.ts"

/**
 * The derived fork workspace name and the default history cap, beside the
 * service key that reads them.
 *
 * @category constructors
 * @since 1.0.0
 */
export { defaultMaxHistoryEntries, forkWorkspaceName } from "./TimeTravel.ts"

/**
 * @category models
 * @since 0.1.0
 */
export * as Frame from "./Frame.ts"

/**
 * @category errors
 * @since 0.1.0
 */
export * as TimeTravelError from "./TimeTravelError.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as TimeTravelStore from "./TimeTravelStore.ts"

/**
 * @category layers
 * @since 0.1.0
 */
export * as MemoryTimeTravelStore from "./MemoryTimeTravelStore.ts"

/**
 * @category layers
 * @since 0.1.0
 */
export * as SqlTimeTravelStore from "./SqlTimeTravelStore.ts"

/**
 * @category models
 * @since 0.1.0
 */
export * as EffectBoundary from "./EffectBoundary.ts"

/**
 * @category services
 * @since 0.1.0
 */
export * as CompensationHandlers from "./CompensationHandlers.ts"

/**
 * @category migrations
 * @since 0.1.0
 */
export * as Migrations from "./Migrations.ts"
