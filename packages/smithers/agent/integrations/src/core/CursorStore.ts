/**
 * Durable cursor persistence for polling sources.
 *
 * A polling source is only as safe as its cursor. The contract is that a
 * proposed cursor reaches the store *after* the batch it acknowledges has been
 * handled, so a process that dies mid-batch re-polls that batch on restart
 * instead of skipping it. The store itself is deliberately dumb: get, set, and
 * nothing else.
 *
 * @since 1.0.0
 */

import { Context, Effect, Layer, Ref } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { IntegrationError } from "./IntegrationError.ts"

/**
 * The cursor persistence seam.
 *
 * @category services
 * @since 1.0.0
 */
export interface CursorStore {
  /** The stored cursor for `sourceId`, or `null` when the source is new. */
  readonly get: (sourceId: string) => Effect.Effect<string | null, IntegrationError>
  readonly set: (sourceId: string, cursor: string | null) => Effect.Effect<void, IntegrationError>
}

/**
 * Service tag for cursor persistence.
 *
 * @category services
 * @since 1.0.0
 */
export const CursorStore: Context.Service<CursorStore, CursorStore> = Context.Service(
  "@smthrs/integrations/CursorStore"
)

/**
 * An in-memory store. Cursors live as long as the process, which is what an
 * ephemeral source and a test both want.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeMemory: Effect.Effect<CursorStore> = Effect.gen(function*() {
  const cursors = yield* Ref.make(new Map<string, string | null>())
  return CursorStore.of({
    get: (sourceId) => Ref.get(cursors).pipe(Effect.map((map) => map.get(sourceId) ?? null)),
    set: (sourceId, cursor) =>
      Ref.update(cursors, (map) => {
        const next = new Map(map)
        next.set(sourceId, cursor)
        return next
      })
  })
})

/**
 * Layer for the in-memory store.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerMemory: Layer.Layer<CursorStore> = Layer.effect(CursorStore, makeMemory)

interface Row {
  readonly cursor: string | null
}

const storeError = (operation: string, sourceId: string, cause: unknown): IntegrationError =>
  new IntegrationError(
    "delivery-failed",
    `Integration cursor ${operation} failed for source "${sourceId}".`,
    { sourceId, operation },
    { cause }
  )

/**
 * A store over the control database's `smithers_integration_cursors` table, so
 * a polling source resumes where it stopped after a restart.
 *
 * Requires the migration in `core/Migrations` to have run.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeSql: Effect.Effect<CursorStore, never, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return CursorStore.of({
    get: (sourceId) =>
      sql<Row>`SELECT cursor FROM smithers_integration_cursors WHERE source_id = ${sourceId}`.pipe(
        Effect.map((rows) => rows[0]?.cursor ?? null),
        Effect.mapError((cause) => storeError("read", sourceId, cause))
      ),
    set: (sourceId, cursor) =>
      Effect.flatMap(
        Effect.clockWith((clock) => clock.currentTimeMillis),
        (now) =>
          sql`INSERT INTO smithers_integration_cursors (source_id, cursor, updated_at_ms)
            VALUES (${sourceId}, ${cursor}, ${now})
            ON CONFLICT (source_id) DO UPDATE SET cursor = excluded.cursor, updated_at_ms = excluded.updated_at_ms`
      ).pipe(
        Effect.asVoid,
        Effect.mapError((cause) => storeError("write", sourceId, cause))
      )
  })
})

/**
 * Layer for the SQL-backed store.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerSql: Layer.Layer<CursorStore, never, SqlClient.SqlClient> = Layer.effect(CursorStore, makeSql)
