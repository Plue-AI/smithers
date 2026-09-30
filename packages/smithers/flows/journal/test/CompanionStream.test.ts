/**
 * Companion stream ids: a store's facts about a run live on a journal stream
 * beside the run's own, named by the SHA-256 of the run id.
 */
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import * as JournalEvent from "../src/JournalEvent.ts"

describe("companion stream ids", () => {
  it("keeps companion ids distinct per run and per stream, within the identifier bound", () => {
    const long = "r".repeat(1024)
    const ids = [
      JournalEvent.companionRunId("run-store", "a"),
      JournalEvent.companionRunId("run-store", "b"),
      JournalEvent.companionRunId("other", "a"),
      JournalEvent.companionRunId("run-store", long)
    ]
    expect(new Set(ids).size).toBe(4)
    for (const id of ids) {
      expect(JournalEvent.isCompanionRunId(id)).toBe(true)
      expect(id.length).toBeLessThanOrEqual(JournalEvent.maxIdentifierLength)
    }
    expect(ids[0]).toBe(JournalEvent.companionRunId("run-store", "a"))
    expect(JournalEvent.isCompanionRunId("run-x")).toBe(false)
  })

  it.effect("derives the id from the SHA-256 of the run id's UTF-8 bytes", () =>
    Effect.gen(function*() {
      for (
        const runId of [
          "a",
          "",
          "run-\u00e9-\u{1f600}",
          "x".repeat(55),
          "x".repeat(56),
          "x".repeat(64),
          "y".repeat(1000)
        ]
      ) {
        const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(runId)))
        const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
        expect(JournalEvent.companionRunId("run-store", runId)).toBe(`flows.companion/run-store/${hex}`)
      }
    }))
})
