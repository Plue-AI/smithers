/**
 * Durable storage and authorized retrieval for source records.
 *
 * Every record an integration retrieves lands here, keyed by its connection
 * and external id. Four properties are the reason this is a store rather than
 * a table anyone writes:
 *
 * - **Monotonic apply.** A copy replaces the stored one only when
 *   `SourceRecord.supersedes` says it is newer, so duplicates are no-ops and
 *   edits delivered out of order converge on the newest copy. At an equal
 *   change time, deletion and version, a copy retrieved later whose content
 *   differs replaces the stored one: a provider that edits an object twice
 *   within its clock's resolution still ends up with the second edit.
 * - **Tombstones and revocation purge content.** A deleted record keeps its
 *   identity, placement, times and version, and loses its text, payload,
 *   author and link. Revoking a connection or one container of it does the
 *   same to every record there and leaves a revocation marker, so a sync that
 *   races the revocation stores metadata only. `reinstate` removes a marker;
 *   purged records return when a sync lists them again. A deletion a full
 *   listing inferred from absence yields the same way: a later copy at least as
 *   new as the one it removed restores the record.
 * - **Authorization before text.** `retrieve` takes the grants the caller
 *   holds and filters on them, and on deletion and revocation, inside the
 *   query: the text of a record the caller may not read never leaves the
 *   database. A record is readable through a grant for its connection that
 *   covers every container it lives in (`SourceRecord.containers`); a record in
 *   no container needs the connection-wide `*`.
 * - **One transaction per sync page.** `commit` applies a page of changes,
 *   runs the mark-and-sweep a fresh full listing needs, and advances the
 *   stream's cursor in `smithers_integration_cursors` together, so a crash
 *   leaves either all of it or none of it.
 *
 * `validate` answers, for references a run kept, whether each is still the
 * readable copy it used, so a resumed run refuses revoked or deleted context
 * explicitly instead of reusing a stale snapshot.
 *
 * The SQL store requires `Core.Migrations` to have run.
 *
 * @since 1.0.0
 */

import { affectedRows, DurableWriter } from "@smthrs/database/DurableWriter"
import { Context, Effect, Layer, Option, Ref, Schema, Semaphore } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { Fragment } from "effect/unstable/sql/Statement"
import * as CursorStore from "./CursorStore.ts"
import { IntegrationError, isIntegrationError } from "./IntegrationError.ts"
import * as SourceRecord from "./SourceRecord.ts"
import type { Changes } from "./Sync.ts"

/**
 * The container id a grant uses to cover a whole connection, and the
 * revocation marker for a whole connection.
 *
 * @category constants
 * @since 1.0.0
 */
export const WILDCARD = "*"

/**
 * The most records one `retrieve` returns.
 *
 * @category constants
 * @since 1.0.0
 */
export const MAX_RETRIEVE_LIMIT = 500

/**
 * What a caller may read of one connection: the containers it is granted, or
 * `["*"]` for all of them. An empty list reads nothing.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Grant = Schema.Struct({
  connectionId: Schema.NonEmptyString,
  containers: Schema.Array(Schema.NonEmptyString)
})

/**
 * What a caller may read of one connection.
 *
 * @category models
 * @since 1.0.0
 */
export type Grant = typeof Grant.Type

/**
 * Whether one of `allowed` covers `record`: a grant for its connection that
 * is connection-wide, or that names every container the record lives in.
 *
 * @category authorization
 * @since 1.0.0
 */
export const covers = (
  allowed: ReadonlyArray<Grant>,
  record: Pick<SourceRecord.SourceRecord, "connectionId" | "access" | "thread">
): boolean => {
  const inside = SourceRecord.containers(record)
  return allowed.some((grant) =>
    grant.connectionId === record.connectionId &&
    (grant.containers.includes(WILDCARD) ||
      (inside.length > 0 && inside.every((container) => grant.containers.includes(container))))
  )
}

/**
 * One stored record, as the store holds it.
 *
 * `record` is purged (no text, payload, author or link) when it is deleted or
 * revoked. `stream` is the sync stream that last listed it, or `null` for a
 * record that only ever arrived through `apply`.
 *
 * @category models
 * @since 1.0.0
 */
export interface Stored {
  readonly record: SourceRecord.SourceRecord
  readonly revoked: boolean
  readonly stream: string | null
}

/**
 * What a `retrieve` asks for.
 *
 * @category models
 * @since 1.0.0
 */
export interface Query {
  /** The grants the reader holds. Nothing outside them is returned. */
  readonly allowed: ReadonlyArray<Grant>
  /** Case-insensitive (ASCII) substring of the record text. */
  readonly query?: string | undefined
  /** Only these kinds. An empty list selects nothing. */
  readonly kinds?: ReadonlyArray<string> | undefined
  /**
   * At most this many records, newest first by change time, or creation time
   * for a provider without one; 1 to {@link MAX_RETRIEVE_LIMIT}.
   */
  readonly limit: number
}

