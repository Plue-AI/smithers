/**
 * The host's ledger of the processes it spawned.
 *
 * A cancelled run must not leave a child agent running, and the engine cannot
 * do anything about that on its own: cancellation interrupts fibers, and a
 * fiber closing its scope only reaches the processes THIS incarnation of the
 * host still holds a handle for. A host that crashed left its children with no
 * one holding anything.
 *
 * The ledger is the missing half. Every spawn is recorded here in memory and
 * written to the journal as an ownerless durable record. It is ownerless
 * because it describes the host rather than a run, and first-writer-wins is
 * exactly the semantics a spawn record wants. The next incarnation of the same
 * `hostId` replays those records, subtracts the ones that reported an exit,
 * and is left with {@link Service.orphans}: the process groups a dead owner
 * abandoned, which a platform reaper can then signal.
 *
 * The kernel stays BELOW the engine: this module records pids and process
 * groups and knows nothing about runs, attempts, or ownership fences. It also
 * stays platform-neutral, because signalling a process group is a platform
 * concern and lives in `@smthrs/platform-node`.
 *
 * Governing design:
 * `docs/specs/Concepts/Host Adapters.md` and
 * `docs/specs/Concepts/Journal Queue.md`.
 *
 * @since 1.0.0-rc.0
 */

import * as JournalModule from "@smthrs/journal/Journal"
import type { JournalError } from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/**
 * The event type recording that a host started a process.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const SpawnedEventType = "flows.host.process-spawned.v1"

/**
 * The event type recording that a recorded process ended.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const ExitedEventType = "flows.host.process-exited.v1"

/**
 * The event type recording that a later incarnation killed an abandoned
 * process group.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const ReapedEventType = "flows.host.process-reaped.v1"

/**
 * The event type recording that a later incarnation retired a record WITHOUT
 * signalling anything.
 *
 * A stored pid outlives the process that wrote it, so a reaper that cannot
 * prove the number still names the process the record describes must not
 * signal it. Retiring the record is still correct: nothing will ever be able
 * to prove it again, and leaving it would make every later incarnation
 * re-examine a number the operating system has moved on from.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const SkippedEventType = "flows.host.process-reap-skipped.v1"

/**
 * The producer id every ledger record is written under.
 *
 * Replay checks it: a record forged by another producer cannot make a host
 * signal a process group.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const sourceId = "@smthrs/kernel/ProcessLedger"

/**
 * The journal run a host's process records live on.
 *
 * Process records describe a host, not a run, so they get a run of their own,
 * named after the host. Two incarnations of one `hostId` therefore share a
 * history, which is what makes an abandoned process discoverable.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const hostRunId = (hostId: string): JournalEvent.RunId => `flows.host:${hostId}` as JournalEvent.RunId

/**
 * What the spawner knows about a process the moment it starts.
 *
 * `pgid` is `null` when the child shares the host's own process group. Such a
 * process cannot be group-signalled — signalling that group would signal the
 * host itself — so the ledger records the absence rather than a number a
 * reaper could misread.
 *
 * `commandDigest` names the executable and nothing else, as
 * `CommandLine.executable` renders it. Arguments carry credentials
 * (`curl -u user:password`, `mysql -phunter2`) and these records are permanent
 * journal entries, so the ledger never writes an argument down. A reader that
 * has to act on a record matches it by pid and process group; the program name
 * is there to make the row legible.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Spawned {
  readonly pid: number
  readonly pgid: number | null
  readonly commandDigest: string
}

/**
 * Schema for a recorded process, as it round-trips through the journal.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const ProcessRecord = Schema.Struct({
  pid: Schema.Int,
  pgid: Schema.NullOr(Schema.Int),
  hostId: Schema.String,
  ownerPid: Schema.Int,
  startedAtMs: Schema.Int,
  commandDigest: Schema.String
})

/**
 * One process a host started, with the identity of the incarnation that
 * started it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type ProcessRecord = typeof ProcessRecord.Type

/**
 * Why a ledger history could not be replayed.
 *
 * - `journal_unreadable`: a page of the host's history could not be read.
 * - `cursor_stalled`: the journal reported more history but did not advance.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export const ProcessLedgerReplayErrorCode = Schema.Literals(["journal_unreadable", "cursor_stalled"])

/**
 * The ledger could not read a previous incarnation's history to its end.
 *
 * An unread history is never reported as an empty one: a caller that treated
 * it as empty would leave every abandoned child running with no owner.
 *
 * @category errors
 * @since 1.0.0-rc.1
 */
