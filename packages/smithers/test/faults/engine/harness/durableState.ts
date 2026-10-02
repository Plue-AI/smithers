/**
 * Reading the durable state a killed host left behind.
 *
 * The assertions in the crash family are about rows in a SQLite file, not about
 * anything a test process remembered, so they are read here through the shipped
 * stores over a fresh connection.
 *
 * @since 1.0.0
 */
import { DurableEngineState } from "@smthrs/engine-store"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Journal, type JournalEvent } from "@smthrs/journal"
import { contentDigest } from "@smthrs/journal/JournalEvent"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import { SqlClient } from "effect/unstable/sql/SqlClient"

const storage = (filename: string) =>
  NodeRuntime.storage(filename).pipe(
    Layer.provideMerge(Layer.mergeAll(NodeHost.layer, NodeHost.NodeCrypto.layer))
  )

/** Reads the actual persisted deadlines without arming an engine host. */
export const pendingClocks = (
  filename: string,
  executionId: string
): Promise<ReadonlyArray<DurableEngineState.ClockRow>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      return yield* state.pendingClocks({ executionId })
    }).pipe(Effect.provide(storage(filename)), Effect.scoped, Effect.orDie)
  )

/**
 * Every committed entry of one run, page by page.
 *
 * A single page is the wrong read for the evidence a case asserts on. The
 * records a timer case checks, the deferred completion and each host's
 * schedule, are the LAST things written for the run, while a parked run that
 * several hosts resume writes one ownership decision per re-drive ahead of
 * them. A fixed first page therefore reported "no completion" for a run that
 * plainly completed, as a function of how often the hosts happened to re-drive
 * it. The cursor walks to the end instead, so the evidence belongs to the run
 * rather than to the page.
 */
const allEntries = (
  journal: Journal.Journal["Service"],
  runId: JournalEvent.RunId
) =>
  Effect.gen(function*() {
    const collected: Array<JournalEvent.Entry> = []
    let after: JournalEvent.Seq | undefined
    while (true) {
      const page = yield* journal.entries({
        runId,
        limit: 1_000,
        ...(after === undefined ? {} : { after })
      })
      collected.push(...page.entries)
      const last = page.entries.at(-1)
      if (!page.hasMore || last === undefined) return collected
      after = last.seq
    }
  })

/** Reads committed timer identity, its first completion, and the full host records. */
export const timerEvidence = (filename: string, address: DurableEngineState.ClockRow) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const journal = yield* Journal.Journal
      const clock = yield* state.clock(address)
      const deferred = yield* state.deferred(address)
      const entries = yield* allEntries(journal, address.executionId as JournalEvent.RunId)
      const sql = yield* SqlClient
      const encoded = yield* sql<{ exitJson: string; metadataJson: string | null }>`
        SELECT exit_json AS "exitJson", metadata_json AS "metadataJson"
        FROM flows_deferred_completions
        WHERE flow_name = ${address.flowName} AND execution_id = ${address.executionId}
          AND deferred_name = ${address.deferredName}
      `
      const value = encoded[0]
      const digest = value === undefined ? undefined : {
        exit: contentDigest(value.exitJson),
        metadata: value.metadataJson === null ? null : contentDigest(value.metadataJson)
      }
      return {
        clock: Option.getOrUndefined(clock),
        deferred: Option.getOrUndefined(deferred),
        digest,
        entries
      }
    }).pipe(Effect.provide(storage(filename)), Effect.scoped, Effect.orDie)
  )

/**
 * The waiting row an execution is parked on, if it is parked at all.
 *
 * @since 1.0.0
 * @category getters
 */
export const waitingRow = (
  filename: string,
  executionId: string
): Promise<{ readonly reason: string; readonly token: string | null } | undefined> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const state = yield* DurableEngineState.DurableEngineState
      const row = yield* state.waiting(executionId)
      if (Option.isNone(row)) return undefined
      return { reason: String(row.value.reason), token: row.value.token }
    }).pipe(Effect.provide(storage(filename)), Effect.scoped, Effect.orDie)
  )

/**
 * Every journal event type recorded for one run, in sequence order.
 *
 * @since 1.0.0
 * @category getters
 */
export const journalEventTypes = (
  filename: string,
  runId: string,
  limit = 1_000
): Promise<ReadonlyArray<string>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      const page = yield* journal.entries({ runId: runId as JournalEvent.RunId, limit })
      return page.entries.map((entry) => entry.eventType)
    }).pipe(Effect.provide(storage(filename)), Effect.scoped, Effect.orDie)
  )

/** Reads the complete committed journal without truncating recovery evidence. */
export const journalEntries = (filename: string, runId: string): Promise<ReadonlyArray<JournalEvent.Entry>> =>
  Effect.runPromise(
    Effect.gen(function*() {
      return yield* allEntries(yield* Journal.Journal, runId as JournalEvent.RunId)
    }).pipe(Effect.provide(storage(filename)), Effect.scoped, Effect.orDie)
  )