/**
 * Whether a kept reference is still usable.
 *
 * `current` is the only usable answer: the record is readable by the caller
 * and is the copy the reference names. `changed` means readable but edited
 * since; `deleted`, `revoked`, `denied` (no grant covers it now) and
 * `missing` are refusals.
 *
 * @category models
 * @since 1.0.0
 */
export type Validity = "current" | "changed" | "deleted" | "revoked" | "denied" | "missing"

/**
 * One reference's answer from `validate`.
 *
 * @category models
 * @since 1.0.0
 */
export interface Validation {
  readonly reference: SourceRecord.Reference
  readonly validity: Validity
}

/**
 * What one `apply` or page did.
 *
 * `tombstoned` counts the inserted and updated records that are deletions.
 *
 * @category models
 * @since 1.0.0
 */
export interface ApplyReport {
  readonly inserted: number
  readonly updated: number
  readonly unchanged: number
  readonly tombstoned: number
}

/**
 * One page of one stream's changes, as `commit` applies it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Page {
  readonly provider: string
  readonly connectionId: string
  readonly stream: string
  readonly changes: Changes
}

/**
 * What one committed page did, including the sweep a completed full listing
 * ran.
 *
 * @category models
 * @since 1.0.0
 */
export interface CommitReport extends ApplyReport {
  /** Records the completed full listing did not contain, now tombstones. */
  readonly swept: number
  /** Whether a full listing is still in progress after this page. */
  readonly sweeping: boolean
}

/**
 * The store service.
 *
 * @category services
 * @since 1.0.0
 */
export interface SourceStore {
  /** Applies records monotonically in one transaction. */
  readonly apply: (records: ReadonlyArray<SourceRecord.SourceRecord>) => Effect.Effect<ApplyReport, IntegrationError>
  /** The stored copy, unfiltered. Host code only: this is not an authorized read. */
  readonly get: (connectionId: string, externalId: string) => Effect.Effect<Option.Option<Stored>, IntegrationError>
  /** Readable, live, unrevoked records the grants cover, filtered before any text is read. */
  readonly retrieve: (query: Query) => Effect.Effect<ReadonlyArray<SourceRecord.SourceRecord>, IntegrationError>
  /** Whether each reference is still the readable copy it names. */
  readonly validate: (options: {
    readonly allowed: ReadonlyArray<Grant>
    readonly references: ReadonlyArray<SourceRecord.Reference>
  }) => Effect.Effect<ReadonlyArray<Validation>, IntegrationError>
  /** Withdraws a connection: purges its records and refuses content from later syncs. Returns records purged. */
  readonly revokeConnection: (connectionId: string) => Effect.Effect<number, IntegrationError>
  /** Withdraws one container of a connection. Returns records purged. */
  readonly revokeContainer: (connectionId: string, containerId: string) => Effect.Effect<number, IntegrationError>
  /** Removes one revocation marker; `containerId` omitted removes the connection-wide one. */
  readonly reinstate: (connectionId: string, containerId?: string | undefined) => Effect.Effect<void, IntegrationError>
  /** Whether the connection, or the named container of it, is revoked. */
  readonly isRevoked: (
    connectionId: string,
    containerId?: string | undefined
  ) => Effect.Effect<boolean, IntegrationError>
  /** The committed cursor of one stream, or `null` before its first page. */
  readonly cursor: (connectionId: string, stream: string) => Effect.Effect<string | null, IntegrationError>
  /** Applies one page, sweeps a completed full listing, and advances the cursor, in one transaction. */
  readonly commit: (page: Page) => Effect.Effect<CommitReport, IntegrationError>
}

/**
 * Service tag for the source record store.
 *
 * @category services
 * @since 1.0.0
 */
export const SourceStore: Context.Service<SourceStore, SourceStore> = Context.Service(
  "@smthrs/integrations/SourceStore"
)

/**
 * The key a stream's cursor is stored under in the cursor table:
 * `connectionId:stream`. Connection ids carry no colon, so the key is
 * unambiguous.
 *
 * @category getters
 * @since 1.0.0
 */
export const cursorKey = (connectionId: string, stream: string): string => `${connectionId}:${stream}`

// ---------------------------------------------------------------------------
// Shared rules. Both backends run exactly this logic; only storage differs.
// ---------------------------------------------------------------------------

const decodeRecord = Schema.decodeUnknownEffect(SourceRecord.SourceRecord)

const finiteOrNull = (value: number | null): boolean => value === null || Number.isFinite(value)

const invalid = (message: string, details: Record<string, unknown>): IntegrationError =>
  new IntegrationError("invalid-config", message, { ...details, retryable: false })

/** Validates a record before anything is written, so a bad one fails the whole batch untouched. */
const admit = (record: SourceRecord.SourceRecord): Effect.Effect<SourceRecord.SourceRecord, IntegrationError> =>
  decodeRecord(record).pipe(
    Effect.mapError((cause) =>
      new IntegrationError(
        "decode-failed",
        "A source record does not match the SourceRecord schema.",
        { externalId: typeof record?.externalId === "string" ? record.externalId.slice(0, 128) : null },
        { cause }
      )
    ),
    Effect.filterOrFail(
      (decoded) =>
        finiteOrNull(decoded.createdAtMs) && finiteOrNull(decoded.updatedAtMs) &&
        Number.isFinite(decoded.retrievedAtMs),
      (decoded) =>
        new IntegrationError(
          "decode-failed",
          "A source record carries a time that is not a finite number of milliseconds.",
          { externalId: decoded.externalId.slice(0, 128) }
        )
    )
  )