export class ProcessLedgerReplayError extends Schema.TaggedError<ProcessLedgerReplayError>()(
  "@smthrs/kernel/ProcessLedgerReplayError",
  {
    code: ProcessLedgerReplayErrorCode,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect())
  }
) {}

const decodeRecord = Schema.decodeUnknownResult(ProcessRecord)
const encodeRecord = Schema.encodeSync(ProcessRecord)

/**
 * Ledger operations.
 *
 * Every write that has a durable half REPORTS whether that half committed.
 * The in-memory set is still updated first, so a caller that decides to carry
 * on has an accurate view of this incarnation, but the failure is not
 * swallowed: a spawn whose record did not commit is a child that no later
 * incarnation can discover, which is the exact hole this ledger exists to
 * close. {@link ContainedSpawner} therefore refuses such a spawn, and the
 * reaper leaves a record it could not retire in place so a later incarnation
 * tries again.
 *
 * A ledger built with no journal ({@link makeMemory}) never fails: it promises
 * nothing durable in the first place.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export interface Service {
  /** Records a started process and returns the durable record written for it. */
  readonly record: (spawned: Spawned) => Effect.Effect<ProcessRecord, JournalError>
  /** Records that a process ended, and drops it from {@link Service.live}. */
  readonly release: (record: ProcessRecord) => Effect.Effect<void, JournalError>
  /** Records that an abandoned process group was signalled by this host. */
  readonly reaped: (record: ProcessRecord) => Effect.Effect<void, JournalError>
  /**
   * Retires a record this host refused to signal, naming why. The record
   * leaves {@link Service.orphans} without anything having been killed.
   */
  readonly skipped: (record: ProcessRecord, reason: string) => Effect.Effect<void, JournalError>
  /** The processes this incarnation started and has not yet released. */
  readonly live: Effect.Effect<ReadonlyArray<ProcessRecord>>
  /**
   * The processes a previous incarnation of this host left running.
   *
   * Fails when that history cannot be read to its end, so an unreadable
   * history is never mistaken for one with nothing left running.
   */
  readonly orphans: Effect.Effect<ReadonlyArray<ProcessRecord>, ProcessLedgerReplayError>
}

/**
 * The process-ledger service tag.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export class ProcessLedger extends Context.Service<ProcessLedger, Service>()("@smthrs/kernel/ProcessLedger") {}

/**
 * Ledger configuration.
 *
 * `hostId` is the durable identity two incarnations share; `ownerPid` is the
 * process id of THIS incarnation, which is how a replay tells its own live
 * processes from an abandoned one's.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  readonly hostId: string
  readonly ownerPid: number
}

/** Where records are appended, and where a previous incarnation's are read. */
interface Sink {
  readonly append: (
    eventType: string,
    record: ProcessRecord,
    extra?: Record<string, unknown>
  ) => Effect.Effect<void, JournalError>
  readonly replay: Effect.Effect<ReadonlyArray<ProcessRecord>, ProcessLedgerReplayError>
}

/** The event types that retire a record from the inherited set. */
const retires = (eventType: string): boolean =>
  eventType === ExitedEventType || eventType === ReapedEventType || eventType === SkippedEventType

/** A pid may be reused before the previous process's scope releases its record. */
const identity = (record: ProcessRecord): string => `${record.pid}:${record.startedAtMs}`

/**
 * One entry folded onto the live set.
 *
 * Returns the entry when it is one of the ledger's own records but its payload
 * does not decode, so replay can report it. Such an entry names no process
 * that could be signalled, so failing the whole replay over it would stop
 * every later incarnation from reaping the well-formed records beside it.
 */
const apply = (live: Map<string, ProcessRecord>, entry: JournalEvent.Entry): JournalEvent.Entry | undefined => {
  if (entry.sourceId !== sourceId) return undefined
  if (entry.eventType !== SpawnedEventType && !retires(entry.eventType)) return undefined
  const decoded = decodeRecord(entry.payload)
  if (decoded._tag === "Failure") return entry
  if (entry.eventType === SpawnedEventType) {
    live.set(identity(decoded.success), decoded.success)
    return
  }
  live.delete(identity(decoded.success))
  return undefined
}

const PAGE = 256

