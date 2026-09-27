/**
 * Receiver for detected engine inconsistencies.
 *
 * Modeled on Skyframe's `GraphInconsistencyReceiver`: the store layer detects
 * an invariant violation — today, a content-addressed cache key that produced
 * a different result than the recorded row — and this service decides whether
 * the run fails or tolerates it. Either way the conflict is journaled, so the
 * detector is never wired to /dev/null.
 *
 * The `note` signature deliberately matches the plugin spec's
 * `cacheInconsistency` hook (`(event) => Effect<InconsistencyVerdict>`); the
 * strict layer is the future default plugin.
 *
 * The core default is strict so an invariant violation cannot pass silently.
 *
 * Governing designs: `docs/concepts/attempts-and-replay.md` and
 * `apps/site/src/content/docs/docs/concepts/flows-actions-plans.mdx`.
 *
 * @since 0.1.0
 */

import { FlowEngine } from "@smthrs/engine"
import { Journal } from "@smthrs/journal"
import type { Ownership } from "@smthrs/run-store"
import type { CacheStore } from "@smthrs/step-cache"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as JournalRecords from "./internal/JournalRecords.ts"

/**
 * Decision returned by an inconsistency receiver.
 *
 * @category models
 * @since 0.1.0
 */
export type InconsistencyVerdict = "fail" | "tolerate"

/**
 * A content-addressed cache key that produced a result different from the
 * recorded row — a hermeticity/determinism violation.
 *
 * @category models
 * @since 0.1.0
 */
export interface CacheConflict {
  readonly key: string
  readonly existing: CacheStore.CacheEntry | undefined
  readonly attempted: CacheStore.CacheEntry
}

/**
 * Recorded boundary evidence whose blob no longer hashes to its recorded
 * digest — on-disk corruption of the content-addressed store, detected while
 * replaying a verified cache hit or a succeeded attempt (issue #150).
 * Distinct from a transient host failure, which merely refuses the replay
 * and stays retryable.
 *
 * @category models
 * @since 0.1.0
 */
export interface BlobCorruption {
  /** The run that observed the corruption; the journaling target. */
  readonly runId: string
  readonly keyDigest: string
  readonly path: string
  readonly recordedDigest: string
  readonly measuredDigest: string
  /**
   * Provenance of the corrupt evidence when it came from a shared cache row;
   * absent when it came from this run's own succeeded attempt row.
   */
  readonly recordedRunId?: string | undefined
  readonly recordedEventSeq?: number | undefined
}

/**
 * Inconsistency receiver operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly note: (event: CacheConflict) => Effect.Effect<InconsistencyVerdict, Journal.JournalError>
  /**
   * Observes on-disk corruption of recorded boundary evidence (issue #150).
   * `"fail"` fails the dispatch; `"tolerate"` lets it fall back to a real
   * execution (which re-captures and heals the corrupt address).
   */
  readonly noteCorruption: (event: BlobCorruption) => Effect.Effect<InconsistencyVerdict, Journal.JournalError>
}

/**
 * Service tag for the engine inconsistency receiver.
 *
 * @category services
 * @since 0.1.0
 */
export class Inconsistency extends Context.Service<Inconsistency, Service>()("@smthrs/engine-store/Inconsistency") {}

/**
 * Options for constructing a journaling inconsistency receiver.
 *
 * @category models
 * @since 0.1.0
 */
export interface MakeOptions {
  readonly journal: Journal.Service
  readonly verdict: InconsistencyVerdict
  /**
   * The owner the conflict record is fenced to: a reclaimed run cannot append
   * hermeticity evidence it no longer owns. Required — every composer of this
   * receiver is a run's owner.
   */
  readonly owner: Ownership.OwnerId
}

