/**
 * Incremental evidence for the no-TTL cache guard.
 * @since 1.0.0-rc.0
 */

import { Journal, JournalEvent } from "@smthrs/journal"
import * as Effect from "effect/Effect"
import * as Semaphore from "effect/Semaphore"

/**
 * Per-executor index of TTL markers in an append-only journal generation.
 * Refresh before answering, retaining the first record for either its producer
 * key or payload key so malformed and copied verdicts still refuse removal.
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = (runId: string) => {
  const gate = Semaphore.makeUnsafe(1)
  const id = JournalEvent.RunId.make(runId)
  let source: Journal.Service | undefined
  let generation: number | undefined
  let after: JournalEvent.Seq | undefined
  const verdicts = new Map<string, JournalEvent.Entry>()
  return (
    journal: Journal.Service,
    keyDigest: string
  ): Effect.Effect<JournalEvent.Entry | undefined, Journal.JournalError> =>
    Semaphore.withPermit(gate)(Effect.gen(function*() {
      const currentGeneration = journal.generation === undefined ? 0 : (yield* journal.generation(id)).generation
      if (source !== journal || generation !== currentGeneration) {
        source = journal
        generation = currentGeneration
        after = undefined
        verdicts.clear()
      }
      while (true) {
        const page = yield* journal.entries({ runId: id, limit: 128, ...after === undefined ? {} : { after } })
        const next = page.entries.at(-1)?.seq
        if (
          (page.hasMore && next === undefined) ||
          (next !== undefined && after !== undefined && next <= after)
        ) {
          return yield* Effect.fail(
            new Journal.JournalError({ code: "read_failed", message: "cache history cursor did not advance" })
          )
        }
        for (const entry of page.entries) {
          const producerKey = /^cache:([^:]+):ttl:/.exec(entry.sourceId)?.[1]
          const payload = entry.payload as { action?: unknown; keyDigest?: unknown } | null
          if (producerKey !== undefined && !verdicts.has(producerKey)) verdicts.set(producerKey, entry)
          if (payload?.action === "ttl" && typeof payload.keyDigest === "string" && !verdicts.has(payload.keyDigest)) {
            verdicts.set(payload.keyDigest, entry)
          }
        }
        // Publish each fully processed page, including the final one. A read
        // failure or interruption retries only the unvalidated suffix.
        after = next ?? after
        if (!page.hasMore) return verdicts.get(keyDigest)
      }
    }))
}
