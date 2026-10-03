/**
 * Journaled execution boundary for tiered effects.
 *
 * @since 0.1.0
 */

import { EventTypes } from "@smthrs/engine-store/EventTypes"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import { OwnerId } from "@smthrs/journal/OwnerId"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Schema from "effect/Schema"
import { error, type TimeTravelError } from "./TimeTravelError.ts"

/**
 * The three effect tiers used by replay, compensation, and retry.
 *
 * @since 0.1.0
 * @category models
 */
export const EffectTier = Schema.Literals(["sealed", "compensable", "irreversible"])
/**
 * The value form of {@link EffectTier}.
 *
 * @since 0.1.0
 * @category models
 */
export type EffectTier = typeof EffectTier.Type

/**
 * Monotonic completion evidence recorded around an effect.
 *
 * @since 0.1.0
 * @category models
 */
export const EffectStatus = Schema.Literals(["intended", "succeeded", "unknown"])
/**
 * The value form of {@link EffectStatus}.
 *
 * @since 0.1.0
 * @category models
 */
export type EffectStatus = typeof EffectStatus.Type

/**
 * Stable event type emitted for effect-boundary evidence.
 *
 * @since 0.1.0
 * @category constants
 */
export const eventType = "flows.time-travel.effect-boundary"

/**
 * The evidence one effect carries across its boundary.
 *
 * {@link EffectRecord}, {@link Description}, and the persisted `BoundaryRecord`
 * are the same effect at three points in its life, so they share this field
 * list and each adds only what its own end knows.
 */
const effectFields = {
  id: Schema.NonEmptyString,
  kind: Schema.NonEmptyString,
  tier: EffectTier,
  runId: Schema.NonEmptyString,
  lineageId: Schema.NonEmptyString,
  input: Schema.optionalKey(Schema.Unknown),
  cacheKey: Schema.optionalKey(Schema.NonEmptyString),
  changeId: Schema.optionalKey(Schema.NonEmptyString),
  idempotencyKey: Schema.optionalKey(Schema.NonEmptyString),
  /**
   * The stable compensation descriptor the adapter that performed this effect
   * owns. It lives in the entry so a rewind's handler preflight resolves against recorded evidence
   * rather than inferring a compensation from the effect kind alone.
   */
  compensation: Schema.optionalKey(Schema.NonEmptyString),
  residue: Schema.optionalKey(Schema.String),
  attempt: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  nonce: Schema.optionalKey(Schema.NonEmptyString)
} as const

/**
 * A normalized effect reconstructed from boundary journal entries.
 *
 * A reader knows everything a description carries plus the journal's own
 * evidence: the recorded `status`, the `seq` it was recorded at, the terminal
 * `output`, and the two booleans a decode resolves to their defaults.
 *
 * @since 0.1.0
 * @category models
 */
export const EffectRecord = Schema.Struct({
  ...effectFields,
  status: EffectStatus,
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  output: Schema.optionalKey(Schema.Unknown),
  durableBoundary: Schema.Boolean,
  providerStream: Schema.Boolean
})
/**
 * The value form of {@link EffectRecord}.
 *
 * @since 0.1.0
 * @category models
 */
export type EffectRecord = typeof EffectRecord.Type

/**
 * Description supplied before an action crosses its effect boundary.
 *
 * A producer knows who owns the write and where it sits in the source stream,
 * may carry additive `metadata` for the journal entry, and may leave the two
 * booleans to their defaults; it never supplies journal evidence.
 *
 * @since 0.1.0
 * @category models
 */
export const Description = Schema.Struct({
  ...effectFields,
  owner: OwnerId,
  sourceId: Schema.NonEmptyString,
  sourceSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  durableBoundary: Schema.optionalKey(Schema.Boolean),
  providerStream: Schema.optionalKey(Schema.Boolean),
  metadata: Schema.optionalKey(Schema.Unknown)
})
/**
 * The value form of {@link Description}.
 *
 * @since 0.1.0
 * @category models
 */
export type Description = typeof Description.Type

/**
 * Effect kinds only the engine journals. Lineage edges are derived from the
 * child-spawn kind, and a rewind archives and deletes every attached child an
 * edge names, so a guarded action must never record one.
 */
const reservedKinds: ReadonlySet<string> = new Set([EventTypes.childSpawnKind])

const Metadata = Schema.Record(Schema.String, Schema.Unknown)
const isMetadata = Schema.is(Metadata)

/**
 * A caller's additive metadata, merged into the journal entry's `meta`.
 *
 * A record merges field by field. A non-record value a caller still wants
 * carried is nested under `upstream` rather than dropped, and no metadata at
 * all contributes no key, so an unset description never writes
 * `upstream: undefined` into every boundary entry.
 */
const additive = (description: Description): Readonly<Record<string, unknown>> => {
  if (description.metadata === undefined) return {}
  return isMetadata(description.metadata) ? description.metadata : { upstream: description.metadata }
}

