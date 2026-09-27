/**
 * Private read-side bridge between the existing engine and control journals.
 * @since 1.0.0
 */

import * as Sha256 from "@smthrs/crypto/Sha256"
import type * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, PubSub, Semaphore } from "effect"

/**
 * Existing host services and an already-authorized native root.
 * @since 1.0.0
 * @private
 */
export interface Options {
  readonly controlRunId: string
  readonly executionId: string
  readonly engineJournal: Journal.Service
  readonly controlJournal: Journal.Service
  readonly engineState: Pick<DurableEngineState.Service, "runChildren">
  /** Native trampoline membership, separate from spawn edges. Legacy adapters may omit it. */
  readonly runLineage?: RunStore.Service["lineage"] | undefined
  /**
   * Called with each native record BEFORE that record is copied into the
   * control journal.
   *
   * The order is the guarantee: a client reading the copied record can act on
   * what it says, because the host already has. A copy-back receipt naming
   * `flows/<id>/flow.ts` is the case that needs it — the host rebuilds that
   * flow's executable first, so the plan a client asks for on seeing the
   * receipt is a plan this host can answer.
   *
   * It fires again for the same record when an interrupted observation is
   * recovered, since recovery rereads its pages. Handlers are therefore
   * expected to be repeatable. Failures here are the caller's to absorb; the
   * projection's own progress does not depend on them.
   */
  readonly onRecord?:
    | ((entry: JournalEvent.Entry, generation: number) => Effect.Effect<void>)
    | undefined
}

interface Position {
  readonly generation: number
  readonly sequence: number
}

const pageSize = 256
/**
 * Recorded native envelope in the control run's open event payload.
 * @since 1.0.0
 * @private
 */
export const eventKind = "control.engine.event"
/**
 * Missing or discontinuous native evidence, distinct from execution results.
 * @since 1.0.0
 * @private
 */
export const gapKind = "control.engine.projection-gap"
const producer = (identity: ReadonlyArray<unknown>): JournalEvent.SourceId =>
  `engine-projection:${Sha256.digestSync(JSON.stringify(identity))}` as JournalEvent.SourceId

/**
 * The caller establishes ownership of the native root. This helper reads only
 * that root and its durable child edges; it never guesses ancestry from IDs.
 * Run its reads outside any native transaction context so they cannot observe
 * the caller's uncommitted writes. The host supervisor supplies a clean context.
 * No durable cursor is introduced: restarting rereads pages and exact source
 * identities deduplicate against the destination journal's existing index.
 * @since 1.0.0
 * @private
 */