/**
 * Builds a receiver that journals every conflict under the run that attempted
 * the write and returns a fixed verdict.
 *
 * The record goes through the journal's durable channel: a cache conflict is
 * hermeticity evidence, and a `tolerate` verdict that silently dropped its
 * only record would wire the detector to /dev/null (issue #10).
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: MakeOptions): Service => ({
  note: Effect.fn("Inconsistency.note")((event) =>
    Effect.as(
      options.journal.emitDurable(
        JournalRecords.cacheConflict(
          {
            runId: event.attempted.recordedRunId,
            sourceId: "flows/engine-store/inconsistency",
            lineageId: FlowEngine.Lineage.root(event.attempted.recordedRunId)
          },
          {
            // `@smthrs/journal` redacts the credential word `key`. A durable
            // content identity must use the specific, non-credential name.
            cacheKey: event.key,
            verdict: options.verdict,
            existing: event.existing === undefined ? null : {
              recordedRunId: event.existing.recordedRunId,
              recordedEventSeq: event.existing.recordedEventSeq,
              createdAtMs: event.existing.createdAtMs
            },
            attempted: {
              recordedRunId: event.attempted.recordedRunId,
              recordedEventSeq: event.attempted.recordedEventSeq,
              createdAtMs: event.attempted.createdAtMs
            }
          }
        ),
        options.owner
      ),
      options.verdict
    )
  ),
  noteCorruption: Effect.fn("Inconsistency.noteCorruption")((event) =>
    Effect.as(
      options.journal.emitDurable(
        JournalRecords.cacheCorruption(
          {
            runId: event.runId,
            lineageId: FlowEngine.Lineage.root(event.runId),
            // The producer identity is the corruption evidence plus the
            // recorded row generation (issues #156, #172): a caller
            // re-observing the same corrupt row re-emits an exact producer
            // duplicate the journal collapses, while an identically corrupt
            // row recorded after eviction and healing has new provenance and
            // lands as a distinct incident. Attempt-row evidence has no cache
            // provenance, so its explicit local markers retain same-row
            // convergence. A record already landed by another lineage under
            // this identity surfaces as an idempotency conflict; either way
            // evidence for that row generation exists exactly once.
            sourceId:
              `flows/engine-store/inconsistency:corruption:${event.keyDigest}:${event.path}:${event.recordedDigest}:${event.measuredDigest}:${
                event.recordedRunId ?? "local"
              }:${event.recordedEventSeq ?? "local"}`,
            sourceSeq: 0
          },
          {
            keyDigest: event.keyDigest,
            verdict: options.verdict,
            path: event.path,
            recordedDigest: event.recordedDigest,
            measuredDigest: event.measuredDigest,
            recordedRunId: event.recordedRunId ?? null,
            recordedEventSeq: event.recordedEventSeq ?? null
          }
        ),
        options.owner
      ).pipe(
        Effect.catch((error) => error.code === "idempotency_conflict" ? Effect.succeed(undefined) : Effect.fail(error))
      ),
      options.verdict
    )
  )
})

/**
 * Builds a receiver from overrides. The default notes nothing and tolerates.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => ({
  note: Effect.fn("Inconsistency.note")(() => Effect.succeed("tolerate" as const)),
  noteCorruption: Effect.fn("Inconsistency.noteCorruption")(() => Effect.succeed("tolerate" as const)),
  ...overrides
})

/**
 * Provides a receiver that never journals and always tolerates.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<Inconsistency> =>
  Layer.succeed(Inconsistency)(makeNoop(overrides))

/**
 * Journals every cache conflict and fails the run. This is the default
 * receiver for engine wiring: a non-hermetic sealed hard-boundary action is
 * a defect, not a condition to paper over.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerStrict = (owner: Ownership.OwnerId): Layer.Layer<Inconsistency, never, Journal.Journal> =>
  Layer.effect(Inconsistency)(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      return make({ journal, verdict: "fail", owner })
    })
  )

/**
 * Journals every cache conflict and continues, preserving the first-recorded
 * row (Skyframe's tolerant production configuration).
 *
 * @category layers
 * @since 0.1.0
 */
export const layerTolerant = (owner: Ownership.OwnerId): Layer.Layer<Inconsistency, never, Journal.Journal> =>
  Layer.effect(Inconsistency)(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      return make({ journal, verdict: "tolerate", owner })
    })
  )