const purge = (record: SourceRecord.SourceRecord): SourceRecord.SourceRecord => ({
  ...record,
  url: null,
  author: null,
  text: "",
  payload: null
})

/** Everything a copy says apart from when it was retrieved. */
const content = (record: SourceRecord.SourceRecord): string =>
  JSON.stringify([
    record.provider,
    record.kind,
    record.url,
    record.author === null ? null : [record.author.id, record.author.label],
    record.createdAtMs,
    record.access.scope,
    record.access.containerId,
    record.thread.containerId,
    record.thread.threadId,
    record.thread.parentId,
    record.text,
    JSON.stringify(record.payload)
  ])

type Decision = "insert" | "replace" | "keep"

/**
 * A stored copy as the shared rules read it. `swept` marks a deletion a
 * completed full listing inferred from the record's absence: it keeps the
 * change time and version of the copy it removed, so it must not outrank that
 * copy the way a provider's deletion at the same time does.
 */
interface Current {
  readonly stored: Stored
  readonly swept: boolean
}

const decide = (current: Current | undefined, candidate: SourceRecord.SourceRecord, revokedNow: boolean): Decision => {
  if (current === undefined) return "insert"
  const stored = current.stored
  // An inferred absence yields to a live copy at least as new as the one it
  // removed; a stale live copy still loses.
  const ordering = current.swept && !candidate.deleted ? { ...stored.record, deleted: false } : stored.record
  const order = SourceRecord.compare(ordering, candidate)
  if (order !== 0) return order > 0 ? "replace" : "keep"
  // Equal copies: restore a swept record (or confirm its deletion as the
  // provider's), purge a row newly known to be revoked, restore a row whose
  // revocation was lifted, and otherwise take a fresher, different observation.
  if (current.swept) return "replace"
  if (stored.revoked !== revokedNow) return "replace"
  if (revokedNow) return "keep"
  return candidate.retrievedAtMs > stored.record.retrievedAtMs && content(candidate) !== content(stored.record)
    ? "replace"
    : "keep"
}

const isRevokedIn = (markers: ReadonlySet<string>, record: SourceRecord.SourceRecord): boolean =>
  markers.has(WILDCARD) || SourceRecord.containers(record).some((container) => markers.has(container))

interface StreamState {
  readonly generation: number
  readonly sweeping: boolean
}

/** The storage port the shared rules run against, inside one transaction. */
interface Tables {
  readonly read: (connectionId: string, externalId: string) => Effect.Effect<Current | undefined, IntegrationError>
  /** Writes a copy the rules decided on; a written copy is never swept. */
  readonly write: (stored: Stored) => Effect.Effect<void, IntegrationError>
  readonly mark: (
    connectionId: string,
    externalId: string,
    stream: string,
    generation: number
  ) => Effect.Effect<void, IntegrationError>
  readonly markers: (connectionId: string) => Effect.Effect<ReadonlySet<string>, IntegrationError>
  readonly stream: (connectionId: string, stream: string) => Effect.Effect<StreamState, IntegrationError>
  readonly setStream: (
    connectionId: string,
    stream: string,
    state: StreamState,
    nowMs: number
  ) => Effect.Effect<void, IntegrationError>
  readonly sweep: (
    connectionId: string,
    stream: string,
    generation: number,
    nowMs: number
  ) => Effect.Effect<number, IntegrationError>
  readonly setCursor: (key: string, cursor: string) => Effect.Effect<void, IntegrationError>
}

const emptyReport: ApplyReport = { inserted: 0, updated: 0, unchanged: 0, tombstoned: 0 }

const applyAll = (
  tables: Tables,
  records: ReadonlyArray<SourceRecord.SourceRecord>,
  mark?: { readonly stream: string; readonly generation: number }
): Effect.Effect<ApplyReport, IntegrationError> =>
  Effect.gen(function*() {
    const markers = new Map<string, ReadonlySet<string>>()
    let report = emptyReport
    for (const record of records) {
      let connectionMarkers = markers.get(record.connectionId)
      if (connectionMarkers === undefined) {
        connectionMarkers = yield* tables.markers(record.connectionId)
        markers.set(record.connectionId, connectionMarkers)
      }
      const revokedNow = isRevokedIn(connectionMarkers, record)
      const candidate = record.deleted || revokedNow ? purge(record) : record
      const current = yield* tables.read(record.connectionId, record.externalId)
      const decision = decide(current, candidate, revokedNow)
      if (decision !== "keep") {
        yield* tables.write({ record: candidate, revoked: revokedNow, stream: current?.stored.stream ?? null })
      }
      if (mark !== undefined) yield* tables.mark(record.connectionId, record.externalId, mark.stream, mark.generation)
      report = {
        inserted: report.inserted + (decision === "insert" ? 1 : 0),
        updated: report.updated + (decision === "replace" ? 1 : 0),
        unchanged: report.unchanged + (decision === "keep" ? 1 : 0),
        tombstoned: report.tombstoned + (decision !== "keep" && candidate.deleted ? 1 : 0)
      }
    }
    return report
  })