const journalSink = (options: Options, journal: JournalModule.Service): Sink => ({
  append: (eventType, record, extra) =>
    journal.emitDurableUnfenced(
      new JournalEvent.Input({
        runId: hostRunId(options.hostId),
        sourceId: sourceId as JournalEvent.SourceId,
        eventType,
        payload: extra === undefined ? encodeRecord(record) : { ...encodeRecord(record), ...extra }
      })
    ).pipe(
      // The failure is REPORTED, not logged away. A swallowed write leaves a
      // child that no incarnation of this host can discover, which is the one
      // outcome containment exists to prevent; the caller decides what to do
      // about it, and every caller in this repository declines to pretend the
      // process was recorded.
      Effect.tapCause((cause) => Effect.logWarning(`process ledger could not journal ${eventType}`, cause)),
      Effect.asVoid
    ),
  replay: Effect.gen(function*() {
    const live = new Map<string, ProcessRecord>()
    let after: JournalEvent.Seq | undefined
    for (;;) {
      const page = yield* journal.entries({
        runId: hostRunId(options.hostId),
        limit: PAGE,
        ...(after === undefined ? {} : { after })
      }).pipe(
        Effect.mapError((cause) =>
          new ProcessLedgerReplayError({
            code: "journal_unreadable",
            message: `process ledger could not read the history of host ${options.hostId}`,
            cause
          })
        )
      )
      for (const entry of page.entries) {
        const malformed = apply(live, entry)
        if (malformed !== undefined) {
          yield* Effect.logWarning(
            `process ledger skipped an undecodable ${malformed.eventType} record at seq ${malformed.seq}`
          )
        }
      }
      const last = page.entries.at(-1)
      if (last === undefined || !page.hasMore) break
      // A page that ends where the previous one did would be replayed
      // forever, and stopping there would report a partial history as whole.
      if (after !== undefined && last.seq <= after) {
        return yield* Effect.fail(
          new ProcessLedgerReplayError({
            code: "cursor_stalled",
            message: `process ledger history of host ${options.hostId} stopped advancing at seq ${last.seq}`
          })
        )
      }
      after = last.seq
    }
    return [...live.values()]
  })
})

const memorySink: Sink = {
  append: () => Effect.void,
  replay: Effect.succeed([])
}

const makeWith = (options: Options, sink: Sink): Service => {
  const live = new Map<string, ProcessRecord>()
  return ProcessLedger.of({
    record: (spawned) =>
      Effect.gen(function*() {
        const startedAtMs = yield* Effect.clockWith((clock) => clock.currentTimeMillis)
        const record: ProcessRecord = {
          pid: spawned.pid,
          pgid: spawned.pgid,
          hostId: options.hostId,
          ownerPid: options.ownerPid,
          startedAtMs,
          commandDigest: spawned.commandDigest
        }
        live.set(identity(record), record)
        // A failed append tells the caller the spawn was not recorded, and the
        // caller kills the child. Keeping it live would lie to every later
        // reader about a process this incarnation still holds.
        yield* sink.append(SpawnedEventType, record).pipe(
          Effect.tapCause(() => Effect.sync(() => live.delete(identity(record))))
        )
        return record
      }),
    release: (record) =>
      Effect.suspend(() => {
        live.delete(identity(record))
        return sink.append(ExitedEventType, record)
      }),
    reaped: (record) => sink.append(ReapedEventType, record),
    skipped: (record, reason) => sink.append(SkippedEventType, record, { reason }),
    live: Effect.sync(() => [...live.values()]),
    orphans: Effect.map(sink.replay, (records) => records.filter((record) => record.ownerPid !== options.ownerPid))
  })
}

/**
 * Builds a journal-backed ledger.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = (options: Options): Effect.Effect<Service, never, JournalModule.Journal> =>
  Effect.map(JournalModule.Journal, (journal) => makeWith(options, journalSink(options, journal)))

/**
 * Builds a ledger that records nothing durably.
 *
 * A host without a journal still contains the processes it holds handles for —
 * scope closure does that — but it inherits nothing from a previous
 * incarnation, so {@link Service.orphans} is always empty.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const makeMemory = (options: Options): Effect.Effect<Service> => Effect.sync(() => makeWith(options, memorySink))

/**
 * Provides a journal-backed ledger.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (options: Options): Layer.Layer<ProcessLedger, never, JournalModule.Journal> =>
  Layer.effect(ProcessLedger, make(options))

/**
 * Provides a ledger that records nothing durably.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layerMemory = (options: Options): Layer.Layer<ProcessLedger> =>
  Layer.effect(ProcessLedger, makeMemory(options))
