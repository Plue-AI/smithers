import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { type Ownership, RunStore } from "@smthrs/run-store"
import { Effect, Layer } from "effect"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const owner: Ownership.OwnerId = { hostId: "journal", pid: 1, nonce: "owner" }

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "snapshot" as never, changeId: "snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

describe("engine-store journal integration", () => {
  it.effect("records stable attempt and cache provenance events in the open journal envelope", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        yield* runs.create("journal-run", "{}")
        const pending = yield* runs.get("journal-run")
        const snapshot = { status: pending.status, owner: pending.owner, heartbeatAtMs: pending.heartbeatAtMs }
        const claim = yield* runs.claim("journal-run", snapshot, owner, 1)
        if (claim._tag !== "Claimed") {
          return yield* Effect.die(new Error("journal run claim was lost"))
        }
        yield* runs.activate("journal-run", owner, claim.claimedAtMs, snapshot)
        yield* ActionPersistence.make({
          runId: "journal-run",
          owner,
          sourceId: "journal-test",
          execute: () => Effect.succeed({ ok: true })
        })({
          action: {},
          attempt: 1,
          key: "caller-supplied-journal-key",
          tier: "sealed",
          metadata: { readSet: [], writeSet: ["result.json"], boundaryMode: "hard" }
        })
        const journal = yield* Journal.Journal
        yield* journal.flush
        return yield* journal.entries({ runId: "journal-run" as never, limit: 20 })
      }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jj)), Effect.scoped)
      const entries = yield* withCrypto(program)
      // Every attempt now anchors its frame, not only a compensable one: a sealed
      // dispatch records a `carried` tier-2 pointer so a rewind to this frame has
      // an address to restore.
      expect(entries.entries.map((entry) => entry.eventType)).toEqual([
        "flows.engine.attempt-started",
        "flows.engine.snapshot-identified",
        "flows.engine.attempt-finished",
        "flows.engine.cache-provenance",
        "flows.engine.cache-provenance"
      ])
      // Lineage is the frame address, and it is on every engine record.
      expect(entries.entries.map((entry) => (entry.meta as { lineageId?: string }).lineageId)).toEqual(
        entries.entries.map(() => FlowEngine.Lineage.root("journal-run"))
      )
    }))

  it.effect("allows exactly one claimant when two resumers race and a fresh runner reads cached completion", () =>
    Effect.gen(function*() {
      const program = Effect.gen(function*() {
        const runs = yield* RunStore.RunStore
        yield* runs.create("race-run", "{}")
        const pending = yield* runs.get("race-run")
        const snapshot = { status: pending.status, owner: pending.owner, heartbeatAtMs: pending.heartbeatAtMs }
        const left = { hostId: "journal", pid: 2, nonce: "left" }
        const right = { hostId: "journal", pid: 3, nonce: "right" }
        const claims = yield* Effect.all([
          runs.claim("race-run", snapshot, left, 1),
          runs.claim("race-run", snapshot, right, 1)
        ], { concurrency: "unbounded" })
        yield* runs.create("fresh-engine-run", "{}")
        const fresh = yield* runs.get("fresh-engine-run")
        const freshSnapshot = { status: fresh.status, owner: fresh.owner, heartbeatAtMs: fresh.heartbeatAtMs }
        const freshClaim = yield* runs.claim("fresh-engine-run", freshSnapshot, owner, 1)
        if (freshClaim._tag !== "Claimed") {
          return yield* Effect.die(new Error("fresh engine run claim was lost"))
        }
        yield* runs.activate("fresh-engine-run", owner, freshClaim.claimedAtMs, freshSnapshot)
        let dispatches = 0
        yield* ActionPersistence.make({
          runId: "fresh-engine-run",
          owner,
          sourceId: "first-engine",
          execute: () => Effect.sync(() => ++dispatches)
        })({
          action: {},
          attempt: 1,
          key: "fresh-engine-key",
          tier: "sealed",
          metadata: { readSet: [], writeSet: ["result.json"], boundaryMode: "hard" }
        })
        yield* runs.create("fresh-engine-poll", "{}")
        const poll = yield* runs.get("fresh-engine-poll")
        const pollSnapshot = { status: poll.status, owner: poll.owner, heartbeatAtMs: poll.heartbeatAtMs }
        const pollClaim = yield* runs.claim("fresh-engine-poll", pollSnapshot, owner, 1)
        if (pollClaim._tag !== "Claimed") {
          return yield* Effect.die(new Error("fresh engine poll claim was lost"))
        }
        yield* runs.activate("fresh-engine-poll", owner, pollClaim.claimedAtMs, pollSnapshot)
        const second = yield* ActionPersistence.make({
          runId: "fresh-engine-poll",
          owner,
          sourceId: "second-engine",
          execute: () => Effect.sync(() => ++dispatches)
        })({
          action: {},
          attempt: 1,
          key: "fresh-engine-key",
          tier: "sealed",
          metadata: { readSet: [], writeSet: ["result.json"], boundaryMode: "hard" }
        })
        return { claims, dispatches, second }
      }).pipe(Effect.provide(Layer.mergeAll(TestStores.layer(), StepBoundary.layerTest(), jj)), Effect.scoped)
      const result = yield* withCrypto(program)
      expect(result.claims.filter((claim) => claim._tag === "Claimed")).toHaveLength(1)
      expect(result).toMatchObject({ dispatches: 1, second: 1 })
    }))
})
