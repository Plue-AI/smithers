/**
 * Effect-boundary evidence, emitted by the engine at the point an irreversible
 * action crosses into the outside world.
 *
 * Time travel (`packages/smithers/flows/time-travel/docs/README.md`) requires one durable
 * journal entry recorded **before the adapter begins**, whose status then moves
 * only forward (`intended` → `succeeded` | `unknown`). Rewind reads exactly
 * these records to classify the doomed suffix as blocking, revertible, or
 * warning; nothing else in the journal can answer that question, because an
 * attempt row says an attempt happened, not that an effect left the machine.
 *
 * ## Why the shape lives here and not in `@smthrs/time-travel`
 *
 * `@smthrs/time-travel` depends on `@smthrs/engine-store` (it decodes
 * `RunState`), so the arrow cannot be reversed without a cycle. The record is
 * therefore a **wire contract**, not a shared type: this module writes the
 * shape `EffectBoundary.decodeEntry` reads, under the event type that module
 * owns, and `packages/smithers/flows/time-travel/test/EngineIntegration.test.ts` pins the two
 * together by rewinding across a boundary record this module produced.
 *
 * ## One producer identity, two channels that must not double-count
 *
 * An irreversible dispatch now writes on two channels: the attempt lifecycle
 * (`attempt-started` / `attempt-finished`), which says a durable attempt row
 * moved, and this boundary (`intended` / terminal), which says an external
 * effect was begun and how it settled. They are deliberately NOT merged —
 * an attempt is retried under new numbers while an effect keeps one identity —
 * and they cannot double-count, because a rewind's suffix scan matches only
 * {@link eventType}. The two are tied by construction: the effect id IS the
 * attempt identity (`runId:keyDigest:attempt`), so every boundary record names
 * the attempt row that produced it and the audit reads as one story.
 *
 * @since 0.1.0
 */

import { JournalEvent } from "@smthrs/journal"

/**
 * The event type `@smthrs/time-travel` decodes boundary evidence from.
 *
 * Duplicated deliberately rather than imported: see the module note.
 *
 * @since 0.1.0
 * @category constants
 */
export const eventType = "flows.time-travel.effect-boundary"

/**
 * Monotonic completion evidence recorded around an effect.
 *
 * @since 0.1.0
 * @category models
 */
export type Status = "intended" | "succeeded" | "unknown"

/**
 * What the engine knows about an effect before it begins.
 *
 * @since 0.1.0
 * @category models
 */
export interface Descriptor {
  readonly id: string
  readonly kind: string
  readonly tier: "sealed" | "compensable" | "irreversible"
  readonly runId: string
  readonly lineageId: string
  readonly sourceId: string
  readonly attempt: number
  readonly idempotencyKey?: string | undefined
  readonly cacheKey?: string | undefined
  readonly changeId?: string | undefined
  /**
   * The stable compensation descriptor the adapter owns, when it declares one.
   * Time travel puts it in the entry so a
   * rewind's handler resolution is a lookup over recorded evidence rather than
   * a guess from the effect kind alone.
   */
  readonly compensation?: string | undefined
  readonly residue?: string | undefined
}

/**
 * Builds one boundary record for `descriptor` at `status`.
 *
 * Every effect and status pair gets its own producer identity: the status is
 * appended to `descriptor.sourceId`, and every boundary record carries
 * sourceSeq 0. Re-emitting the same status for the same effect therefore
 * reuses that `(sourceId, sourceSeq)` pair, so a replay collapses into a
 * journal `Duplicate` instead of appending a second boundary row, the same
 * convergence the attempt lifecycle records rely on.
 *
 * @since 0.1.0
 * @category constructors
 */
export const boundary = (
  descriptor: Descriptor,
  status: Status,
  output?: unknown
): JournalEvent.Input =>
  new JournalEvent.Input({
    runId: descriptor.runId as JournalEvent.RunId,
    sourceId: `${descriptor.sourceId}:effect:${descriptor.id}:${status}` as JournalEvent.SourceId,
    sourceSeq: 0 as JournalEvent.SourceSeq,
    eventType,
    payload: {
      version: 1,
      effect: {
        id: descriptor.id,
        kind: descriptor.kind,
        tier: descriptor.tier,
        status,
        runId: descriptor.runId,
        lineageId: descriptor.lineageId,
        attempt: descriptor.attempt,
        durableBoundary: true,
        providerStream: false,
        ...(output === undefined ? {} : { output }),
        ...(descriptor.idempotencyKey === undefined ? {} : { idempotencyKey: descriptor.idempotencyKey }),
        ...(descriptor.cacheKey === undefined ? {} : { cacheKey: descriptor.cacheKey }),
        ...(descriptor.changeId === undefined ? {} : { changeId: descriptor.changeId }),
        ...(descriptor.compensation === undefined ? {} : { compensation: descriptor.compensation }),
        ...(descriptor.residue === undefined ? {} : { residue: descriptor.residue })
      }
    },
    meta: {
      lineageId: descriptor.lineageId,
      ...(descriptor.cacheKey === undefined ? {} : { cacheKey: descriptor.cacheKey }),
      timeTravel: {
        effectId: descriptor.id,
        kind: descriptor.kind,
        tier: descriptor.tier,
        status
      }
    }
  })