export const make = (options: Options) =>
  Effect.gen(function*() {
    const gate = yield* Semaphore.make(1)
    const positions = new Map<string, Position>()
    const target = options.controlRunId as JournalEvent.RunId

    const gap = (executionId: string, generation: number | null, detail: Readonly<Record<string, unknown>>) =>
      options.controlJournal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: target,
          sourceId: producer(["gap", executionId, generation, detail]),
          sourceSeq: 0 as JournalEvent.SourceSeq,
          eventType: gapKind,
          payload: { executionId, generation, ...detail },
          meta: { engineProjection: { version: 1, executionId, generation } }
        })
      )

    const copy = (entry: JournalEvent.Entry, generation: number) =>
      options.controlJournal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: target,
          // Native seq is global within a run, unlike sourceSeq, which repeats
          // across native producers. A rewind starts another producer generation.
          sourceId: producer(["event", entry.runId, generation]),
          sourceSeq: entry.seq as number as JournalEvent.SourceSeq,
          eventType: eventKind,
          // ControlEvent projects payload but not Journal.meta. Keep the native
          // envelope here; interpreting a child's decision as the control root's
          // own lifecycle would corrupt generic ancestry/monitor projections.
          payload: {
            version: 1,
            executionId: entry.runId,
            generation,
            sequence: entry.seq,
            eventId: entry.eventId,
            sourceId: entry.sourceId,
            sourceSequence: entry.sourceSeq,
            emittedAtMs: entry.emittedAtMs,
            eventType: entry.eventType,
            payload: entry.payload,
            meta: entry.meta
          }
        })
      )

    const readRun = (executionId: string): Effect.Effect<void, Journal.JournalError> =>
      Effect.gen(function*() {
        const runId = executionId as JournalEvent.RunId
        for (;;) {
          // A native rewind advances generation atomically with truncation.
          // Bracket the page with that monotone generation instead of taking
          // Journal.transact's BEGIN IMMEDIATE write lock for read-side work.
          const read = yield* Effect.gen(function*() {
            const generation = options.engineJournal.generation === undefined
              ? { generation: 0, afterSeq: -1 }
              : yield* options.engineJournal.generation(runId)
            const previous = positions.get(executionId)
            const after = previous?.generation === generation.generation ? previous.sequence : -1
            const page = yield* Effect.result(options.engineJournal.entries({
              runId,
              ...(after < 0 ? {} : { after: after as JournalEvent.Seq }),
              limit: pageSize
            }))
            const current = options.engineJournal.generation === undefined
              ? { generation: 0, afterSeq: -1 }
              : yield* options.engineJournal.generation(runId)
            return {
              generation,
              after,
              page,
              stable: current.generation === generation.generation && current.afterSeq === generation.afterSeq
            }
          }).pipe(Effect.tapError((error) =>
            // Either generation read can fail before a stable page exists.
            // Do not invent a current generation from the last successful read.
            gap(executionId, null, {
              reason: error.code,
              phase: "source-generation",
              lastObservedGeneration: positions.get(executionId)?.generation ?? null,
              afterSequence: positions.get(executionId)?.sequence ?? -1
            })
          ))
          if (!read.stable) continue
          const { generation, after, page } = read
          if (generation.generation > 0 && positions.get(executionId)?.generation !== generation.generation) {
            yield* gap(executionId, generation.generation, { reason: "rewound", afterSequence: generation.afterSeq })
          }
          if (page._tag === "Failure") {
            const error = page.failure
            if (error.code !== "compacted" || error.checkpointSeq === undefined || error.checkpointSeq <= after + 1) {
              // A storage/decode/sink failure remains an error. The owning control
              // run must not report a complete projection after this refusal.
              yield* gap(executionId, generation.generation, { reason: error.code, afterSequence: after })
              return yield* Effect.fail(error)
            }
            yield* gap(executionId, generation.generation, {
              reason: "compacted",
              throughSequence: error.checkpointSeq - 1
            })
            // Compaction removes strictly below the checkpoint. Its own event
            // survives and must be copied by the next exclusive-cursor read.
            positions.set(executionId, { generation: generation.generation, sequence: error.checkpointSeq - 1 })
            continue
          }
          let cursor = after
          for (const entry of page.success.entries) {
            if (entry.runId !== runId || entry.seq <= cursor) {
              return yield* Effect.fail(
                new Journal.JournalError({
                  code: "decode_failed",
                  message: "Engine projection received an unordered or foreign journal page"
                })
              )
            }
            // Before the copy, so a reader of the copied record can act on
            // what it says: the host already has.
            if (options.onRecord !== undefined) yield* options.onRecord(entry, generation.generation)
            // Seq is ordered, not contiguous: SqlJournal deliberately leaves
            // reservations unused after rollback. Only the owning journal's
            // compaction/rewind/refusal evidence can establish an omission.
            yield* copy(entry, generation.generation).pipe(Effect.catch((error) =>
              error.code === "invalid_event"
                ? gap(executionId, generation.generation, {
                  reason: error.code,
                  fromSequence: entry.seq,
                  throughSequence: entry.seq
                })
                : Effect.fail(error)
            ))
            cursor = entry.seq
            // Advance only after a durable event or exact omission gap receipt.
            // A storage refusal/lost ack retries the event, never skips the page.
            positions.set(executionId, { generation: generation.generation, sequence: cursor })
          }
          if (!page.success.hasMore) return
          if (cursor === after) {
            return yield* Effect.fail(
              new Journal.JournalError({
                code: "decode_failed",
                message: "Engine projection received an empty continuing page"
              })
            )
          }
        }
      })

    const catchUp = gate.withPermits(1)(Effect.gen(function*() {
      // Additive binding preserves every existing copied-envelope producer ID.
      // Only the supervisor's validated native root can create this association.
      yield* options.controlJournal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: target,
          sourceId: producer(["binding", options.controlRunId, options.executionId]),
          sourceSeq: 0 as JournalEvent.SourceSeq,
          eventType: "control.engine.bound",
          payload: { version: 1, controlRunId: options.controlRunId, executionId: options.executionId }
        })
      )
      const seen = new Set<string>()
      const pending = [options.executionId]
      for (let index = 0; index < pending.length; index++) {
        const executionId = pending[index]!
        if (seen.has(executionId)) continue
        seen.add(executionId)
        yield* readRun(executionId)
        if (options.runLineage !== undefined) {
          const rounds = yield* options.runLineage(executionId)
          const member = rounds.find((row) => row.runId === executionId)
          if (member === undefined) {
            return yield* Effect.fail(
              new Journal.JournalError({
                code: "decode_failed",
                message: "Native lineage omitted its requested member"
              })
            )
          }
          const lineage = member.lineageId ?? member.runId
          for (const round of rounds) {
            if ((round.lineageId ?? round.runId) !== lineage) {
              return yield* Effect.fail(
                new Journal.JournalError({ code: "decode_failed", message: "Native lineage returned a foreign member" })
              )
            }
            if (!seen.has(round.runId)) pending.push(round.runId)
          }
        }
        const children = yield* options.engineState.runChildren(executionId)
        for (const edge of children) {
          if (edge.parentId !== executionId) {
            return yield* Effect.fail(
              new Journal.JournalError({
                code: "decode_failed",
                message: "Engine projection received a foreign parent edge"
              })
            )
          }
          if (!seen.has(edge.childId)) pending.push(edge.childId)
        }
      }
    }))

    // Exactly the journal's own wake/recheck pattern. Local notifications are
    // hints, not data: durable paging catches lost hints, other processes,
    // newly linked children and generations rewound below a previous cursor.
    const followUntil = (runs?: Pick<RunStore.Service, "get">) =>
      Effect.scoped(Effect.gen(function*() {
        const changes = yield* options.engineJournal.changes
        for (;;) {
          yield* catchUp
          if (runs !== undefined) {
            const row = yield* Effect.result(runs.get(options.executionId))
            if (row._tag === "Failure") {
              // A host can start observation when a launch is accepted, before
              // the native run row exists. Every other store refusal is real.
              if (row.failure.code !== "not_found_row") return yield* Effect.fail(row.failure)
            } else if (RunStore.isTerminalRunStatus(row.success.status)) {
              // The driver writes terminal evidence after the handler returns.
              // Observing the committed terminal row THEN reading again closes
              // the race where the preceding page was fetched before commit.
              yield* catchUp
              return
            }
          }
          yield* Effect.raceFirst(PubSub.take(changes), Effect.sleep("1 second"))
        }
      }))

    return {
      catchUp,
      follow: followUntil(),
      followUntilSettled: (runs: Pick<RunStore.Service, "get">) => followUntil(runs)
    }
  })
