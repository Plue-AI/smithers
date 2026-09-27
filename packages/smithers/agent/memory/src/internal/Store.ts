/**
 * Row shapes, decoders, and validators shared by the memory store domains.
 *
 * @since 0.1.0
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { MemoryError } from "../MemoryError.ts"
import type { Fact, ListNotesInput, Note, NoteStatus, Provenance, SearchRowsInput, Thread } from "../MemoryStore.ts"
import * as Namespace from "../Namespace.ts"

/**
 * A raw `memory_facts` row.
 *
 * @category models
 * @since 0.1.0
 */
export interface FactRow {
  readonly namespace_kind: Namespace.Kind
  readonly namespace_id: string
  readonly fact_key: string
  readonly value_json: string
  readonly tags_json: string | null
  readonly ttl_ms: number | null
  readonly provenance_json: string
  readonly created_at_ms: number
  readonly updated_at_ms: number
}

/**
 * A raw `memory_messages` row.
 *
 * @category models
 * @since 0.1.0
 */
export interface MessageRow {
  readonly thread_id: string
  readonly id: string
  readonly role: string
  readonly text: string
  readonly at_ms: number
}

/**
 * A raw `memory_threads` row.
 *
 * @category models
 * @since 0.1.0
 */
export interface ThreadRow {
  readonly thread_id: string
  readonly namespace_kind: Namespace.Kind
  readonly namespace_id: string
  readonly title: string | null
  readonly metadata_json: string | null
  readonly created_at_ms: number
  readonly updated_at_ms: number
}

/**
 * A raw `memory_notes` row.
 *
 * @category models
 * @since 0.1.0
 */
export interface NoteRow {
  readonly namespace_kind: Namespace.Kind
  readonly namespace_id: string
  readonly id: string
  readonly text: string
  readonly tags_json: string
  readonly provenance_json: string
  readonly status: NoteStatus
  readonly created_at_ms: number
}

/**
 * A composable SQL condition. `effect/unstable/sql` publishes no entry point
 * for its `Statement` module, so the type is read back off `sql.literal`.
 *
 * @category models
 * @since 0.1.0
 */
export type Fragment = ReturnType<SqlClient.SqlClient["literal"]>

// An Error is kept whole so its SQL code, message, and nested cause survive:
// DurableWriter classifies a nested write's retry by walking the cause chain
// of the domain error a store wraps it in, and an operator reading the failure
// needs the driver text. Only unstructured values are bounded.
const causeSummary = (cause: unknown): unknown => {
  if (cause instanceof Error) {
    return cause
  }
  if (typeof cause === "string") {
    return cause.slice(0, 1_024)
  }
  return { type: cause === null ? "null" : typeof cause }
}

/**
 * Builds a memory error with a bounded cause.
 *
 * @category constructors
 * @since 0.1.0
 */
export const error = (
  code: MemoryError["code"],
  message: string,
  cause?: unknown,
  path?: ReadonlyArray<string>
): MemoryError =>
  new MemoryError({
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(cause === undefined ? {} : { cause: causeSummary(cause) })
  })

const isMemoryError = (cause: unknown): cause is MemoryError => cause instanceof MemoryError

/**
 * Wraps a non-memory failure as a `store` error.
 *
 * @category constructors
 * @since 0.1.0
 */
export const storeError = (message: string) => (cause: unknown): MemoryError =>
  isMemoryError(cause) ? cause : error("store", message, cause)

/**
 * Reads the affected-row count from a raw driver result.
 *
 * @category utils
 * @since 0.1.0
 */
export const changed = (result: unknown): number => {
  if (typeof result !== "object" || result === null) {
    return 0
  }
  const changes = "changes" in result ? result.changes : undefined
  const rowsAffected = "rowCount" in result
    ? result.rowCount
    : "rowsAffected" in result
    ? result.rowsAffected
    : undefined
  return typeof changes === "number"
    ? changes
    : typeof rowsAffected === "number"
    ? rowsAffected
    : 0
}

/**
 * Validates tags against the memory vocabulary and cap.
 *
 * @category validation
 * @since 0.1.0
 */
