/**
 * Read-only validation of copied cache-age decisions. Producer identities and
 * persisted payloads remain unchanged; ancestry alone is not a reuse proof.
 * @since 1.0.0-rc.0
 */

import { FlowEngine } from "@smthrs/engine"
import type { Journal, JournalEvent } from "@smthrs/journal"
import type { RunStore } from "@smthrs/run-store"
import * as Effect from "effect/Effect"
import { find, prove } from "./CopiedRecord.ts"

/**
 * Paged journal lookup shared with copied-record validation.
 * @category accessors
 * @since 1.0.0-rc.0
 */
export { find } from "./CopiedRecord.ts"

const fieldsEqual = (value: unknown, expected: unknown): boolean => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) return false
  const record = value as Readonly<Record<string, unknown>>
  const keys = Object.keys(expected)
  return Object.keys(record).length === keys.length &&
    keys.every((key) => record[key] === (expected as Readonly<Record<string, unknown>>)[key])
}

/** A copied verdict is usable only through an exact, retained fork prefix.
 * Missing/compacted ancestry and malformed or unrelated history fail closed.
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const copiedVerdict = (options: {
  readonly journal: Journal.Service
  readonly runs: RunStore.Service
  readonly runId: string
  readonly decision: JournalEvent.Input
  readonly conflict: Journal.JournalError
}): Effect.Effect<"admitted" | "expired", Journal.JournalError> =>
  Effect.gen(function*() {
    const { journal, conflict, decision } = options
    const source = (entry: JournalEvent.Entry) =>
      entry.sourceId === decision.sourceId && entry.sourceSeq === decision.sourceSeq
    const entry = yield* find(journal, options.runId, source)
    if (entry === undefined) return yield* Effect.fail(conflict)
    const payload = entry.payload as { readonly verdict?: unknown } | null
    const verdict = payload?.verdict
    if (verdict !== "admitted" && verdict !== "expired") return yield* Effect.fail(conflict)
    const expected = { ...decision.payload as Readonly<Record<string, unknown>>, verdict }
    if (entry.eventType !== decision.eventType || !fieldsEqual(entry.payload, expected)) {
      return yield* Effect.fail(conflict)
    }
    const original = yield* prove({ ...options, entry, same: fieldsEqual })
    return fieldsEqual(original.record.meta, { lineageId: FlowEngine.Lineage.root(original.ancestor) })
      ? verdict
      : yield* Effect.fail(conflict)
  })
