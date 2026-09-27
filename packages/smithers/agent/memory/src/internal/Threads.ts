/**
 * Thread and message operations of the SQL memory store.
 *
 * @since 0.1.0
 */

import * as Dialect from "@smthrs/database/Dialect"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import type { DatabaseService } from "../Database.ts"
import type { Service } from "../MemoryStore.ts"
import { canonicalJson } from "./Canonical.ts"
import { resolveNamespace } from "./ResolveNamespace.ts"
import {
  changed,
  decodeJson,
  decodeThread,
  encodeJson,
  error,
  type Fragment,
  type MessageRow,
  storeError,
  type ThreadRow,
  validateLimit,
  validateNonEmpty,
  validateTime
} from "./Store.ts"

const THREAD_COLUMNS = "thread_id, namespace_kind, namespace_id, title, metadata_json, created_at_ms, updated_at_ms"
const MESSAGE_COLUMNS = "thread_id, id, role, text, at_ms"

const DELETE_MESSAGES_CHUNK_SIZE = 900

/**
 * Builds the thread and message operations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (database: DatabaseService, crypto: Crypto.Crypto): Pick<
  Service,
  | "createThread"
  | "getThread"
  | "listThreads"
  | "deleteThread"
  | "appendMessage"
  | "listMessages"
  | "countMessages"
  | "messageStats"
  | "listThreadIds"
  | "deleteMessages"
  | "compactMessages"
> => {
  const { sql } = database
  const threadColumns = sql.literal(THREAD_COLUMNS)
  const messageColumns = sql.literal(MESSAGE_COLUMNS)

  const getThread: Service["getThread"] = (input) =>
    Effect.gen(function*() {
      yield* validateNonEmpty(input.threadId, "threadId", ["threadId"])
      const rows = yield* sql<ThreadRow>`SELECT ${threadColumns}
        FROM memory_threads WHERE thread_id = ${input.threadId} LIMIT 1`.pipe(
        Effect.mapError(storeError("could not read memory thread"))
      )
      return rows[0] === undefined ? undefined : yield* decodeThread(rows[0])
    })

  const createThread: Service["createThread"] = (input) =>
    Effect.gen(function*() {
      const { namespace } = yield* resolveNamespace(input.namespace)
      const id = input.id ?? (yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => error("store", "could not generate memory thread id", cause))
      ))
      yield* validateNonEmpty(id, "threadId", ["id"])
      const metadataJson = input.metadata === undefined
        ? null
        : canonicalJson(
          yield* decodeJson(
            yield* encodeJson(input.metadata, "thread metadata", ["metadata"]),
            "thread metadata"
          )
        )
      const now = yield* Clock.currentTimeMillis
      return yield* database.write(
        Effect.gen(function*() {
          const inserted = yield* sql`INSERT INTO memory_threads (${threadColumns}) VALUES (
              ${id}, ${namespace.kind}, ${namespace.id}, ${input.title ?? null}, ${metadataJson}, ${now}, ${now}
            ) ON CONFLICT (thread_id) DO NOTHING`.raw
          const rows = yield* sql<ThreadRow>`SELECT ${threadColumns}
            FROM memory_threads WHERE thread_id = ${id} LIMIT 1`
          const existing = rows[0]
          if (existing === undefined) {
            return yield* Effect.fail(error("store", "created memory thread could not be read back"))
          }
          if (changed(inserted) === 0) {
            const existingMetadata = existing.metadata_json === null
              ? null
              : canonicalJson(yield* decodeJson(existing.metadata_json, "thread metadata"))
            if (
              existing.namespace_kind !== namespace.kind || existing.namespace_id !== namespace.id ||
              existing.title !== (input.title ?? null) || existingMetadata !== metadataJson
            ) {
              return yield* Effect.fail(
                error(
                  "idempotency_conflict",
                  `thread id "${id}" already exists with different creation data`,
                  undefined,
                  ["threadId"]
                )
              )
            }
          }
          return yield* decodeThread(existing)
        })
      ).pipe(Effect.mapError(storeError("could not create memory thread")))
    })

  const listThreads: Service["listThreads"] = (input = {}) =>
    Effect.gen(function*() {
      const namespace = input.namespace === undefined
        ? undefined
        : (yield* resolveNamespace(input.namespace)).namespace
      const where = namespace === undefined
        ? sql.literal("")
        : sql`WHERE namespace_kind = ${namespace.kind} AND namespace_id = ${namespace.id}`
      const rows = yield* sql<ThreadRow>`SELECT ${threadColumns}
        FROM memory_threads
        ${where}
        ORDER BY created_at_ms, thread_id`.pipe(
        Effect.mapError(storeError("could not list memory threads"))
      )
      return yield* Effect.forEach(rows, decodeThread)
    })

  const deleteThread: Service["deleteThread"] = (input) =>
    Effect.gen(function*() {
      yield* validateNonEmpty(input.threadId, "threadId", ["threadId"])
      return yield* database.write(
        Effect.gen(function*() {
          yield* sql`DELETE FROM memory_messages WHERE thread_id = ${input.threadId}`
          const result = yield* sql`DELETE FROM memory_threads WHERE thread_id = ${input.threadId}`.raw
          return changed(result) > 0
        })
      ).pipe(Effect.mapError(storeError("could not delete memory thread")))
    })

  const appendMessage: Service["appendMessage"] = (input) =>
    Effect.gen(function*() {
      yield* validateNonEmpty(input.threadId, "threadId", ["threadId"])
      yield* validateNonEmpty(input.id, "message id", ["id"])
      yield* validateNonEmpty(input.role, "message role", ["role"])
      yield* validateTime(input.at, "message at", ["at"])
      yield* database.write(
        Effect.gen(function*() {
          yield* sql`INSERT INTO memory_threads (
            thread_id, namespace_kind, namespace_id, created_at_ms, updated_at_ms
          )
            VALUES (${input.threadId}, 'global', 'history', ${input.at}, ${input.at})
            ON CONFLICT (thread_id) DO NOTHING`
          const inserted = yield* sql`INSERT INTO memory_messages (id, thread_id, role, text, at_ms)
            VALUES (${input.id}, ${input.threadId}, ${input.role}, ${input.text}, ${input.at})
            ON CONFLICT (thread_id, id) DO NOTHING`.raw
          if (changed(inserted) > 0) {
            yield* sql`UPDATE memory_threads
              SET updated_at_ms = ${Dialect.greatest(sql)}(updated_at_ms, ${input.at})
              WHERE thread_id = ${input.threadId}`
            return
          }
          const existing = yield* sql<MessageRow>`SELECT ${messageColumns}
            FROM memory_messages
            WHERE thread_id = ${input.threadId} AND id = ${input.id}
            LIMIT 1`
          const message = existing[0]
          if (message === undefined) {
            return yield* Effect.fail(error("store", "existing memory message could not be read back"))
          }
          const conflict = message.role !== input.role
            ? "role"
            : message.text !== input.text
            ? "text"
            : Number(message.at_ms) !== input.at
            ? "at"
            : undefined
          if (conflict !== undefined) {
            return yield* Effect.fail(
              error(
                "idempotency_conflict",
                `message id "${input.id}" already exists in thread "${input.threadId}" with different ${conflict}`,
                undefined,
                [conflict]
              )
            )
          }
        })
      ).pipe(Effect.mapError(storeError("could not append memory message")))
    })

  const listMessages: Service["listMessages"] = (input) =>
    Effect.gen(function*() {
      yield* validateNonEmpty(input.threadId, "threadId", ["threadId"])
      const limit = yield* validateLimit(input.limit, "listMessages")
      if (limit === 0) return []
      const conditions: Array<Fragment> = [sql`thread_id = ${input.threadId}`]
      if (input.cursor !== undefined) {
        yield* validateTime(input.cursor.at, "message cursor at", ["cursor", "at"])
        yield* validateNonEmpty(input.cursor.id, "message cursor id", ["cursor", "id"])
        conditions.push(
          sql`(at_ms > ${input.cursor.at} OR (at_ms = ${input.cursor.at} AND id > ${input.cursor.id}))`
        )
      }
      const bound = limit === undefined ? sql.literal("") : sql`LIMIT ${limit}`
      const rows = yield* sql<MessageRow>`SELECT ${messageColumns}
        FROM memory_messages
        WHERE ${sql.and(conditions)}
        ORDER BY at_ms, id
        ${bound}`.pipe(Effect.mapError(storeError("could not list memory messages")))
      return rows.map((row) => ({
        threadId: row.thread_id,
        id: row.id,
        role: row.role,
        text: row.text,
        at: Number(row.at_ms)
      }))
    })

  const countMessages: Service["countMessages"] = (input) =>
    Effect.gen(function*() {
      yield* validateNonEmpty(input.threadId, "threadId", ["threadId"])
      const rows = yield* sql<{ readonly count: number }>`
        SELECT count(*) AS count FROM memory_messages WHERE thread_id = ${input.threadId}
      `.pipe(Effect.mapError(storeError("could not count memory messages")))
      return Number(rows[0]?.count ?? 0)
    })

  const messageStats: Service["messageStats"] = (input) =>
    Effect.gen(function*() {
      yield* validateNonEmpty(input.threadId, "threadId", ["threadId"])
      const rows = yield* sql<{ readonly count: number; readonly code_points: number; readonly bytes: number }>`
        SELECT count(*) AS count,
          COALESCE(SUM(length(text)), 0) AS code_points,
          COALESCE(SUM(${
        sql.literal(Dialect.isPostgres(sql) ? "octet_length(text)" : "length(CAST(text AS BLOB))")
      }), 0) AS bytes
        FROM memory_messages WHERE thread_id = ${input.threadId}
      `.pipe(Effect.mapError(storeError("could not measure memory messages")))
      return {
        messages: Number(rows[0]?.count ?? 0),
        codePoints: Number(rows[0]?.code_points ?? 0),
        bytes: Number(rows[0]?.bytes ?? 0)
      }
    })

  const deleteMessageRows = (threadId: string, ids: ReadonlyArray<string>) =>
    Effect.gen(function*() {
      let deleted = 0
      for (let offset = 0; offset < ids.length; offset += DELETE_MESSAGES_CHUNK_SIZE) {
        const chunk = ids.slice(offset, offset + DELETE_MESSAGES_CHUNK_SIZE)
        const result = yield* sql`DELETE FROM memory_messages
          WHERE thread_id = ${threadId} AND ${sql.in("id", chunk)}`.raw
        deleted += changed(result)
      }
      return deleted
    })

  const listThreadIds: Service["listThreadIds"] = sql<{ readonly thread_id: string }>`
    SELECT thread_id FROM memory_threads ORDER BY created_at_ms, thread_id
  `.pipe(
    Effect.map((rows) => rows.map((row) => row.thread_id)),
    Effect.mapError(storeError("could not list memory threads"))
  )

  const deleteMessages: Service["deleteMessages"] = (input) =>
    Effect.gen(function*() {
      yield* validateNonEmpty(input.threadId, "threadId", ["threadId"])
      const ids = Array.from(new Set(input.ids))
      if (ids.length === 0) {
        return 0
      }
      return yield* database.write(deleteMessageRows(input.threadId, ids)).pipe(
        Effect.mapError(storeError("could not delete memory messages"))
      )
    })

  const compactMessages: Service["compactMessages"] = (input) => {
    // Capture scalar payloads now so caller mutation cannot change a suspended write.
    const threadId = input.threadId
    const summary = { ...input.summary }
    const sources = input.sourceMessages.map((message) => ({ ...message }))
    return Effect.gen(function*() {
      yield* validateNonEmpty(threadId, "threadId", ["threadId"])
      yield* validateNonEmpty(summary.id, "summary id", ["summary", "id"])
      yield* validateNonEmpty(summary.role, "summary role", ["summary", "role"])
      yield* validateTime(summary.at, "summary at", ["summary", "at"])
      if (summary.threadId !== threadId) {
        return yield* Effect.fail(
          error(
            "invalid_argument",
            "summary threadId must match the compacted thread",
            undefined,
            ["summary", "threadId"]
          )
        )
      }
      if (sources.some((message) => message.threadId !== threadId)) {
        return yield* Effect.fail(
          error("invalid_argument", "source threadId must match the compacted thread", undefined, ["sourceMessages"])
        )
      }
      const ids = Array.from(new Set(sources.map((message) => message.id))).filter((id) => id !== summary.id)
      if (ids.length === 0) {
        return 0
      }
      return yield* database.write(
        Effect.gen(function*() {
          // Preserve the existing-summary error even on a retry whose sources are gone.
          const existing = yield* sql<MessageRow>`SELECT ${messageColumns}
            FROM memory_messages WHERE thread_id = ${threadId} AND id = ${summary.id}`
          if (existing.length > 0) {
            return yield* Effect.fail(
              error(
                "idempotency_conflict",
                `summary id "${summary.id}" already exists`,
                undefined,
                ["summary", "id"]
              )
            )
          }
          for (let offset = 0; offset < sources.length; offset += DELETE_MESSAGES_CHUNK_SIZE) {
            const chunk = sources.slice(offset, offset + DELETE_MESSAGES_CHUNK_SIZE)
            const rows = yield* sql<MessageRow>`SELECT ${messageColumns}
              FROM memory_messages WHERE thread_id = ${threadId} AND ${
              sql.in("id", chunk.map((message) => message.id))
            }`
            const byId = new Map(rows.map((row) => [row.id, row]))
            for (const source of chunk) {
              const row = byId.get(source.id)
              if (
                row === undefined || row.role !== source.role || row.text !== source.text ||
                Number(row.at_ms) !== source.at
              ) {
                return yield* Effect.fail(
                  error(
                    "compaction_conflict",
                    `source message "${source.id}" changed or disappeared before compaction`,
                    undefined,
                    ["sourceMessages"]
                  )
                )
              }
            }
          }
          yield* sql`INSERT INTO memory_messages (id, thread_id, role, text, at_ms)
            VALUES (${summary.id}, ${summary.threadId}, ${summary.role}, ${summary.text}, ${summary.at})`
          return yield* deleteMessageRows(threadId, ids)
        })
      ).pipe(Effect.mapError(storeError("could not compact memory history")))
    })
  }

  return {
    createThread,
    getThread,
    listThreads,
    deleteThread,
    appendMessage,
    listMessages,
    countMessages,
    messageStats,
    listThreadIds,
    deleteMessages,
    compactMessages
  }
}
