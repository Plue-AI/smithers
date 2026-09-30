/**
 * Durable permission for one explicit retry of released native children.
 * @since 1.0.0
 */

import type * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { RunState } from "@smthrs/engine-store/RunState"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Ownership } from "@smthrs/run-store"
import type * as RunStore from "@smthrs/run-store/RunStore"
import { Cause, Clock, Duration, Effect, Option, Schema } from "effect"

/**
 * Existing native and control durability used to bind retries.
 * @since 1.0.0
 * @private
 */
export interface Options {
  readonly engineJournal: Journal.Service
  readonly controlJournal: Journal.Service
  readonly engineRuns: RunStore.Service
  readonly claimant?: Ownership.OwnerId | undefined
  readonly isAlive?: Ownership.LivenessCheck | undefined
  readonly engineState: Pick<DurableEngineState.Service, "runChildren">
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
const decodeReleaseOwner = Schema.decodeUnknownOption(Schema.Struct({ owner: Ownership.OwnerId }))
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(RunState))

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
        generation: before.generation,
        emittedAtMs: entry.emittedAtMs,
        owner: Option.getOrUndefined(decodeReleaseOwner(entry.payload))?.owner
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
        if (executionId === root) continue
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
      const release = yield* latestRelease(executionId)
      if (release === undefined) return false
      if (
        (yield* grants(root)).some((grant) =>
          grant.releases.some((item) =>
            item.executionId === executionId && item.eventId === release.eventId &&
            item.generation === release.generation
          )
        )
      ) return true
      if (
        options.claimant === undefined || release.owner === undefined ||
        release.owner.hostId !== options.claimant.hostId
      ) return false
      const nowMs = yield* Clock.currentTimeMillis
      if (release.emittedAtMs >= nowMs - Duration.toMillis(Ownership.heartbeatStaleAfter)) return false
      return !(yield* (options.isAlive ?? Ownership.sameHostPidProbe)(release.owner, {
        claimant: options.claimant,
        heartbeatAtMs: release.emittedAtMs,
        nowMs
      }))
    })
  return { authorize, canRetryReleased }
}
