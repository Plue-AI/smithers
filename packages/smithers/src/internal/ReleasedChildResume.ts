/**
 * Durable permission to retry released native children safely.
 * @since 1.0.0
 */

import type * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { RunState } from "@smthrs/engine-store/RunState"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import type * as RunStore from "@smthrs/run-store/RunStore"
import { Cause, Effect, Option, Schema } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"

/**
 * Existing native and control durability used to bind retries.
 * @since 1.0.0
 * @private
 */
export interface Options {
  readonly engineJournal: Journal.Service
  readonly controlJournal: Journal.Service
  readonly engineRuns: RunStore.Service
  readonly engineState: Pick<DurableEngineState.Service, "runChildren">
  /** Native attempt storage; absent adapters retain explicit-resume behavior. */
  readonly engineSql?: SqlClient | undefined
}
const eventKind = "control.engine.released-children-resume"
const failureKind = "control.engine.released-children-resume-failed"
const decodeFailure = Schema.decodeUnknownEffect(Schema.Struct({ resumeSequence: Schema.Number }))
const Grant = Schema.Struct({
  resumeSequence: Schema.Number,
  releases: Schema.Array(
    Schema.Struct({ executionId: Schema.String, eventId: Schema.String, generation: Schema.Number })
  )
})
const decodeGrant = Schema.decodeUnknownEffect(Grant)
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(RunState))
const decodeKeyed = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Struct({
  tier: Schema.Literals(["sealed", "compensable", "irreversible"]),
  keyed: Schema.Literal(true)
})))

/**
 * Authorizes the release snapshot once per explicit resume and checks its identity.
 * @since 1.0.0
 * @private
 */
