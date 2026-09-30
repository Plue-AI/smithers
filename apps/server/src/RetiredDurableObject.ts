import * as Effect from "effect/Effect"
import { runDurable } from "./Boundary"
import { ALARM_MARKER_TABLE, sqlOf, type MarkerSql } from "./MaintenanceExport"

/**
 * Inert storage owner for a namespace retired by the shared-backend cutover.
 * The class, binding and namespace identity stay so Cloudflare keeps the
 * storage for rollback; no request reads or writes product state.
 *
 * An alarm that was still scheduled when the authority retired must not
 * vanish. Acknowledging it would delete the only live trace. Instead it
 * leaves a marker in the reserved maintenance table (never product
 * key-value storage), flushes it, and refuses. The platform retries a bounded
 * number of times and then drops the alarm; the marker stays.
 */
export interface RetiredAlarmMarker {
  readonly schema: "smithers-retired-alarm/v1"
  readonly state: "interrupted-unresolved"
  readonly worker: string
  readonly binding: string
  readonly objectId: string
  readonly scheduledNoLaterThan: string
  readonly firstObservedAt: string
  readonly lastObservedAt: string
  readonly observations: number
  readonly lastRetryCount: number
}
/** The owner's context: an id and, on SQLite-backed storage, the SQL handle the marker is written through. */
export interface RetiredContext {
  readonly id?: { readonly toString: () => string }
  readonly storage?: { readonly sql?: MarkerSql; readonly sync?: () => Promise<void> }
}
/** Row key in the reserved table. */
export const RETIRED_MARKER_KEY = "retired"
export const recordRetiredAlarm = (ctx: RetiredContext | undefined, worker: string, binding: string, retryCount: number, now: Date): RetiredAlarmMarker | null => {
  const sql = sqlOf(ctx?.storage)
  if (!sql || !ctx?.id) return null
  sql.exec(`CREATE TABLE IF NOT EXISTS ${ALARM_MARKER_TABLE} (execution_id TEXT PRIMARY KEY, marker TEXT NOT NULL)`)
  const prior = sql.exec(`SELECT marker FROM ${ALARM_MARKER_TABLE} WHERE execution_id = ?`, RETIRED_MARKER_KEY).toArray()[0]
  const previous = prior ? JSON.parse(String(prior.marker)) as RetiredAlarmMarker : null
  const at = now.toISOString()
  const marker: RetiredAlarmMarker = previous
    ? { ...previous, lastObservedAt: at, observations: previous.observations + 1, lastRetryCount: retryCount }
    : { schema: "smithers-retired-alarm/v1", state: "interrupted-unresolved", worker, binding, objectId: ctx.id.toString(), scheduledNoLaterThan: at, firstObservedAt: at, lastObservedAt: at, observations: 1, lastRetryCount: retryCount }
  sql.exec(`INSERT INTO ${ALARM_MARKER_TABLE} (execution_id, marker) VALUES (?, ?) ON CONFLICT(execution_id) DO UPDATE SET marker = excluded.marker`, RETIRED_MARKER_KEY, JSON.stringify(marker))
  return marker
}

/** `export class TurnCancelRegistry extends retiredDurable("smithers-mvp-web", "TURN_CANCELS") {}` */
export const retiredDurable = (worker: string, binding: string) => class RetiredDurableObject {
  constructor(private readonly retiredContext?: RetiredContext) {}
  fetch(): Promise<Response> { // effect-policy: boundary
    return runDurable(Effect.succeed(Response.json({ status: "error", code: "authority_retired" }, { status: 410 })))
  }
  alarm(info?: { readonly retryCount?: number }): Promise<never> { // effect-policy: boundary
    const ctx = this.retiredContext
    return runDurable(Effect.gen(function* () {
      const marker = yield* Effect.sync(() => recordRetiredAlarm(ctx, worker, binding, info?.retryCount ?? 0, new Date()))
      if (marker && ctx?.storage?.sync) yield* Effect.tryPromise({ try: () => ctx.storage!.sync!(), catch: () => new Error("retired_alarm_marker_unsynced") }).pipe(Effect.orDie)
      return yield* Effect.die(new Error("authority_retired"))
    }))
  }
}