const admitAll = (records: ReadonlyArray<SourceRecord.SourceRecord>) => Effect.forEach(records, admit)

const checkConnectionId = (connectionId: string): Effect.Effect<void, IntegrationError> =>
  typeof connectionId === "string" && connectionId.length > 0 && !connectionId.includes(":")
    ? Effect.void
    : Effect.fail(invalid("A connection id must be a non-empty string with no colon.", { connectionId }))

const checkContainerId = (containerId: string): Effect.Effect<void, IntegrationError> =>
  typeof containerId === "string" && containerId.length > 0 && containerId !== WILDCARD
    ? Effect.void
    : Effect.fail(
      invalid("A container id must be a non-empty string other than the connection-wide \"*\".", { containerId })
    )

const admitPage = (page: Page): Effect.Effect<ReadonlyArray<SourceRecord.SourceRecord>, IntegrationError> =>
  Effect.gen(function*() {
    yield* checkConnectionId(page.connectionId)
    if (typeof page.stream !== "string" || page.stream.length === 0) {
      return yield* Effect.fail(invalid("A sync stream must be a non-empty string.", { stream: page.stream }))
    }
    const records = yield* admitAll(page.changes.records)
    // An adapter bound to one connection must not write into another one's
    // records: that would move data across a grant boundary.
    const foreign = records.find((record) =>
      record.connectionId !== page.connectionId || record.provider !== page.provider
    )
    if (foreign !== undefined) {
      return yield* Effect.fail(
        invalid("A sync page carries a record from another connection or provider.", {
          connectionId: page.connectionId,
          provider: page.provider,
          recordConnectionId: foreign.connectionId,
          recordProvider: foreign.provider
        })
      )
    }
    return records
  })

const commitPage = (
  tables: Tables,
  page: Page,
  records: ReadonlyArray<SourceRecord.SourceRecord>,
  nowMs: number
): Effect.Effect<CommitReport, IntegrationError> =>
  Effect.gen(function*() {
    const previous = yield* tables.stream(page.connectionId, page.stream)
    const state: StreamState = page.changes.reset
      ? { generation: previous.generation + 1, sweeping: true }
      : previous
    const applied = yield* applyAll(tables, records, { stream: page.stream, generation: state.generation })
    const sweep = state.sweeping && page.changes.done
    const swept = sweep ? yield* tables.sweep(page.connectionId, page.stream, state.generation, nowMs) : 0
    yield* tables.setStream(page.connectionId, page.stream, {
      generation: state.generation,
      sweeping: !sweep && state.sweeping
    }, nowMs)
    if (page.changes.cursor !== null) {
      yield* tables.setCursor(cursorKey(page.connectionId, page.stream), page.changes.cursor)
    }
    return { ...applied, swept, sweeping: !sweep && state.sweeping }
  })

const classify = (
  stored: Stored | undefined,
  marked: boolean,
  reference: SourceRecord.Reference,
  allowed: ReadonlyArray<Grant>
): Validity => {
  if (stored === undefined) return "missing"
  if (stored.revoked || marked) return "revoked"
  if (!covers(allowed, stored.record)) return "denied"
  if (stored.record.deleted) return "deleted"
  const record = stored.record
  return record.updatedAtMs === reference.updatedAtMs && record.version === reference.version &&
      record.retrievedAtMs === reference.retrievedAtMs
    ? "current"
    : "changed"
}

const checkLimit = (limit: number): Effect.Effect<number, IntegrationError> =>
  Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_RETRIEVE_LIMIT
    ? Effect.succeed(limit)
    : Effect.fail(invalid(`A retrieve limit must be an integer between 1 and ${MAX_RETRIEVE_LIMIT}.`, { limit }))

// SQLite's lower() folds ASCII only; the memory store folds the same way.
const asciiLower = (text: string): string => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

const now = Effect.clockWith((clock) => clock.currentTimeMillis)

const newestFirst = (left: SourceRecord.SourceRecord, right: SourceRecord.SourceRecord): number => {
  const leftAt = left.updatedAtMs ?? left.createdAtMs
  const rightAt = right.updatedAtMs ?? right.createdAtMs
  if (leftAt !== rightAt) {
    if (leftAt === null) return 1
    if (rightAt === null) return -1
    return rightAt - leftAt
  }
  if (left.connectionId !== right.connectionId) return left.connectionId < right.connectionId ? -1 : 1
  // Keys are unique, so two records never tie on both.
  return left.externalId < right.externalId ? -1 : 1
}

// ---------------------------------------------------------------------------
// Memory backend.
// ---------------------------------------------------------------------------

interface MemoryRow {
  readonly stored: Stored
  readonly seenGeneration: number
  readonly swept: boolean
}

