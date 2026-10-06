import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as MemoryStore from "../src/MemoryStore.ts"
import { namespace, run } from "./fixtures/MemoryStoreHarness.ts"

describe("learning note lifecycle through the public SQL store", () => {
  it("timestamps dismissal once and retains immutable creation data across reopening", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const original = yield* store.putNote({
        namespace,
        id: "check:lint@review",
        text: "Run lint before review",
        tags: [],
        provenance: { runId: "learning-7" },
        status: "pending"
      })
      yield* TestClock.adjust(1000)
      yield* store.setNoteStatus({ id: original.id, status: "rejected" })
      const dismissed = yield* store.getNote({ id: original.id })
      yield* TestClock.adjust(1000)
      yield* store.setNoteStatus({ id: original.id, status: "rejected" })
      const replay = yield* store.getNote({ id: original.id })
      yield* store.setNoteStatus({ id: original.id, status: "pending" })
      const reopened = yield* store.getNote({ id: original.id })
      return { original, dismissed, replay, reopened }
    }))
    expect(result.dismissed).toEqual({ ...result.original, status: "rejected", statusAtMs: 1000 })
    expect(result.replay).toEqual(result.dismissed)
    expect(result.reopened).toEqual({ ...result.original, statusAtMs: 2000 })
  })

  it("binds acceptance to one TODO and refuses a different TODO or later dismissal", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      yield* store.putNote({
        namespace,
        id: "proposal",
        text: "Keep receipts",
        tags: [],
        provenance: {},
        status: "pending"
      })
      yield* TestClock.adjust(42)
      yield* store.setNoteStatus({ id: "proposal", status: "accepted", acceptedTodo: "T14" })
      const accepted = yield* store.getNote({ id: "proposal" })
      yield* TestClock.adjust(1000)
      yield* store.setNoteStatus({ id: "proposal", status: "accepted", acceptedTodo: "T14" })
      const different = yield* Effect.flip(
        store.setNoteStatus({ id: "proposal", status: "accepted", acceptedTodo: "T15" })
      )
      const dismiss = yield* Effect.flip(store.setNoteStatus({ id: "proposal", status: "rejected" }))
      const replay = yield* store.getNote({ id: "proposal" })
      return { accepted, different, dismiss, replay }
    }))
    expect(result.accepted).toMatchObject({ status: "accepted", acceptedTodo: "T14", statusAtMs: 42 })
    expect(result.replay).toEqual(result.accepted)
    expect(result.different.code).toBe("idempotency_conflict")
    expect(result.dismiss.code).toBe("idempotency_conflict")
  })

  it("rejects malformed lifecycle writes without changing the note", async () => {
    const result = await run(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      const original = yield* store.putNote({
        namespace,
        id: "proposal",
        text: "Keep receipts",
        tags: [],
        provenance: {},
        status: "pending"
      })
      const failures = []
      for (
        const input of [
          { id: "proposal", status: "rejected" as const, acceptedTodo: "T14" },
          { id: "proposal", status: "accepted" as const, acceptedTodo: "" },
          { id: "missing", status: "accepted" as const }
        ]
      ) failures.push(yield* Effect.flip(store.setNoteStatus(input)))
      return { original, failures, after: yield* store.getNote({ id: original.id }) }
    }))
    expect(result.failures.map((row) => row.code)).toEqual(["invalid_argument", "invalid_argument", "not_found"])
    expect(result.after).toEqual(result.original)
  })
})
