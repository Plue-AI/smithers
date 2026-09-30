import { expect, it } from "@effect/vitest"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as TestRunStore from "@smthrs/run-store/test/TestRunStore"
import { Clock, Context, Duration, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import * as ControlAffinity from "../src/internal/ControlAffinity.ts"

const claimant: Ownership.OwnerId = { hostId: "host", pid: process.pid, nonce: "observer" }
const peer: Ownership.OwnerId = { hostId: "host", pid: process.pid + 1, nonce: "parent" }
const staleAfter = Duration.toMillis(Ownership.heartbeatStaleAfter)

// Build separate production SQLite services: native control and engine rows
// have independent ownership, even when their execution IDs match.
const stores = <A, E>(body: (runs: RunStore.Service, engineRuns: RunStore.Service) => Effect.Effect<A, E>) =>
  Effect.scoped(Effect.gen(function*() {
    const runs = Context.get(yield* Layer.build(TestRunStore.layer), RunStore.RunStore)
    const engineRuns = Context.get(yield* Layer.build(TestRunStore.layer), RunStore.RunStore)
    return yield* body(runs, engineRuns)
  })).pipe(Effect.provide(TestClock.layer()))

const child = (runs: RunStore.Service, id = "child", parent = "root") =>
  runs.create(id, JSON.stringify({ version: 1, flowName: "worker", payload: {}, parentExecutionId: parent }))

const parent = (runs: RunStore.Service, owner = peer, parked = true) =>
  Effect.gen(function*() {
    yield* runs.create("root", "{}")
    const now = yield* Clock.currentTimeMillis
    expect((yield* runs.claimAndOwn("root", yield* runs.get("root"), owner, now))._tag).toBe("Activated")
    if (parked) {
      expect(
        (yield* runs.transitionOwned(
          "root",
          owner,
          "suspended",
          JSON.stringify({ parkedBy: JSON.stringify(owner), updatedAt: now })
        ))._tag
      ).toBe("Transitioned")
    }
    return yield* runs.get("root")
  })

it.effect("keeps engine-only children parked while a foreign control parent has a fresh lease", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      const before = yield* parent(runs)
      yield* child(engineRuns)
      const probe = vi.fn(() => Effect.succeed(false))
      const admit = ControlAffinity.make({ runs, engineRuns, claimant, isAlive: probe })
      expect(yield* admit("child")).toBe(false)
      yield* TestClock.adjust(staleAfter)
      expect(yield* admit("child")).toBe(false)
      expect(probe).not.toHaveBeenCalled()
      expect(yield* runs.get("root")).toEqual(before)
    })
  ))

it.effect("admits the parked parent's process across nonce changes without probing", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs, { ...claimant, nonce: "earlier" })
      yield* child(engineRuns)
      const probe = vi.fn(() => Effect.succeed(false))
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant, isAlive: probe })("child")).toBe(true)
      expect(probe).not.toHaveBeenCalled()
    })
  ))

it.effect("probes stale parked ancestors and recovers only a confirmed dead process", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      const before = yield* parent(runs)
      yield* child(engineRuns)
      yield* TestClock.adjust(staleAfter + 1)
      const nowMs = yield* Clock.currentTimeMillis
      const probe = vi.fn(() => Effect.succeed(true))
      const admit = ControlAffinity.make({ runs, engineRuns, claimant, isAlive: probe })
      expect(yield* admit("child")).toBe(false)
      expect(probe).toHaveBeenCalledWith(peer, { claimant, heartbeatAtMs: before.startedAtMs, nowMs })
      probe.mockImplementation(() => Effect.succeed(false))
      expect(yield* admit("child")).toBe(true)
      expect(yield* runs.get("root")).toEqual(before)
    })
  ))

it.effect("guards a nested child by its running control ancestor", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs, peer, false)
      yield* child(engineRuns, "middle")
      yield* child(engineRuns, "child", "middle")
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant })("child")).toBe(false)
    })
  ))

it.effect("follows persisted round lineage when an engine round has no parentExecutionId", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs)
      yield* child(engineRuns, "round-zero")
      yield* engineRuns.create("round-one", JSON.stringify({ version: 1, flowName: "worker", payload: {} }), {
        parentRunId: "round-zero",
        lineageId: "round-zero",
        roundOrdinal: 1
      })
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant })("round-one")).toBe(false)
    })
  ))

it.effect("admits standalone engine executions and cancellation despite a live parked parent", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs)
      yield* engineRuns.create("standalone", JSON.stringify({ version: 1, flowName: "worker", payload: {} }))
      yield* engineRuns.create(
        "cancelled-child",
        JSON.stringify({
          version: 1,
          flowName: "worker",
          payload: {},
          parentExecutionId: "root",
          cancellation: { interruptedAtMs: 0 }
        })
      )
      const admit = ControlAffinity.make({ runs, engineRuns, claimant })
      expect(yield* admit("standalone")).toBe(true)
      expect(yield* admit("cancelled-child")).toBe(true)
      yield* child(engineRuns, "requested-child")
      const now = yield* Clock.currentTimeMillis
      expect((yield* engineRuns.requestCancel("requested-child", now))._tag).toBe("CancelRequested")
      expect(yield* admit("requested-child")).toBe(true)
    })
  ))

it.effect("retains exact control-row admission independently of engine ancestry", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs)
      yield* child(engineRuns, "pending-child")
      yield* runs.create("pending-child", "{}")
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant })("pending-child")).toBe(true)
      // A direct suspended root keeps the existing explicit resume semantics;
      // parked ancestry only fences children recovered without that request.
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant })("root")).toBe(true)
    })
  ))

it.effect("fails closed for missing ancestors, cycles and undecodable engine state", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* child(engineRuns, "orphan", "missing")
      yield* child(engineRuns, "cycle-a", "cycle-b")
      yield* child(engineRuns, "cycle-b", "cycle-a")
      yield* engineRuns.create("invalid-envelope", "{}")
      const admit = ControlAffinity.make({ runs, engineRuns, claimant })
      for (const id of ["orphan", "cycle-a", "invalid-envelope"]) expect(yield* admit(id)).toBe(false)
    })
  ))

it.effect("fails closed for malformed parked ownership and inconclusive liveness", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs)
      yield* child(engineRuns)
      const snapshot = yield* runs.get("root")
      for (const summary of [{ parkedBy: "invalid", updatedAt: 0 }, { parkedBy: JSON.stringify(peer) }]) {
        // Public persistence validates JSON, but control summary validation is
        // admission's job; overwrite only that JSON through the service seam.
        const faulty = {
          ...runs,
          get: (id: string) =>
            id === "root"
              ? Effect.succeed({ ...snapshot, stateJson: JSON.stringify(summary) })
              : runs.get(id)
        }
        expect(yield* ControlAffinity.make({ runs: faulty, engineRuns, claimant })("child")).toBe(false)
      }
      yield* TestClock.adjust(staleAfter + 1)
      expect(
        yield* ControlAffinity.make({
          runs,
          engineRuns,
          claimant,
          isAlive: () => Effect.die("unavailable")
        })("child")
      ).toBe(false)
    })
  ))
