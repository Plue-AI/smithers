/**
 * Authoritative SQL memory contract store.
 *
 * @see https://memory.smithers.sh/reference/api/
 *
 * @since 0.1.0
 */

import { DurableWriter } from "@smthrs/database/DurableWriter"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { DatabaseService } from "./Database.ts"
import * as Facts from "./internal/Facts.ts"
import { instrument } from "./internal/Instrument.ts"
import * as Notes from "./internal/Notes.ts"
import * as Search from "./internal/Search.ts"
import { error, storeError } from "./internal/Store.ts"
import * as Threads from "./internal/Threads.ts"
import type { MemoryError } from "./MemoryError.ts"
import * as Migrations from "./Migrations.ts"
import type * as Namespace from "./Namespace.ts"

/**
 * Explicit run coordinates attached to a memory write.
 *
 * @category models
 * @since 0.1.0
 */
export interface Provenance {
  readonly runId?: string | null | undefined
  readonly nodeId?: string | null | undefined
  readonly iteration?: number | null | undefined
}

/**
 * A current fact row.
 *
 * @category models
 * @since 0.1.0
 */
export interface Fact {
  readonly namespace: Namespace.Namespace
  readonly key: string
  readonly value: unknown
  readonly tags?: Namespace.Tags | undefined
  readonly ttlMs?: number | undefined
  readonly provenance: Provenance
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

/**
 * Input for a last-write-wins fact update.
 *
 * @category models
 * @since 0.1.0
 */
export interface PutFactInput {
  readonly namespace: NamespaceInput
  readonly key: string
  /**
   * Value stored through a `JSON.stringify` round trip.
   *
   * `NaN` and `Infinity` become `null`; `undefined`, function, and symbol
   * members are dropped; and sparse array slots become `null`. A later
   * `getFact` can therefore return a value that differs from the input.
   *
   * @category models
   * @since 0.1.0
   */
  readonly value: unknown
  /** Validated first-class fact tags. */
  readonly tags?: Namespace.Tags | undefined
  readonly ttlMs?: number | undefined
  readonly provenance: Provenance
}

/**
 * Input for an exact fact read.
 *
 * @category models
 * @since 0.1.0
 */
export interface GetFactInput {
  readonly namespace: NamespaceInput
  readonly key: string
}

/**
 * Input for an ordered namespace fact listing.
 *
 * @category models
 * @since 0.1.0
 */
export interface ListFactsInput {
  readonly namespace: NamespaceInput
  readonly prefix?: string | undefined
  readonly limit?: number | undefined
}

/**
 * A durable history thread.
 *
 * @category models
 * @since 0.1.0
 */
export interface Thread {
  readonly id: string
  readonly namespace: Namespace.Namespace
  readonly title?: string | undefined
  readonly metadata?: unknown
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

/**
 * Input for durable thread creation.
 *
 * @category models
 * @since 0.1.0
 */
export interface CreateThreadInput {
  readonly id?: string | undefined
  readonly namespace: NamespaceInput
  readonly title?: string | undefined
  readonly metadata?: unknown
}

/**
 * Input for listing durable threads.
 *
 * @category models
 * @since 0.1.0
 */
export interface ListThreadsInput {
  readonly namespace?: NamespaceInput | undefined
}

/**
 * Input for an exact durable thread read.
 *
 * @category models
 * @since 0.1.0
 */
export interface GetThreadInput {
  readonly threadId: string
}

/**
 * Input for deleting one durable thread.
 *
 * @category models
 * @since 0.1.0
 */
export interface DeleteThreadInput {
  readonly threadId: string
}

/**
 * An ordered history message.
 *
 * @category models
 * @since 0.1.0
 */
export interface Message {
  readonly threadId: string
  readonly id: string
  readonly role: string
  readonly text: string
  readonly at: number
}

/**
 * Input for an idempotent history append.
 *
 * A message id is unique within its thread.
 *
 * @category models
 * @since 0.1.0
 */
export type AppendMessageInput = Message

/**
 * Input for an ordered thread read.
 *
 * @category models
 * @since 0.1.0
 */
export interface ListMessagesInput {
  readonly threadId: string
  readonly limit?: number | undefined
  readonly cursor?: MessageCursor | undefined
}

/**
 * One thread's message count and text-size bounds, answered in SQL.
 *
 * `codePoints` is SQLite's character count and `bytes` the stored encoding's
 * byte count. A thread's total JavaScript string length lies between them,
 * and equals both when they agree.
 *
 * @category models
 * @since 0.1.0
 */
export interface MessageStats {
  readonly messages: number
  readonly codePoints: number
  readonly bytes: number
}

/**
 * Stable exclusive cursor for ordered message pagination.
 *
 * @category models
 * @since 0.1.0
 */
export interface MessageCursor {
  readonly at: number
  readonly id: string
}

/**
 * Input for an exact note read.
 *
 * @category models
 * @since 0.1.0
 */
export interface GetNoteInput {
  readonly id: string
}

/**
 * The only mutable state on an append-only note.
 *
 * @category schemas
 * @since 0.1.0
 */
export const NoteStatus = Schema.Literals(["pending", "accepted", "rejected"])

/**
 * The only mutable state on an append-only note.
 *
 * @category models
 * @since 0.1.0
 */
export type NoteStatus = typeof NoteStatus.Type

/**
 * An append-only knowledge note.
 *
 * @category models
 * @since 0.1.0
 */
export interface Note {
  readonly namespace: Namespace.Namespace
  readonly id: string
  readonly text: string
  readonly tags: Namespace.Tags
  readonly provenance: Provenance
  readonly status: NoteStatus
  readonly createdAtMs: number
}

/**
 * Input for an append-only note insert.
 *
 * `supersedes`, when present, is persisted in the same write transaction as
 * the new note.
 *
 * @category models
 * @since 0.1.0
 */
export interface PutNoteInput {
  readonly namespace: NamespaceInput
  readonly id: string
  readonly text: string
  readonly tags: Namespace.Tags
  readonly provenance: Provenance
  readonly status?: NoteStatus | undefined
  readonly supersedes?: ReadonlyArray<string> | undefined
}

/**
 * Input for the note status gate.
 *
 * @category models
 * @since 0.1.0
 */
export interface SetNoteStatusInput {
  readonly id: string
  readonly status: NoteStatus
}

/**
 * Input for a supersession edge.
 *
 * @category models
 * @since 0.1.0
 */
export interface SupersedeInput {
  readonly supersederId: string
  readonly targetId: string
}

/**
 * A structured namespace or recall bank name.
 *
 * Explicit `flow-`, `agent-`, `user-`, and `global-` bank prefixes retain
 * their lifetime. Unprefixed banks are flow-local.
 *
 * @category models
 * @since 0.1.0
 */
export type NamespaceInput = Namespace.Namespace | string

/**
 * Status selector accepted by note and search reads.
 *
 * @category models
 * @since 0.1.0
 */
export type StatusFilter = NoteStatus | "any" | ReadonlyArray<NoteStatus>

/**
 * Input for authoritative note reads.
 *
 * @category models
 * @since 0.1.0
 */
export interface ListNotesInput {
  readonly namespace: NamespaceInput
  readonly prefix?: string | undefined
  /**
   * At most this many rows that pass EVERY filter on this input, not a bound on
   * the rows the query examines. An absent limit reads the whole namespace.
   */
  readonly limit?: number | undefined
  readonly tagGroups?: ReadonlyArray<Namespace.TagGroup> | undefined
  readonly status?: StatusFilter | undefined
  readonly includeSuperseded?: boolean | undefined
}

/**
 * A normalized authoritative row consumed by recall bindings.
 *
 * @category models
 * @since 0.1.0
 */
export interface SearchRow {
  readonly id: string
  readonly kind: "fact" | "note"
  readonly bank: string
  readonly namespace: Namespace.Namespace
  readonly key: string
  readonly text: string
  readonly tags: ReadonlyArray<string>
  readonly updatedAtMs: number
  readonly status?: NoteStatus | undefined
}

/**
 * Input for raw authoritative recall rows.
 *
 * @category models
 * @since 0.1.0
 */
export interface SearchRowsInput extends ListNotesInput {
  /** Exact projection identities to resolve, at most 64 per authoritative read. */
  readonly records?: ReadonlyArray<{ readonly kind: "fact" | "note"; readonly id: string }> | undefined
  /**
   * At most this many merged fact and note rows that pass EVERY filter on this
   * input. Both sides are read newest-first and bounded independently, so the
   * merge is the true newest `limit` rows, never a sample of a wider window.
   */
  readonly limit?: number | undefined
}

/**
 * Input for lazy FTS5 enablement.
 *
 * @category models
 * @since 0.1.0
 */
export type EnableFtsInput = Namespace.Kind

/**
 * Input for direct FTS5 recall.
 *
 * @category models
 * @since 0.1.0
 */
export interface SearchFtsInput extends SearchRowsInput {
  readonly query: string
}

/**
 * An authoritative FTS result with raw SQLite BM25 rank.
 *
 * @category models
 * @since 0.1.0
 */
export interface FtsRow extends SearchRow {
  readonly rank: number
  readonly score: number
}

/**
 * Atomic history compaction input used by Maintenance.
 *
 * @category models
 * @since 0.1.0
 */
export interface CompactMessagesInput {
  readonly threadId: string
  readonly summary: Message
  /** Full rows supplied to the summarizer, checked again inside the write transaction. */
  readonly sourceMessages: ReadonlyArray<Message>
}

/**
 * Authoritative memory and maintenance operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly putFact: (input: PutFactInput) => Effect.Effect<void, MemoryError>
  readonly getFact: (input: GetFactInput) => Effect.Effect<Fact | undefined, MemoryError>
  readonly deleteFact: (input: GetFactInput) => Effect.Effect<boolean, MemoryError>
  readonly listFacts: (input: ListFactsInput) => Effect.Effect<ReadonlyArray<Fact>, MemoryError>
  readonly listAllFacts: Effect.Effect<ReadonlyArray<Fact>, MemoryError>
  readonly createThread: (input: CreateThreadInput) => Effect.Effect<Thread, MemoryError>
  readonly getThread: (input: GetThreadInput) => Effect.Effect<Thread | undefined, MemoryError>
  readonly listThreads: (input?: ListThreadsInput | undefined) => Effect.Effect<ReadonlyArray<Thread>, MemoryError>
  readonly deleteThread: (input: DeleteThreadInput) => Effect.Effect<boolean, MemoryError>
  readonly appendMessage: (input: AppendMessageInput) => Effect.Effect<void, MemoryError>
  readonly listMessages: (input: ListMessagesInput) => Effect.Effect<ReadonlyArray<Message>, MemoryError>
  readonly countMessages: (input: ListMessagesInput) => Effect.Effect<number, MemoryError>
  readonly messageStats: (input: { readonly threadId: string }) => Effect.Effect<MessageStats, MemoryError>
  readonly putNote: (input: PutNoteInput) => Effect.Effect<Note, MemoryError>
  readonly getNote: (input: GetNoteInput) => Effect.Effect<Note | undefined, MemoryError>
  readonly setNoteStatus: (input: SetNoteStatusInput) => Effect.Effect<void, MemoryError>
  readonly supersede: (input: SupersedeInput) => Effect.Effect<void, MemoryError>
  readonly listNotes: (input: ListNotesInput) => Effect.Effect<ReadonlyArray<Note>, MemoryError>
  readonly enableFts: (kind: EnableFtsInput) => Effect.Effect<void, MemoryError>
  readonly searchFts: (input: SearchFtsInput) => Effect.Effect<ReadonlyArray<FtsRow>, MemoryError>
  readonly searchRows: (input: SearchRowsInput) => Effect.Effect<ReadonlyArray<SearchRow>, MemoryError>
  readonly deleteExpiredFacts: Effect.Effect<number, MemoryError>
  readonly listThreadIds: Effect.Effect<ReadonlyArray<string>, MemoryError>
  readonly deleteMessages: (
    input: { readonly threadId: string; readonly ids: ReadonlyArray<string> }
  ) => Effect.Effect<number, MemoryError>
  readonly compactMessages: (input: CompactMessagesInput) => Effect.Effect<number, MemoryError>
}

/**
 * Context service for durable cross-run memory.
 *
 * @category services
 * @since 0.1.0
 */
export class MemoryStore extends Context.Service<MemoryStore, Service>()("flows/memory/MemoryStore") {}

/**
 * Builds the SQL-backed memory service and applies idempotent migrations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Service, MemoryError, Crypto.Crypto | DurableWriter | SqlClient.SqlClient> = Effect
  .gen(function*() {
    const sql = yield* Effect.service(SqlClient.SqlClient)
    const writer = yield* DurableWriter
    const crypto = yield* Crypto.Crypto
    const database: DatabaseService = { sql, write: writer.write }
    yield* Migrations.run.pipe(Effect.mapError(storeError("memory migration failed")))
    const facts = Facts.make(database)
    const notes = Notes.make(database)
    return MemoryStore.of(instrument({
      ...facts.service,
      ...Threads.make(database, crypto),
      ...notes.service,
      ...Search.make(database, { readFacts: facts.readFacts, readNotes: notes.readNotes })
    }))
  })

/**
 * Constructs an unavailable store stub, optionally overriding operations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service => {
  const unavailable = (method: string): Effect.Effect<never, MemoryError> =>
    Effect.fail(error("store", `${method} is unavailable`))
  return MemoryStore.of({
    putFact: () => unavailable("putFact"),
    getFact: () => unavailable("getFact"),
    deleteFact: () => unavailable("deleteFact"),
    listFacts: () => unavailable("listFacts"),
    listAllFacts: unavailable("listAllFacts"),
    createThread: () => unavailable("createThread"),
    getThread: () => unavailable("getThread"),
    listThreads: () => unavailable("listThreads"),
    deleteThread: () => unavailable("deleteThread"),
    appendMessage: () => unavailable("appendMessage"),
    listMessages: () => unavailable("listMessages"),
    countMessages: () => unavailable("countMessages"),
    messageStats: () => unavailable("messageStats"),
    putNote: () => unavailable("putNote"),
    getNote: () => unavailable("getNote"),
    setNoteStatus: () => unavailable("setNoteStatus"),
    supersede: () => unavailable("supersede"),
    listNotes: () => unavailable("listNotes"),
    enableFts: () => unavailable("enableFts"),
    searchFts: () => unavailable("searchFts"),
    searchRows: () => unavailable("searchRows"),
    deleteExpiredFacts: unavailable("deleteExpiredFacts"),
    listThreadIds: unavailable("listThreadIds"),
    deleteMessages: () => unavailable("deleteMessages"),
    compactMessages: () => unavailable("compactMessages"),
    ...overrides
  })
}

/**
 * Provides an unavailable memory store.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<MemoryStore> =>
  Layer.succeed(MemoryStore)(makeNoop(overrides))

/**
 * Provides the authoritative SQL memory store over the SQL client and the
 * durable writer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<MemoryStore, MemoryError, Crypto.Crypto | DurableWriter | SqlClient.SqlClient> = Layer
  .effect(
    MemoryStore
  )(make)
