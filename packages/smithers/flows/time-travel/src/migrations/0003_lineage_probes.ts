/**
 * Run-scoped journal lineage indexes.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { step } from "../internal/MigrationStep.ts"

/**
 * Indexes journal records that produce lineage edges.
 *
 * @since 0.1.0
 * @private
 */
export const lineageProbes = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  // These partial indexes contain only lineage-producing journal records.
  // Keep their predicates identical to the literal predicates in edgesUnder.
  yield* step(
    "flows_journal_events_child_spawn_idx on flows_journal_events",
    sql`CREATE INDEX IF NOT EXISTS flows_journal_events_child_spawn_idx
    ON flows_journal_events (run_id, seq)
    WHERE event_type = 'flows.time-travel.effect-boundary'
      AND ${Dialect.jsonText(sql, sql`payload_json`, "$.effect.kind")} = 'flows/engine-store/child-spawn'`
  )
  yield* step(
    "flows_journal_events_handoff_idx on flows_journal_events",
    sql`CREATE INDEX IF NOT EXISTS flows_journal_events_handoff_idx
    ON flows_journal_events (run_id, seq)
    WHERE event_type = 'flows.engine.run-decision'
      AND ${Dialect.jsonText(sql, sql`payload_json`, "$.decision")} = 'handed-off'`
  )
})