export const validateTags = (tags: Namespace.Tags): Effect.Effect<Namespace.Tags, MemoryError> =>
  Schema.decodeUnknownEffect(Namespace.Tags)(tags).pipe(
    Effect.mapError(() => error("invalid_tag", "memory tags violate the vocabulary or 16-tag cap"))
  )

/**
 * Rejects an empty identifier.
 *
 * @category validation
 * @since 0.1.0
 */
export const validateNonEmpty = (
  value: string,
  field: string,
  path: ReadonlyArray<string>
): Effect.Effect<string, MemoryError> =>
  value.length > 0
    ? Effect.succeed(value)
    : Effect.fail(error("invalid_argument", `${field} must not be empty`, undefined, path))

/**
 * Rejects a time that is not a non-negative safe integer.
 *
 * @category validation
 * @since 0.1.0
 */
export const validateTime = (
  value: number,
  field: string,
  path: ReadonlyArray<string>
): Effect.Effect<number, MemoryError> =>
  Number.isSafeInteger(value) && value >= 0
    ? Effect.succeed(value)
    : Effect.fail(error("invalid_argument", `${field} must be a non-negative safe integer`, undefined, path))

/**
 * Rejects a limit that is not a non-negative safe integer.
 *
 * @category validation
 * @since 0.1.0
 */
export const validateLimit = (
  value: number | undefined,
  operation: string
): Effect.Effect<number | undefined, MemoryError> =>
  value === undefined || (Number.isSafeInteger(value) && value >= 0)
    ? Effect.succeed(value)
    : Effect.fail(
      error("invalid_argument", `${operation} limit must be a non-negative safe integer`, undefined, ["limit"])
    )

/**
 * Encodes a value as JSON or fails `invalid_argument`.
 *
 * @category utils
 * @since 0.1.0
 */
export const encodeJson = (
  value: unknown,
  field: string,
  path: ReadonlyArray<string>
): Effect.Effect<string, MemoryError> =>
  Effect.try({
    try: () => {
      const encoded = JSON.stringify(value)
      if (encoded === undefined) {
        throw new TypeError(`${field} is not JSON-serializable`)
      }
      return encoded
    },
    catch: () => error("invalid_argument", `${field} is not JSON-serializable`, undefined, path)
  })

/**
 * Decodes stored JSON or fails `store`.
 *
 * @category utils
 * @since 0.1.0
 */
export const decodeJson = (value: string, field: string): Effect.Effect<unknown, MemoryError> =>
  Effect.try({
    try: () => JSON.parse(value) as unknown,
    catch: (cause) => error("store", `could not decode ${field}`, cause)
  })

const decodeProvenance = (value: string): Effect.Effect<Provenance, MemoryError> =>
  decodeJson(value, "provenance").pipe(
    Effect.flatMap((decoded) =>
      typeof decoded === "object" && decoded !== null
        ? Effect.succeed(decoded as Provenance)
        : Effect.fail(error("store", "stored provenance is not an object"))
    )
  )

const decodeTags = (value: string): Effect.Effect<Namespace.Tags, MemoryError> =>
  decodeJson(value, "tags").pipe(
    Effect.flatMap((decoded) =>
      Schema.decodeUnknownEffect(Namespace.Tags)(decoded).pipe(
        Effect.mapError((cause) => error("invalid_tag", "stored tags violate the memory vocabulary", cause))
      )
    )
  )

/**
 * Decodes a fact row.
 *
 * @category utils
 * @since 0.1.0
 */
export const decodeFact = (row: FactRow): Effect.Effect<Fact, MemoryError> =>
  Effect.all({
    value: decodeJson(row.value_json, "fact value"),
    tags: row.tags_json === null ? Effect.succeed(undefined) : decodeTags(row.tags_json),
    provenance: decodeProvenance(row.provenance_json)
  }).pipe(
    Effect.map(({ provenance, tags, value }) => ({
      namespace: { kind: row.namespace_kind, id: row.namespace_id },
      key: row.fact_key,
      value,
      ...(tags === undefined ? {} : { tags }),
      ...(row.ttl_ms === null ? {} : { ttlMs: Number(row.ttl_ms) }),
      provenance,
      createdAtMs: Number(row.created_at_ms),
      updatedAtMs: Number(row.updated_at_ms)
    }))
  )