const metadata = (
  description: Description,
  status: EffectStatus
): Readonly<Record<string, unknown>> => ({
  ...additive(description),
  lineageId: description.lineageId,
  ...(description.cacheKey === undefined ? {} : { cacheKey: description.cacheKey }),
  timeTravel: {
    effectId: description.id,
    kind: description.kind,
    tier: description.tier,
    status
  }
})

const record = (
  description: Description,
  status: EffectStatus,
  output?: unknown
): Omit<EffectRecord, "seq"> => ({
  id: description.id,
  kind: description.kind,
  tier: description.tier,
  status,
  runId: description.runId,
  lineageId: description.lineageId,
  ...(description.input === undefined ? {} : { input: description.input }),
  ...(output === undefined ? {} : { output }),
  ...(description.cacheKey === undefined ? {} : { cacheKey: description.cacheKey }),
  ...(description.changeId === undefined ? {} : { changeId: description.changeId }),
  ...(description.idempotencyKey === undefined ? {} : { idempotencyKey: description.idempotencyKey }),
  ...(description.residue === undefined ? {} : { residue: description.residue }),
  ...(description.compensation === undefined ? {} : { compensation: description.compensation }),
  durableBoundary: description.durableBoundary ?? true,
  providerStream: description.providerStream ?? false,
  ...(description.attempt === undefined ? {} : { attempt: description.attempt }),
  ...(description.nonce === undefined ? {} : { nonce: description.nonce })
})

const emit = (
  journal: Journal.Service,
  description: Description,
  status: EffectStatus,
  output?: unknown
): Effect.Effect<Journal.DurableReceipt, TimeTravelError> => {
  const sourceSeq = (description.sourceSeq + (status === "intended" ? 0 : 1)) as JournalEvent.SourceSeq
  const input: JournalEvent.Input = {
    runId: description.runId as JournalEvent.RunId,
    sourceId: description.sourceId as JournalEvent.SourceId,
    sourceSeq,
    eventType,
    payload: { version: 1, effect: record(description, status, output) },
    meta: metadata(description, status)
  }
  return journal.emitDurable(input, description.owner).pipe(
    Effect.mapError((cause) =>
      error("unknown", `could not record ${status} boundary for effect ${description.id}`, cause)
    )
  )
}

/**
 * Runs an action between durable `intended` and terminal boundary records.
 *
 * Interruption, defects, and typed failures all settle the boundary as
 * `unknown` before their original cause is re-raised. The settlement section
 * is uninterruptible so cancellation cannot strand an in-memory action
 * after it has crossed the boundary without attempting the terminal record.
 * A kind the engine reserves, such as `EventTypes.childSpawnKind`, fails as
 * `invalid` before anything is journaled.
 *
 * @since 0.1.0
 * @category combinators
 */
export const guard = <A, E, R>(
  description: Description,
  action: Effect.Effect<A, E, R>
): Effect.Effect<A, E | TimeTravelError, R | Journal.Journal> =>
  Effect.gen(function*() {
    const validated = yield* Schema.decodeUnknownEffect(Description)(description).pipe(
      Effect.mapError((cause) => error("invalid", "effect boundary description is invalid", cause))
    )
    if (reservedKinds.has(validated.kind)) {
      return yield* Effect.fail(error("invalid", `effect ${validated.id} uses the reserved kind ${validated.kind}`))
    }
    if (validated.sourceSeq === Number.MAX_SAFE_INTEGER) {
      return yield* Effect.fail(error("invalid", `effect ${validated.id} has no terminal source sequence`))
    }
    if (validated.tier === "irreversible" && validated.idempotencyKey === undefined) {
      return yield* Effect.fail(
        error("invalid", `irreversible effect ${validated.id} requires an idempotency key`)
      )
    }
    const journal = yield* Journal.Journal
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function*() {
        const intended = yield* emit(journal, validated, "intended")
        if (intended._tag === "Duplicate") {
          // `already_crossed` rather than `busy`: the closed code list exists so
          // a caller can branch on WHY, and `busy` is the code a contended run
          // raises. A re-armed effect and a rewind holding the run are different
          // answers to "why was this refused", and they need different codes.
          return yield* Effect.fail(
            error(
              "already_crossed",
              `effect ${validated.id} already crossed its durable boundary; refusing to execute it again`
            )
          )
        }
        const actionExit = yield* Effect.exit(restore(action))
        if (Exit.isSuccess(actionExit)) {
          yield* emit(journal, validated, "succeeded", actionExit.value)
          return actionExit.value
        }
        yield* emit(journal, validated, "unknown").pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("time-travel: failed to persist unknown effect boundary", cause).pipe(
              Effect.annotateLogs({ runId: validated.runId, step: validated.id })
            )
          )
        )
        return yield* Effect.failCause(actionExit.cause)
      })
    )
  })

const BoundaryRecord = Schema.Struct({
  ...effectFields,
  status: EffectStatus,
  output: Schema.optionalKey(Schema.Unknown),
  durableBoundary: Schema.optionalKey(Schema.Boolean),
  providerStream: Schema.optionalKey(Schema.Boolean)
})
const BoundaryPayload = Schema.Struct({
  version: Schema.Literal(1),
  effect: BoundaryRecord
})