interface MemoryState {
  readonly records: Map<string, MemoryRow>
  readonly streams: Map<string, StreamState>
  readonly revocations: Map<string, Set<string>>
  readonly cursors: Map<string, string>
}

const pair = (left: string, right: string): string => JSON.stringify([left, right])

const cloneState = (state: MemoryState): MemoryState => ({
  records: new Map(state.records),
  streams: new Map(state.streams),
  revocations: new Map(Array.from(state.revocations, ([id, markers]) => [id, new Set(markers)])),
  cursors: new Map(state.cursors)
})

const memoryTables = (draft: MemoryState): Tables => ({
  read: (connectionId, externalId) =>
    Effect.sync(() => {
      const row = draft.records.get(pair(connectionId, externalId))
      return row === undefined ? undefined : { stored: row.stored, swept: row.swept }
    }),
  write: (stored) =>
    Effect.sync(() => {
      const key = pair(stored.record.connectionId, stored.record.externalId)
      draft.records.set(key, { stored, seenGeneration: draft.records.get(key)?.seenGeneration ?? 0, swept: false })
    }),
  mark: (connectionId, externalId, stream, generation) =>
    Effect.sync(() => {
      const key = pair(connectionId, externalId)
      const row = draft.records.get(key)!
      draft.records.set(key, { ...row, stored: { ...row.stored, stream }, seenGeneration: generation })
    }),
  markers: (connectionId) => Effect.sync(() => new Set(draft.revocations.get(connectionId) ?? [])),
  stream: (connectionId, stream) =>
    Effect.sync(() => draft.streams.get(pair(connectionId, stream)) ?? { generation: 0, sweeping: false }),
  setStream: (connectionId, stream, state) =>
    Effect.sync(() => void draft.streams.set(pair(connectionId, stream), state)),
  sweep: (connectionId, stream, generation, nowMs) =>
    Effect.sync(() => {
      let swept = 0
      for (const [key, row] of draft.records) {
        const record = row.stored.record
        if (
          record.connectionId !== connectionId || row.stored.stream !== stream || record.deleted ||
          row.seenGeneration >= generation
        ) continue
        draft.records.set(key, {
          ...row,
          stored: { ...row.stored, record: { ...purge(record), deleted: true, retrievedAtMs: nowMs } },
          swept: true
        })
        swept += 1
      }
      return swept
    }),
  setCursor: (key, cursor) => Effect.sync(() => void draft.cursors.set(key, cursor))
})