/**
 * Decodes a note row.
 *
 * @category utils
 * @since 0.1.0
 */
export const decodeNote = (row: NoteRow): Effect.Effect<Note, MemoryError> =>
  Effect.all({
    tags: decodeTags(row.tags_json),
    provenance: decodeProvenance(row.provenance_json)
  }).pipe(
    Effect.map(({ provenance, tags }) => ({
      namespace: { kind: row.namespace_kind, id: row.namespace_id },
      id: row.id,
      text: row.text,
      tags,
      provenance,
      status: row.status,
      createdAtMs: Number(row.created_at_ms)
    }))
  )

/**
 * Decodes a thread row.
 *
 * @category utils
 * @since 0.1.0
 */
export const decodeThread = (row: ThreadRow): Effect.Effect<Thread, MemoryError> =>
  (row.metadata_json === null
    ? Effect.succeed(undefined)
    : decodeJson(row.metadata_json, "thread metadata")).pipe(
      Effect.map((metadata) => ({
        id: row.thread_id,
        namespace: { kind: row.namespace_kind, id: row.namespace_id },
        ...(row.title === null ? {} : { title: row.title }),
        ...(metadata === undefined ? {} : { metadata }),
        createdAtMs: Number(row.created_at_ms),
        updatedAtMs: Number(row.updated_at_ms)
      }))
    )

/**
 * Rows a tag-filtered note read pulls per round trip.
 *
 * A tag group is evaluated in JavaScript, so a bounded read pages until it has
 * `limit` matching rows instead of taking one oversized window. These two
 * numbers are the page, not the answer: they bound working-set memory and the
 * per-query cost, never how many rows the caller gets back.
 *
 * @category constants
 * @since 0.1.0
 */
export const NOTE_PAGE_SIZE = 512
/**
 * Smallest page a tag-filtered read pulls.
 *
 * @category constants
 * @since 0.1.0
 */
export const MIN_NOTE_PAGE_SIZE = 128

// Continue from the last examined row, including pages that keep no matches.
/**
 * Pages until `limit` kept rows or the source runs out.
 *
 * @category utils
 * @since 0.1.0
 */
export const collectUntil = <Row, A>(
  limit: number,
  pageSize: number,
  fetchPage: (pageSize: number, after: Row | undefined) => Effect.Effect<ReadonlyArray<Row>, MemoryError>,
  keep: (rows: ReadonlyArray<Row>) => Effect.Effect<ReadonlyArray<A>, MemoryError>
): Effect.Effect<ReadonlyArray<A>, MemoryError> =>
  Effect.gen(function*() {
    const collected: Array<A> = []
    let after: Row | undefined
    while (collected.length < limit) {
      const rows = yield* fetchPage(pageSize, after)
      if (rows.length === 0) break
      collected.push(...(yield* keep(rows)).slice(0, limit - collected.length))
      if (rows.length < pageSize) break
      after = rows[rows.length - 1]!
    }
    return collected
  })

/**
 * Builds the tag-group predicate of a read.
 *
 * @category utils
 * @since 0.1.0
 */
export const tagMatcher = (input: Pick<ListNotesInput, "tagGroups">) => (tags: ReadonlyArray<string>): boolean =>
  input.tagGroups === undefined || input.tagGroups.every((group) => Namespace.matches(group, tags))

/**
 * Validates exact search record identities.
 *
 * @category validation
 * @since 0.1.0
 */
export const validateRecords = (records: SearchRowsInput["records"], operation: "searchRows" | "searchFts") =>
  Effect.gen(function*() {
    if (records === undefined) return
    if (records.length > 64) {
      return yield* Effect.fail(error("invalid_argument", `${operation} accepts at most 64 record identities`))
    }
    for (const record of records) {
      if (record.kind !== "fact" && record.kind !== "note") {
        return yield* Effect.fail(error("invalid_argument", `${operation} record kind must be fact or note`))
      }
      yield* validateNonEmpty(record.id, "record id", ["records", "id"])
    }
  })
