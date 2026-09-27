/**
 * Note, status, and supersession operations of the SQL memory store.
 *
 * @since 0.1.0
 */

import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import type { DatabaseService } from "../Database.ts"
import type { MemoryError } from "../MemoryError.ts"
import type { ListNotesInput, Note, Service, StatusFilter } from "../MemoryStore.ts"
import type * as Namespace from "../Namespace.ts"
import { canonicalJson, compareText } from "./Canonical.ts"
import * as Fts from "./Fts.ts"
import { resolveNamespace } from "./ResolveNamespace.ts"
import {
  changed,
  collectUntil,
  decodeJson,
  decodeNote,
  encodeJson,
  error,
  type Fragment,
  MIN_NOTE_PAGE_SIZE,
  NOTE_PAGE_SIZE,
  type NoteRow,
  storeError,
  tagMatcher,
  validateLimit,
  validateNonEmpty,
  validateTags
} from "./Store.ts"

const NOTE_COLUMNS = "namespace_kind, namespace_id, id, text, tags_json, provenance_json, status, created_at_ms"

type ReadNotes = (
  input: ListNotesInput & { readonly ids?: ReadonlyArray<string> | undefined },
  recentFirst?: boolean
) => Effect.Effect<ReadonlyArray<Note>, MemoryError>