/**
 * An in-memory store with the same rules as the SQL one. Records live as long
 * as the process, which is what a test and an ephemeral host want.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeMemory: Effect.Effect<SourceStore> = Effect.gen(function*() {
  const state = yield* Ref.make<MemoryState>({
    records: new Map(),
    streams: new Map(),
    revocations: new Map(),
    cursors: new Map()
  })
  const lock = yield* Semaphore.make(1)

  // A draft copy stands in for the transaction: it is published only when the
  // whole body succeeds, so a failure leaves the store exactly as it was.
  const transact = <A>(body: (tables: Tables, draft: MemoryState) => Effect.Effect<A, IntegrationError>) =>
    lock.withPermit(Effect.gen(function*() {
      const draft = cloneState(yield* Ref.get(state))
      const result = yield* body(memoryTables(draft), draft)
      yield* Ref.set(state, draft)
      return result
    }))

  const markedIn = (current: MemoryState, record: SourceRecord.SourceRecord): boolean =>
    isRevokedIn(current.revocations.get(record.connectionId) ?? new Set(), record)

  const revoke = (connectionId: string, containerId: string) =>
    transact((_, draft) =>
      Effect.sync(() => {
        const markers = draft.revocations.get(connectionId) ?? new Set<string>()
        markers.add(containerId)
        draft.revocations.set(connectionId, markers)
        let purged = 0
        for (const [key, row] of draft.records) {
          const record = row.stored.record
          if (record.connectionId !== connectionId) continue
          if (containerId !== WILDCARD && !SourceRecord.containers(record).includes(containerId)) continue
          draft.records.set(key, { ...row, stored: { ...row.stored, record: purge(record), revoked: true } })
          purged += 1
        }
        return purged
      })
    )

  return SourceStore.of({
    apply: (records) =>
      Effect.flatMap(admitAll(records), (admitted) => transact((tables) => applyAll(tables, admitted))),
    get: (connectionId, externalId) =>
      Effect.map(
        Ref.get(state),
        (current) => Option.fromNullishOr(current.records.get(pair(connectionId, externalId))?.stored)
      ),
    retrieve: (query) =>
      Effect.gen(function*() {
        const limit = yield* checkLimit(query.limit)
        const current = yield* Ref.get(state)
        const needle = query.query === undefined || query.query.length === 0 ? undefined : asciiLower(query.query)
        return Array.from(current.records.values(), (row) => row.stored)
          .filter((stored) =>
            !stored.revoked && !stored.record.deleted && !markedIn(current, stored.record) &&
            covers(query.allowed, stored.record) &&
            (query.kinds === undefined || query.kinds.includes(stored.record.kind)) &&
            (needle === undefined || asciiLower(stored.record.text).includes(needle))
          )
          .map((stored) => stored.record)
          .sort(newestFirst)
          .slice(0, limit)
      }),
    validate: ({ allowed, references }) =>
      Effect.map(Ref.get(state), (current) =>
        references.map((reference) => {
          const stored = current.records.get(pair(reference.connectionId, reference.externalId))?.stored
          const marked = stored !== undefined && markedIn(current, stored.record)
          return { reference, validity: classify(stored, marked, reference, allowed) }
        })),
    revokeConnection: (connectionId) =>
      Effect.flatMap(checkConnectionId(connectionId), () => revoke(connectionId, WILDCARD)),
    revokeContainer: (connectionId, containerId) =>
      Effect.flatMap(
        Effect.andThen(checkConnectionId(connectionId), checkContainerId(containerId)),
        () => revoke(connectionId, containerId)
      ),
    reinstate: (connectionId, containerId) =>
      transact((_, draft) =>
        Effect.sync(() => void draft.revocations.get(connectionId)?.delete(containerId ?? WILDCARD))
      ),
    isRevoked: (connectionId, containerId) =>
      Effect.map(Ref.get(state), (current) => {
        const markers = current.revocations.get(connectionId)
        return markers !== undefined &&
          (markers.has(WILDCARD) || (containerId !== undefined && markers.has(containerId)))
      }),
    cursor: (connectionId, stream) =>
      Effect.map(Ref.get(state), (current) => current.cursors.get(cursorKey(connectionId, stream)) ?? null),
    commit: (page) =>
      Effect.gen(function*() {
        const records = yield* admitPage(page)
        const nowMs = yield* now
        return yield* transact((tables) => commitPage(tables, page, records, nowMs))
      })
  })
})

/**
 * Layer for the in-memory store.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerMemory: Layer.Layer<SourceStore> = Layer.effect(SourceStore, makeMemory)

// ---------------------------------------------------------------------------
// SQL backend.
// ---------------------------------------------------------------------------

interface Row {
  readonly connection_id: string
  readonly external_id: string
  readonly provider: string
  readonly kind: string
  readonly url: string | null
  readonly author_id: string | null
  readonly author_label: string | null
  readonly created_at_ms: number | null
  readonly updated_at_ms: number | null
  readonly version: string | null
  readonly retrieved_at_ms: number
  readonly access_scope: SourceRecord.AccessScope
  readonly access_container_id: string | null
  readonly thread_container_id: string | null
  readonly thread_id: string | null
  readonly parent_id: string | null
  readonly text: string
  readonly deleted: number
  readonly payload_json: string
  readonly revoked: number
  readonly stream: string | null
  readonly swept: number
}

const numberOrNull = (value: unknown): number | null => value === null ? null : Number(value)

const storeError = (operation: string) => (cause: unknown): IntegrationError =>
  isIntegrationError(cause) ? cause : new IntegrationError(
    "delivery-failed",
    `Integration record store ${operation} failed.`,
    { operation },
    { cause }
  )

const fromRow = (row: Row): Effect.Effect<Stored, IntegrationError> =>
  Effect.try({
    try: (): Stored => ({
      record: {
        provider: row.provider,
        connectionId: row.connection_id,
        externalId: row.external_id,
        kind: row.kind,
        url: row.url,
        author: row.author_id === null ? null : { id: row.author_id, label: row.author_label },
        createdAtMs: numberOrNull(row.created_at_ms),
        updatedAtMs: numberOrNull(row.updated_at_ms),
        version: row.version,
        retrievedAtMs: Number(row.retrieved_at_ms),
        access: { scope: row.access_scope, containerId: row.access_container_id },
        thread: { containerId: row.thread_container_id, threadId: row.thread_id, parentId: row.parent_id },
        text: row.text,
        deleted: Number(row.deleted) === 1,
        payload: JSON.parse(row.payload_json)
      },
      revoked: Number(row.revoked) === 1,
      stream: row.stream
    }),
    catch: (cause) =>
      new IntegrationError(
        "decode-failed",
        "A stored source record could not be read back.",
        { connectionId: row.connection_id, externalId: row.external_id },
        { cause }
      )
  })

/**
 * A store over the `smithers_integration_records` table and its companions,
 * sharing the database, and the cursor table, with `CursorStore.makeSql`.
 *
 * Requires `Core.Migrations` to have run. Writes go through the durable
 * writer, so each `apply`, `commit` and revocation is one serialized
 * transaction.
 *
 * @category constructors
 * @since 1.0.0
 */