/**
 * Decodes one boundary record from a journal entry, failing closed when its
 * durable payload is corrupt.
 *
 * An entry of another event type answers `undefined` so this projection stays
 * forward-compatible over a shared journal, but a corrupt record under this
 * module's own event type is evidence a rewind must not read past.
 *
 * @since 0.1.0
 * @category decoders
 */
export const decodeEntry = (
  entry: JournalEvent.Entry
): Effect.Effect<EffectRecord | undefined, TimeTravelError> => {
  if (entry.eventType !== eventType) return Effect.succeed(undefined)
  return Schema.decodeUnknownEffect(BoundaryPayload)(entry.payload).pipe(
    Effect.map(({ effect }) => ({
      ...effect,
      seq: entry.seq,
      durableBoundary: effect.durableBoundary !== false,
      providerStream: effect.providerStream === true
    })),
    Effect.mapError((cause) =>
      error("invalid", `boundary event ${entry.eventId} has an invalid or unsupported payload`, cause)
    )
  )
}

/**
 * The fields every record of one effect must agree on: every {@link EffectRecord}
 * field except the ones a legal crossing is allowed to change.
 *
 * `guard` writes the `intended` and the terminal record from one
 * {@link Description}, so a disagreement here means two different effects
 * share an id, or a record was rewritten. `id` groups the records and `seq`
 * and `status` are what the fold is comparing. `input`, `output`, and
 * `residue` are outside the list on purpose: `output` exists only on the
 * terminal record, and the other two are disclosure, not identity.
 */
const foldedFields = new Set(["id", "seq", "status", "input", "output", "residue"])
const identityFields = Object.keys(EffectRecord.fields).filter((field) => !foldedFields.has(field)) as ReadonlyArray<
  keyof EffectRecord
>

const conflict = (id: string, detail: string): TimeTravelError =>
  error("invalid", `effect ${id} has conflicting boundary evidence: ${detail}`)

/**
 * Folds decoded boundary records to one record per effect, refusing evidence
 * that does not describe one monotonic crossing.
 *
 * The legal history of one effect id, in `seq` order, is an `intended` record
 * followed by at most one terminal record, `succeeded` or `unknown`, with
 * exact duplicates of either tolerated because a reader can page the same
 * record twice. Everything else fails closed as `invalid`: two terminals, a
 * terminal followed by `intended`, two records at one `seq` that disagree, or
 * two records whose identity fields differ. The fold used to keep whichever
 * record the caller listed last, so a conflicted or reordered journal could
 * turn an `unknown` outcome, which must block a rewind, into a `succeeded` one
 * a handler would compensate before its evidence was truncated.
 *
 * @since 0.1.0
 * @category projections
 */
export const fromRecords = (
  records: ReadonlyArray<EffectRecord>
): Effect.Effect<ReadonlyArray<EffectRecord>, TimeTravelError> =>
  Effect.gen(function*() {
    const grouped = new Map<string, Array<EffectRecord>>()
    for (const record of records) {
      const group = grouped.get(record.id)
      if (group === undefined) grouped.set(record.id, [record])
      else group.push(record)
    }
    const folded: Array<EffectRecord> = []
    for (const [id, group] of grouped) {
      group.sort((left, right) => left.seq - right.seq)
      let latest = group[0]!
      for (const next of group.slice(1)) {
        for (const field of identityFields) {
          if (latest[field] !== next[field]) {
            return yield* Effect.fail(
              conflict(
                id,
                `${field} is ${String(latest[field])} at seq ${latest.seq} and ` +
                  `${String(next[field])} at seq ${next.seq}`
              )
            )
          }
        }
        if (next.seq === latest.seq) {
          if (next.status !== latest.status) {
            return yield* Effect.fail(
              conflict(id, `records at seq ${next.seq} report both ${latest.status} and ${next.status}`)
            )
          }
          continue
        }
        if (latest.status !== "intended") {
          return yield* Effect.fail(
            conflict(id, `${next.status} at seq ${next.seq} follows terminal ${latest.status} at seq ${latest.seq}`)
          )
        }
        if (next.status === "intended") {
          return yield* Effect.fail(
            conflict(id, `intended at seq ${next.seq} repeats intended at seq ${latest.seq}`)
          )
        }
        latest = next
      }
      folded.push(latest)
    }
    return folded.sort((left, right) => left.seq - right.seq)
  })

/**
 * Decodes boundary entries and folds them with {@link fromRecords}: one record
 * per effect, at the effect's latest legal status, ordered by `seq`.
 *
 * @since 0.1.0
 * @category projections
 */
export const fromEntries = (
  entries: ReadonlyArray<JournalEvent.Entry>
): Effect.Effect<ReadonlyArray<EffectRecord>, TimeTravelError> =>
  Effect.gen(function*() {
    const records: Array<EffectRecord> = []
    for (const entry of entries) {
      const decoded = yield* decodeEntry(entry)
      if (decoded !== undefined) records.push(decoded)
    }
    return yield* fromRecords(records)
  })