export const make = (options: Options) => {
  const entries = (journal: Journal.Service, runId: string, eventType: string) =>
    Effect.gen(function*() {
      const all: Array<JournalEvent.Entry> = []
      let after: JournalEvent.Seq | undefined
      for (;;) {
        const page = yield* journal.entries({
          runId: JournalEvent.RunId.make(runId),
          limit: 256,
          eventTypes: [eventType],
          ...(after === undefined ? {} : { after })
        })
        all.push(...page.entries)
        if (!page.hasMore) return all
        after = page.entries.at(-1)!.seq
      }
    })
  const latestRelease = (executionId: string) =>
    Effect.gen(function*() {
      const runId = JournalEvent.RunId.make(executionId)
      const before = options.engineJournal.generation === undefined
        ? { generation: 0, afterSeq: -1 }
        : yield* options.engineJournal.generation(runId)
      const history = yield* entries(options.engineJournal, executionId, "flows.engine.run-decision")
      const after = options.engineJournal.generation === undefined
        ? { generation: 0, afterSeq: -1 }
        : yield* options.engineJournal.generation(runId)
      if (before.generation !== after.generation || before.afterSeq !== after.afterSeq) {
        return yield* Effect.fail(
          new Journal.JournalError({
            code: "decode_failed",
            message: "Native release changed generation while authorizing retry"
          })
        )
      }
      const entry = history.findLast((entry) =>
        entry.eventType === "flows.engine.run-decision" &&
        typeof entry.payload === "object" && entry.payload !== null &&
        "decision" in entry.payload && entry.payload.decision === "interrupt-released"
      )
      return entry === undefined ? undefined : {
        eventId: entry.eventId,
        generation: before.generation
      }
    })
  const grants = (root: string) =>
    Effect.gen(function*() {
      const history = yield* entries(options.controlJournal, root, eventKind)
      return yield* Effect.forEach(history.filter((entry) => entry.eventType === eventKind), (entry) =>
        decodeGrant(entry.payload))
    })
  const authorize = (root: string, resumeSequence: number) =>
    Effect.gen(function*() {
      // A replayed resume remains bound to its first snapshot, even when empty.
      if ((yield* grants(root)).some((grant) => grant.resumeSequence === resumeSequence)) return
      const failures = yield* entries(options.controlJournal, root, failureKind)
      for (const failure of failures) {
        if ((yield* decodeFailure(failure.payload)).resumeSequence === resumeSequence) return
      }
      const releases: Array<{ executionId: string; eventId: string; generation: number }> = []
      const pending = [root]
      const seen = new Set<string>()
      for (let index = 0; index < pending.length; index++) {
        const executionId = pending[index]!
        if (seen.has(executionId)) continue
        seen.add(executionId)
        const rounds = yield* options.engineRuns.lineage(executionId)
        const member = rounds.find((row) => row.runId === executionId)
        if (
          member === undefined ||
          rounds.some((round) => (round.lineageId ?? round.runId) !== (member.lineageId ?? member.runId))
        ) {
          return yield* Effect.fail(
            new Journal.JournalError({
              code: "decode_failed",
              message: "Native retry lineage is incomplete or foreign"
            })
          )
        }
        for (const round of rounds) if (!seen.has(round.runId)) pending.push(round.runId)
        const children = yield* options.engineState.runChildren(executionId)
        for (const child of children) if (!seen.has(child.childId)) pending.push(child.childId)
        const row = member
        const state = yield* decodeState(row.stateJson)
        if (
          row.status !== "suspended" || state.result !== undefined || row.cancelRequestedAtMs !== null ||
          state.cancellation !== undefined
        ) continue
        const release = yield* latestRelease(executionId)
        if (release !== undefined) {
          releases.push({ executionId, eventId: release.eventId, generation: release.generation })
        }
      }
      yield* options.controlJournal.emitDurableUnfenced(
        new JournalEvent.Input({
          runId: JournalEvent.RunId.make(root),
          sourceId: JournalEvent.SourceId.make(`explicit-child-resume:${resumeSequence}`),
          sourceSeq: JournalEvent.SourceSeq.make(0),
          eventType: eventKind,
          payload: { resumeSequence, releases }
        })
      )
    }).pipe(Effect.onError((cause) =>
      Cause.hasInterruptsOnly(cause) ?
        Effect.void :
        options.controlJournal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: JournalEvent.RunId.make(root),
            sourceId: JournalEvent.SourceId.make(`explicit-child-resume-failed:${resumeSequence}`),
            sourceSeq: JournalEvent.SourceSeq.make(0),
            eventType: failureKind,
            payload: { resumeSequence, cause: Cause.pretty(cause) }
          })
        ).pipe(
          Effect.asVoid,
          Effect.catchCause((receiptCause) =>
            Cause.hasInterruptsOnly(receiptCause) ?
              Effect.interrupt :
              Effect.logWarning(
                "Released child retry failure receipt could not be recorded",
                Cause.pretty(receiptCause)
              )
          )
        )
    ))
  const canRetryReleased = (executionId: string, root: string) =>
    Effect.gen(function*() {
      const row = yield* options.engineRuns.get(executionId)
      const state = yield* decodeState(row.stateJson)
      if (
        row.status !== "suspended" || state.result !== undefined || row.cancelRequestedAtMs !== null ||
        state.cancellation !== undefined
      ) return false
      const release = yield* latestRelease(executionId)
      if (release === undefined) return false
      if (options.engineSql !== undefined) {
        const sql = options.engineSql
        const keyed = yield* sql.withTransaction(Effect.gen(function*() {
          // Inspect executable metadata, never redacted journal payloads. A
          // malformed or legacy marker cannot prove repeat safety. The native
          // claim still fences admission after this read-only eligibility check.
          const attempts = yield* sql<{ readonly meta: string }>`
            SELECT meta_json AS "meta" FROM flows_attempts
            WHERE run_id = ${executionId} AND state = 'running'
          `
          const safe = attempts.every((attempt) => Option.isSome(decodeKeyed(attempt.meta)))
          const current = yield* options.engineRuns.get(executionId)
          const currentState = yield* decodeState(current.stateJson)
          if (
            current.status !== "suspended" || currentState.result !== undefined ||
            current.cancelRequestedAtMs !== null || currentState.cancellation !== undefined
          ) return { safe: false, unchanged: false }
          const currentRelease = yield* latestRelease(executionId)
          return {
            safe,
            unchanged: currentRelease?.eventId === release.eventId && currentRelease.generation === release.generation
          }
        }))
        if (!keyed.unchanged) return false
        if (keyed.safe) return true
      }
      if (
        (yield* grants(root)).some((grant) =>
          grant.releases.some((item) =>
            item.executionId === executionId && item.eventId === release.eventId &&
            item.generation === release.generation
          )
        )
      ) return true
      // Owner death permits native ownership takeover, not repetition of an
      // unfinished unkeyed effect. Only a matching explicit grant permits it.
      return false
    })
  return { authorize, canRetryReleased }
}