export const makeSql: Effect.Effect<SourceStore, never, SqlClient.SqlClient | DurableWriter> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const writer = yield* DurableWriter
  const cursors = yield* CursorStore.makeSql

  const transact = <A>(operation: string, body: Effect.Effect<A, IntegrationError>) =>
    writer.write(body).pipe(Effect.mapError(storeError(operation)))

  const failAs = (operation: string) => <A>(effect: Effect.Effect<A, unknown>) =>
    Effect.mapError(effect, storeError(operation))

  const marked = sql.literal(`EXISTS (SELECT 1 FROM smithers_integration_revocations v
    WHERE v.connection_id = r.connection_id
      AND (v.container_id = '*' OR v.container_id = r.access_container_id OR v.container_id = r.thread_container_id))`)

  const tables: Tables = {
    read: (connectionId, externalId) =>
      sql<Row>`SELECT * FROM smithers_integration_records
        WHERE connection_id = ${connectionId} AND external_id = ${externalId}`.pipe(
        failAs("read"),
        Effect.flatMap((rows) => {
          const row = rows[0]
          return row === undefined
            ? Effect.succeed(undefined)
            : Effect.map(fromRow(row), (stored) => ({ stored, swept: Number(row.swept) === 1 }))
        })
      ),
    write: ({ record, revoked }) =>
      sql`INSERT INTO smithers_integration_records (
          connection_id, external_id, provider, kind, url, author_id, author_label, created_at_ms, updated_at_ms,
          version, retrieved_at_ms, access_scope, access_container_id, thread_container_id, thread_id, parent_id,
          text, deleted, payload_json, revoked, swept
        ) VALUES (
          ${record.connectionId}, ${record.externalId}, ${record.provider}, ${record.kind}, ${record.url},
          ${record.author?.id ?? null}, ${record.author?.label ?? null}, ${record.createdAtMs}, ${record.updatedAtMs},
          ${record.version}, ${record.retrievedAtMs}, ${record.access.scope}, ${record.access.containerId},
          ${record.thread.containerId}, ${record.thread.threadId}, ${record.thread.parentId}, ${record.text},
          ${record.deleted ? 1 : 0}, ${JSON.stringify(record.payload)}, ${revoked ? 1 : 0}, 0
        )
        ON CONFLICT (connection_id, external_id) DO UPDATE SET
          provider = excluded.provider, kind = excluded.kind, url = excluded.url, author_id = excluded.author_id,
          author_label = excluded.author_label, created_at_ms = excluded.created_at_ms,
          updated_at_ms = excluded.updated_at_ms, version = excluded.version,
          retrieved_at_ms = excluded.retrieved_at_ms, access_scope = excluded.access_scope,
          access_container_id = excluded.access_container_id, thread_container_id = excluded.thread_container_id,
          thread_id = excluded.thread_id, parent_id = excluded.parent_id, text = excluded.text,
          deleted = excluded.deleted, payload_json = excluded.payload_json, revoked = excluded.revoked,
          swept = 0`.pipe(
        Effect.asVoid,
        failAs("write")
      ),
    mark: (connectionId, externalId, stream, generation) =>
      sql`UPDATE smithers_integration_records SET stream = ${stream}, seen_generation = ${generation}
        WHERE connection_id = ${connectionId} AND external_id = ${externalId}`.pipe(Effect.asVoid, failAs("mark")),
    markers: (connectionId) =>
      sql<{ readonly container_id: string }>`SELECT container_id FROM smithers_integration_revocations
        WHERE connection_id = ${connectionId}`.pipe(
        Effect.map((rows) => new Set(rows.map((row) => row.container_id))),
        failAs("revocation read")
      ),
    stream: (connectionId, stream) =>
      sql<{ readonly generation: number; readonly sweeping: number }>`SELECT generation, sweeping
        FROM smithers_integration_streams WHERE connection_id = ${connectionId} AND stream = ${stream}`.pipe(
        Effect.map((rows) =>
          rows[0] === undefined
            ? { generation: 0, sweeping: false }
            : { generation: Number(rows[0].generation), sweeping: Number(rows[0].sweeping) === 1 }
        ),
        failAs("stream read")
      ),
    setStream: (connectionId, stream, state, nowMs) =>
      sql`INSERT INTO smithers_integration_streams (connection_id, stream, generation, sweeping, updated_at_ms)
        VALUES (${connectionId}, ${stream}, ${state.generation}, ${state.sweeping ? 1 : 0}, ${nowMs})
        ON CONFLICT (connection_id, stream) DO UPDATE SET generation = excluded.generation,
          sweeping = excluded.sweeping, updated_at_ms = excluded.updated_at_ms`.pipe(
        Effect.asVoid,
        failAs("stream write")
      ),
    sweep: (connectionId, stream, generation, nowMs) =>
      sql`UPDATE smithers_integration_records
        SET deleted = 1, url = NULL, author_id = NULL, author_label = NULL, text = '', payload_json = 'null',
          retrieved_at_ms = ${nowMs}, swept = 1
        WHERE connection_id = ${connectionId} AND stream = ${stream} AND deleted = 0
          AND seen_generation < ${generation}`.raw.pipe(Effect.flatMap(affectedRows), failAs("sweep")),
    setCursor: (key, cursor) => cursors.set(key, cursor)
  }

  const revoke = (connectionId: string, containerId: string) =>
    transact(
      "revoke",
      Effect.gen(function*() {
        const nowMs = yield* now
        yield* sql`INSERT INTO smithers_integration_revocations (connection_id, container_id, revoked_at_ms)
          VALUES (${connectionId}, ${containerId}, ${nowMs})
          ON CONFLICT (connection_id, container_id) DO NOTHING`
        const scope = containerId === WILDCARD
          ? sql.literal("1 = 1")
          : sql`(access_container_id = ${containerId} OR thread_container_id = ${containerId})`
        const raw = yield* sql`UPDATE smithers_integration_records
          SET revoked = 1, url = NULL, author_id = NULL, author_label = NULL, text = '', payload_json = 'null'
          WHERE connection_id = ${connectionId} AND ${scope}`.raw
        return yield* affectedRows(raw)
      }).pipe(failAs("revoke"))
    )

  const grantClause = (grant: Grant): Fragment => {
    const connection = sql`r.connection_id = ${grant.connectionId}`
    if (grant.containers.includes(WILDCARD)) return connection
    if (grant.containers.length === 0) return sql.literal("1 = 0")
    return sql.and([
      connection,
      sql.literal("(r.access_container_id IS NOT NULL OR r.thread_container_id IS NOT NULL)"),
      sql`(r.access_container_id IS NULL OR ${sql.in("r.access_container_id", grant.containers)})`,
      sql`(r.thread_container_id IS NULL OR ${sql.in("r.thread_container_id", grant.containers)})`
    ])
  }

  return SourceStore.of({
    apply: (records) => Effect.flatMap(admitAll(records), (admitted) => transact("apply", applyAll(tables, admitted))),
    get: (connectionId, externalId) =>
      Effect.map(tables.read(connectionId, externalId), (current) => Option.fromNullishOr(current?.stored)),
    retrieve: (query) =>
      Effect.gen(function*() {
        const limit = yield* checkLimit(query.limit)
        if (query.allowed.length === 0) return []
        const conditions: Array<Fragment> = [
          sql.or(query.allowed.map(grantClause)),
          sql.literal("r.deleted = 0"),
          sql.literal("r.revoked = 0"),
          sql`NOT ${marked}`
        ]
        if (query.kinds !== undefined) {
          conditions.push(query.kinds.length === 0 ? sql.literal("1 = 0") : sql.in("r.kind", query.kinds))
        }
        if (query.query !== undefined && query.query.length > 0) {
          conditions.push(sql.onDialectOrElse({
            pg: () => sql`strpos(lower(r.text), lower(${query.query})) > 0`,
            orElse: () => sql`instr(lower(r.text), lower(${query.query})) > 0`
          }))
        }
        const rows = yield* sql<Row>`SELECT r.* FROM smithers_integration_records r WHERE ${sql.and(conditions)}
          ORDER BY (COALESCE(r.updated_at_ms, r.created_at_ms) IS NULL),
            COALESCE(r.updated_at_ms, r.created_at_ms) DESC, r.connection_id, r.external_id
          LIMIT ${limit}`.pipe(failAs("retrieve"))
        return yield* Effect.forEach(rows, (row) => Effect.map(fromRow(row), (stored) => stored.record))
      }),
    validate: ({ allowed, references }) =>
      Effect.forEach(
        references,
        (reference) =>
          sql<Row & { readonly marked: number }>`SELECT r.*, ${marked} AS marked FROM smithers_integration_records r
          WHERE r.connection_id = ${reference.connectionId} AND r.external_id = ${reference.externalId}`.pipe(
            failAs("validate"),
            Effect.flatMap((rows) => {
              const row = rows[0]
              if (row === undefined) return Effect.succeed({ reference, validity: "missing" as const })
              return Effect.map(fromRow(row), (stored) => ({
                reference,
                validity: classify(stored, Number(row.marked) === 1, reference, allowed)
              }))
            })
          )
      ),
    revokeConnection: (connectionId) =>
      Effect.flatMap(checkConnectionId(connectionId), () => revoke(connectionId, WILDCARD)),
    revokeContainer: (connectionId, containerId) =>
      Effect.flatMap(
        Effect.andThen(checkConnectionId(connectionId), checkContainerId(containerId)),
        () => revoke(connectionId, containerId)
      ),
    reinstate: (connectionId, containerId) =>
      transact(
        "reinstate",
        sql`DELETE FROM smithers_integration_revocations
          WHERE connection_id = ${connectionId} AND container_id = ${containerId ?? WILDCARD}`.pipe(
          Effect.asVoid,
          failAs("reinstate")
        )
      ),
    isRevoked: (connectionId, containerId) =>
      sql<{ readonly found: number }>`SELECT 1 AS found FROM smithers_integration_revocations
        WHERE connection_id = ${connectionId}
          AND (container_id = '*' OR container_id = ${containerId ?? WILDCARD}) LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        failAs("revocation read")
      ),
    cursor: (connectionId, stream) => cursors.get(cursorKey(connectionId, stream)),
    commit: (page) =>
      Effect.gen(function*() {
        const records = yield* admitPage(page)
        const nowMs = yield* now
        return yield* transact("commit", commitPage(tables, page, records, nowMs))
      })
  })
})

/**
 * Layer for the SQL-backed store.
 *
 * @category layers
 * @since 1.0.0
 */
export const layerSql: Layer.Layer<SourceStore, never, SqlClient.SqlClient | DurableWriter> = Layer.effect(
  SourceStore,
  makeSql
)
