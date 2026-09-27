import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { layerMemory, SourceStore } from "../src/core/SourceStore.ts"
import * as Records from "../src/gmail/Records.ts"
import { runWith, sqlLayer } from "./SourceStoreFixtures.ts"

const context = { connectionId: "mail", container: "mail:INBOX", retrievedAtMs: 5_000 }
const grants = [{ connectionId: "mail", containers: ["*"] }]
const message = (historyId: string) => ({
  id: "m1",
  threadId: "t1",
  historyId,
  internalDate: "1000",
  labelIds: ["INBOX"],
  snippet: "private body",
  payload: { headers: [{ name: "Subject", value: "secret" }] }
})

const lifecycle = (name: string, layer: Layer.Layer<SourceStore>) =>
  it(`${name}: a newer deletion hides the message and a later restore brings it back (#2175)`, () =>
    runWith(layer)(Effect.gen(function*() {
      const store = yield* SourceStore
      const readable = () => store.retrieve({ allowed: grants, query: "private", limit: 10 })
      yield* store.apply([Records.fromMessage(message("10"), context)])
      expect(yield* readable()).toHaveLength(1)

      // Deleted outright: history names the message only.
      const hard = yield* store.apply([Records.tombstone({ id: "m1", threadId: "t1" }, "11", context)])
      expect(hard.tombstoned).toBe(1)
      expect(yield* readable()).toHaveLength(0)

      // Restored, then trashed with the message in hand.
      yield* store.apply([Records.fromMessage(message("12"), context)])
      expect(yield* readable()).toHaveLength(1)
      yield* store.apply([Records.tombstone(message("13"), "13", context)])
      expect(yield* readable()).toHaveLength(0)

      // A stale copy of the live message does not resurrect it.
      yield* store.apply([Records.fromMessage(message("12"), context)])
      expect(yield* readable()).toHaveLength(0)
    })))

describe("Gmail record ordering", () => {
  lifecycle("memory", layerMemory)
  lifecycle("sql", sqlLayer)
})
