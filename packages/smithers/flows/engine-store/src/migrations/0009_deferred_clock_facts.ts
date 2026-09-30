/**
 * Backfills the journal records the deferred/clock fold reads.
 *
 * @since 1.0.0
 */

import { FlowEngine } from "@smthrs/engine"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { EventTypes } from "../EventTypes.ts"

interface ClockRow {
  readonly flow_name: string
  readonly execution_id: string
  readonly clock_name: string
  readonly deferred_name: string
  readonly due_at_ms: number | string
  readonly completed_at_ms: number | string | null
}

interface DeferredRow {
  readonly flow_name: string
  readonly execution_id: string
  readonly deferred_name: string
  readonly exit_json: string
  readonly metadata_json: string | null
  readonly completed_at_ms: number | string
  readonly consumed_at_ms: number | string | null
}

const optionalTime = (value: number | string | null): number | null => value === null ? null : Number(value)

/**
 * Journals every deferred/clock change written before the fold's records
 * existed: a clock row with no `clock-scheduled` record, a completed clock
 * with no `clock-completed` record, a completion with no `deferred-completed`
 * record, and a consumed completion with no `deferred-consumed` record. Without
 * them a rebuild would drop the clock, or re-arm a completed one and wake a run
 * for a result it already observed (issue #2037).
 *
 * Each backfilled record is appended at the run's next sequence under a
 * `flows.engine.backfill:` producer whose identity names the row, with the
 * lineage meta every engine record carries.
 *
 * @category migrations
 * @since 1.0.0
 */
export const deferredClockFacts: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const recorded = new Set<string>()
  const events = yield* sql<{ readonly run_id: string; readonly event_type: string; readonly payload_json: string }>`
    SELECT run_id, event_type, payload_json FROM flows_journal_events
    WHERE ${
    sql.in("event_type", [
      EventTypes.clockScheduled,
      EventTypes.clockCompleted,
      EventTypes.deferredCompleted,
      EventTypes.deferredConsumed
    ])
  }
  `
  for (const event of events) {
    const payload = JSON.parse(event.payload_json) as Record<string, unknown>
    const name = event.event_type === EventTypes.clockScheduled || event.event_type === EventTypes.clockCompleted
      ? payload.clockName
      : payload.deferredName
    recorded.add(JSON.stringify([event.event_type, payload.flowName, payload.executionId, name]))
  }
  const next = new Map<string, number>()
  const append = (
    eventType: string,
    executionId: string,
    name: string,
    emittedAtMs: number,
    payload: Readonly<Record<string, unknown>>
  ) =>
    Effect.gen(function*() {
      const identity = JSON.stringify([eventType, payload.flowName, executionId, name])
      if (recorded.has(identity)) return
      recorded.add(identity)
      let seq = next.get(executionId)
      if (seq === undefined) {
        const rows = yield* sql<{ readonly next: number | string | null }>`
          SELECT MAX(seq) + 1 AS next FROM flows_journal_events WHERE run_id = ${executionId}
        `
        seq = Number(rows[0]?.next ?? 0)
      }
      next.set(executionId, seq + 1)
      const sourceId = `flows.engine.backfill:${JournalEvent.contentDigest(identity)}`
      yield* sql`
        INSERT INTO flows_journal_events (
          run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json
        ) VALUES (
          ${executionId},
          ${seq},
          ${
        JournalEvent.makeEventId(
          executionId as JournalEvent.RunId,
          sourceId as JournalEvent.SourceId,
          0 as JournalEvent.SourceSeq
        )
      },
          ${sourceId},
          ${0},
          ${emittedAtMs},
          ${eventType},
          ${JSON.stringify(payload)},
          ${JSON.stringify({ lineageId: FlowEngine.Lineage.root(executionId) })}
        )
      `
    })

  const clocks = yield* sql<ClockRow>`
    SELECT flow_name, execution_id, clock_name, deferred_name, due_at_ms, completed_at_ms
    FROM flows_clock_deadlines
    ORDER BY execution_id, flow_name, clock_name
  `
  for (const clock of clocks) {
    const dueAtMs = Number(clock.due_at_ms)
    const completedAtMs = optionalTime(clock.completed_at_ms)
    yield* append(EventTypes.clockScheduled, clock.execution_id, clock.clock_name, completedAtMs ?? dueAtMs, {
      flowName: clock.flow_name,
      executionId: clock.execution_id,
      clockName: clock.clock_name,
      deferredName: clock.deferred_name,
      dueAtMs
    })
    if (completedAtMs !== null) {
      yield* append(EventTypes.clockCompleted, clock.execution_id, clock.clock_name, completedAtMs, {
        flowName: clock.flow_name,
        executionId: clock.execution_id,
        clockName: clock.clock_name,
        completedAtMs
      })
    }
  }
  const deferreds = yield* sql<DeferredRow>`
    SELECT flow_name, execution_id, deferred_name, exit_json, metadata_json, completed_at_ms, consumed_at_ms
    FROM flows_deferred_completions
    ORDER BY execution_id, flow_name, deferred_name
  `
  for (const deferred of deferreds) {
    const completedAtMs = Number(deferred.completed_at_ms)
    const consumedAtMs = optionalTime(deferred.consumed_at_ms)
    yield* append(EventTypes.deferredCompleted, deferred.execution_id, deferred.deferred_name, completedAtMs, {
      flowName: deferred.flow_name,
      executionId: deferred.execution_id,
      deferredName: deferred.deferred_name,
      completedAtMs,
      exitDigest: JournalEvent.contentDigest(deferred.exit_json),
      metadataDigest: deferred.metadata_json === null ? null : JournalEvent.contentDigest(deferred.metadata_json)
    })
    if (consumedAtMs !== null) {
      yield* append(EventTypes.deferredConsumed, deferred.execution_id, deferred.deferred_name, consumedAtMs, {
        flowName: deferred.flow_name,
        executionId: deferred.execution_id,
        deferredName: deferred.deferred_name,
        consumedAtMs
      })
    }
  }
})