/**
 * Builds the note operations, plus the filtered reader search pages through.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (database: DatabaseService): {
  readonly readNotes: ReadNotes
  readonly service: Pick<Service, "putNote" | "getNote" | "setNoteStatus" | "supersede" | "listNotes">
} => {
  const { sql } = database
  const columns = sql.literal(NOTE_COLUMNS)

  // Status and supersession are answered in SQL, which is what makes `limit`
  // mean "at most N rows that pass every filter". A `LIMIT` applied before
  // the filters silently under-fills: `listNotes({status:"accepted",limit:1})`
  // over a namespace whose oldest note is `pending` used to return nothing.
  // An absent status filter selects `accepted`; `"any"` selects everything;
  // an array selects its members, and an empty array selects nothing.
  const statusCondition = (filter: StatusFilter | undefined): Fragment | undefined => {
    const selected = filter ?? "accepted"
    if (selected === "any") return undefined
    if (!Array.isArray(selected)) return sql`notes.status = ${selected}`
    return selected.length === 0 ? sql.literal("1 = 0") : sql.in("notes.status", selected)
  }

  const notSupersededCondition = sql.literal(`NOT EXISTS (
    SELECT 1 FROM memory_note_supersedes edges
    JOIN memory_notes superseder ON superseder.id = edges.superseder_id
    WHERE edges.target_id = notes.id AND superseder.status = 'accepted')`)

  const readNotes: ReadNotes = (input, recentFirst = false) =>
    Effect.gen(function*() {
      const { namespace } = yield* resolveNamespace(input.namespace)
      const limit = yield* validateLimit(input.limit, "listNotes")
      if (limit === 0) return []
      const order = sql.literal(recentFirst ? "created_at_ms DESC, id" : "created_at_ms, id")
      const conditions: Array<Fragment> = [
        sql`notes.namespace_kind = ${namespace.kind}`,
        sql`notes.namespace_id = ${namespace.id}`
      ]
      if (input.prefix !== undefined) {
        conditions.push(sql`substr(notes.id, 1, length(${input.prefix})) = ${input.prefix}`)
      }
      if (input.ids !== undefined) {
        conditions.push(input.ids.length === 0 ? sql.literal("1 = 0") : sql.in("notes.id", input.ids))
      }
      const status = statusCondition(input.status)
      if (status !== undefined) conditions.push(status)
      if (input.includeSuperseded !== true) conditions.push(notSupersededCondition)
      const page = (rowLimit: number | undefined, after?: Note) => {
        const continuation = after === undefined ? [] : [
          recentFirst
            ? sql`(notes.created_at_ms < ${after.createdAtMs}
              OR (notes.created_at_ms = ${after.createdAtMs} AND notes.id > ${after.id}))`
            : sql`(notes.created_at_ms, notes.id) > (${after.createdAtMs}, ${after.id})`
        ]
        const where = sql.and([...conditions, ...continuation])
        return (rowLimit === undefined
          ? sql<NoteRow>`SELECT ${columns} FROM memory_notes notes WHERE ${where} ORDER BY ${order}`
          : sql<NoteRow>`SELECT ${columns} FROM memory_notes notes WHERE ${where} ORDER BY ${order} LIMIT ${rowLimit}`)
          .pipe(
            Effect.mapError(storeError("could not list memory notes")),
            Effect.flatMap((rows) => Effect.forEach(rows, decodeNote))
          )
      }

      // Tags stay in JS so Namespace.matches owns all five match modes.
      const tagFiltered = input.tagGroups !== undefined
      const matchesTags = tagMatcher(input)
      const keep = (notes: ReadonlyArray<Note>) => notes.filter((note) => matchesTags(note.tags))
      if (limit === undefined || !tagFiltered) {
        const notes = yield* page(limit)
        return tagFiltered ? keep(notes) : notes
      }
      const pageSize = Math.min(NOTE_PAGE_SIZE, Math.max(limit, MIN_NOTE_PAGE_SIZE))
      return yield* collectUntil(limit, pageSize, page, (notes) => Effect.succeed(keep(notes)))
    })

  const putNote: Service["putNote"] = (input) =>
    Effect.gen(function*() {
      const { namespace } = yield* resolveNamespace(input.namespace)
      yield* validateNonEmpty(input.id, "note id", ["id"])
      const status = input.status ?? "accepted"
      const tags = yield* validateTags(input.tags)
      const tagsJson = canonicalJson(tags)
      const encodedProvenance = yield* encodeJson(input.provenance, "note provenance", ["provenance"])
      const provenanceJson = canonicalJson(yield* decodeJson(encodedProvenance, "note provenance"))
      const supersedes = Array.from(new Set(input.supersedes ?? [])).sort(compareText)
      if (supersedes.includes(input.id)) {
        return yield* Effect.fail(error("supersede_conflict", "a note cannot supersede itself"))
      }
      const now = yield* Clock.currentTimeMillis
      const row = yield* database.write(
        Effect.gen(function*() {
          const inserted = yield* sql`INSERT INTO memory_notes (${columns}) VALUES (
            ${namespace.kind}, ${namespace.id}, ${input.id}, ${input.text}, ${tagsJson},
            ${provenanceJson}, ${status}, ${now}
            ) ON CONFLICT (id) DO NOTHING`.raw
          const created = changed(inserted) > 0
          const persisted = yield* sql<NoteRow>`SELECT ${columns}
            FROM memory_notes WHERE id = ${input.id} LIMIT 1`
          if (persisted.length === 0) {
            return yield* Effect.fail(error("store", "inserted note could not be read back"))
          }
          const existing = persisted[0]!
          if (!created) {
            const existingProvenance = canonicalJson(
              yield* decodeJson(existing.provenance_json, "note provenance")
            )
            if (
              existing.namespace_kind !== namespace.kind || existing.namespace_id !== namespace.id ||
              existing.text !== input.text || existing.tags_json !== tagsJson ||
              existingProvenance !== provenanceJson
            ) {
              return yield* Effect.fail(
                error("supersede_conflict", `note id "${input.id}" already exists with different creation data`)
              )
            }
            const persistedEdges = yield* sql<{ readonly target_id: string }>`SELECT target_id
              FROM memory_note_supersedes
              WHERE superseder_id = ${input.id}
              ORDER BY target_id`
            const targets = persistedEdges.map((edge) => edge.target_id).sort(compareText)
            if (
              targets.length !== supersedes.length ||
              targets.some((target, index) => target !== supersedes[index])
            ) {
              return yield* Effect.fail(
                error("supersede_conflict", `note id "${input.id}" already exists with different supersession data`)
              )
            }
          } else {
            for (const targetId of supersedes) {
              const target = yield* sql<{ readonly id: string }>`
                SELECT id FROM memory_notes
                WHERE id = ${targetId}
                  AND namespace_kind = ${namespace.kind}
                  AND namespace_id = ${namespace.id}
                LIMIT 1
              `
              if (target.length === 0) {
                return yield* Effect.fail(
                  error("supersede_conflict", `superseded note "${targetId}" does not exist`)
                )
              }
              yield* sql`INSERT INTO memory_note_supersedes (superseder_id, target_id, created_at_ms)
                VALUES (${input.id}, ${targetId}, ${now})
                ON CONFLICT (superseder_id, target_id) DO NOTHING`
            }
            yield* Fts.replaceFtsRecord(database, namespace.kind, {
              recordId: input.id,
              recordKind: "note",
              namespaceId: namespace.id,
              key: input.id,
              text: input.text
            })
          }
          return existing
        })
      ).pipe(Effect.mapError(storeError("could not insert memory note")))
      return yield* decodeNote(row)
    })

  const getNote: Service["getNote"] = (input) =>
    Effect.gen(function*() {
      yield* validateNonEmpty(input.id, "note id", ["id"])
      const rows = yield* sql<NoteRow>`SELECT ${columns}
        FROM memory_notes WHERE id = ${input.id} LIMIT 1`.pipe(
        Effect.mapError(storeError("could not read memory note"))
      )
      return rows[0] === undefined ? undefined : yield* decodeNote(rows[0])
    })

  const setNoteStatus: Service["setNoteStatus"] = (input) =>
    Effect.gen(function*() {
      yield* validateNonEmpty(input.id, "note id", ["id"])
      const result = yield* database.write(
        sql`UPDATE memory_notes SET status = ${input.status} WHERE id = ${input.id}`.raw
      ).pipe(Effect.mapError(storeError("could not update memory note status")))
      if (changed(result) === 0) {
        return yield* Effect.fail(error("not_found", `memory note "${input.id}" was not found`))
      }
    })

  const supersede: Service["supersede"] = (input) =>
    Effect.gen(function*() {
      yield* validateNonEmpty(input.supersederId, "supersederId", ["supersederId"])
      yield* validateNonEmpty(input.targetId, "targetId", ["targetId"])
      if (input.supersederId === input.targetId) {
        return yield* Effect.fail(error("supersede_conflict", "a note cannot supersede itself"))
      }
      const now = yield* Clock.currentTimeMillis
      yield* database.write(
        Effect.gen(function*() {
          const rows = yield* sql<{
            readonly id: string
            readonly namespace_kind: Namespace.Kind
            readonly namespace_id: string
          }>`SELECT id, namespace_kind, namespace_id FROM memory_notes
            WHERE id = ${input.supersederId} OR id = ${input.targetId}`
          const found = new Set(rows.map((row) => row.id))
          if (!found.has(input.supersederId) || !found.has(input.targetId)) {
            return yield* Effect.fail(
              error("supersede_conflict", "both superseder and target notes must exist")
            )
          }
          const superseder = rows.find((row) => row.id === input.supersederId)!
          const target = rows.find((row) => row.id === input.targetId)!
          if (
            superseder.namespace_kind !== target.namespace_kind ||
            superseder.namespace_id !== target.namespace_id
          ) {
            return yield* Effect.fail(error("supersede_conflict", "superseder and target must share a namespace"))
          }
          yield* sql`INSERT INTO memory_note_supersedes (superseder_id, target_id, created_at_ms)
            VALUES (${input.supersederId}, ${input.targetId}, ${now})
            ON CONFLICT (superseder_id, target_id) DO NOTHING`
        })
      ).pipe(Effect.mapError(storeError("could not write memory supersession edge")))
    })

  return {
    readNotes,
    service: { putNote, getNote, setNoteStatus, supersede, listNotes: (input) => readNotes(input) }
  }
}
