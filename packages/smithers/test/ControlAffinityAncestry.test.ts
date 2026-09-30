import { expect, it } from "@effect/vitest"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as TestRunStore from "@smthrs/run-store/test/TestRunStore"
import { Cause, Clock, Context, Duration, Effect, Exit, Layer, Logger } from "effect"
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

const releaseChild = (runs: RunStore.Service, intentional = false) =>
  Effect.gen(function*() {
    yield* child(runs)
    const now = yield* Clock.currentTimeMillis
    expect((yield* runs.claimAndOwn("child", yield* runs.get("child"), claimant, now))._tag).toBe("Activated")
    const state = JSON.parse((yield* runs.get("child")).stateJson)
    if (intentional) state.result = { _tag: "Suspended", token: "signal" }
    expect((yield* runs.transitionOwned("child", claimant, "suspended", JSON.stringify(state)))._tag).toBe(
      "Transitioned"
    )
    return yield* runs.get("child")
  })

it.effect("keeps a released child stopped under its own live parked parent across nonce changes", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      const root = yield* parent(runs, { ...claimant, nonce: "earlier" })
      const released = yield* releaseChild(engineRuns)
      const probe = vi.fn(() => Effect.succeed(false))
      const admit = ControlAffinity.make({ runs, engineRuns, claimant, isAlive: probe })
      expect(yield* admit("child")).toBe(false)
      yield* TestClock.adjust(staleAfter + 1)
      expect(yield* admit("child")).toBe(false)
      expect(probe).not.toHaveBeenCalled()
      expect(yield* runs.get("root")).toEqual(root)
      expect(yield* engineRuns.get("child")).toEqual(released)
    })
  ))

it.effect("admits a released child when explicit resume has activated its parent", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs, claimant, false)
      yield* releaseChild(engineRuns)
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant })("child")).toBe(false)
      const canRetryReleased = vi.fn(() => Effect.succeed(true))
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant, canRetryReleased })("child")).toBe(true)
      expect(canRetryReleased).toHaveBeenCalledExactlyOnceWith("child", "root")
    })
  ))

it.effect("admits an intentional suspension for the parked parent's own process", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs, claimant)
      yield* releaseChild(engineRuns, true)
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant })("child")).toBe(true)
    })
  ))

it.effect("recovers a released child only after its foreign parked owner is stale and dead", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs)
      yield* releaseChild(engineRuns)
      const probe = vi.fn(() => Effect.succeed(false))
      const canRetryReleased = vi.fn(() => Effect.succeed(true))
      const admit = ControlAffinity.make({ runs, engineRuns, claimant, isAlive: probe, canRetryReleased })
      expect(yield* admit("child")).toBe(false)
      expect(probe).not.toHaveBeenCalled()
      yield* TestClock.adjust(staleAfter + 1)
      probe.mockImplementation(() => Effect.succeed(true))
      expect(yield* admit("child")).toBe(false)
      probe.mockImplementation(() => Effect.succeed(false))
      expect(yield* admit("child")).toBe(true)
      expect(canRetryReleased).toHaveBeenCalledExactlyOnceWith("child", "root")
      canRetryReleased.mockImplementation(() => Effect.succeed(false))
      expect(yield* admit("child")).toBe(false)
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant, isAlive: probe })("child")).toBe(false)
    })
  ))

it.effect("settles cancellation of a released child despite its own parked ancestor", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs, claimant)
      yield* releaseChild(engineRuns)
      const now = yield* Clock.currentTimeMillis
      expect((yield* engineRuns.requestCancel("child", now))._tag).toBe("CancelRequested")
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant })("child")).toBe(true)
    })
  ))

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

it.effect("fails closed for engine read failures while preserving interruption", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs)
      yield* child(engineRuns)
      const error = new RunStore.RunStoreError({
        code: "persistence_failed",
        method: "get",
        message: "unavailable",
        cause: null
      })
      // Inject only transport errors; ancestry and lifecycle cases above use
      // the actual SQLite persistence service and its public writes.
      for (const get of [() => Effect.fail(error), () => Effect.die("broken read")]) {
        expect(yield* ControlAffinity.make({ runs, engineRuns: { ...engineRuns, get }, claimant })("child")).toBe(false)
      }
      const exit = yield* Effect.exit(
        ControlAffinity.make({
          runs,
          engineRuns: { ...engineRuns, get: () => Effect.interrupt },
          claimant
        })("child")
      )
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    })
  ))

it.effect("uses explicit retry authorization after its same-process control ancestor re-parks", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs, claimant)
      yield* releaseChild(engineRuns)
      // The root can finish its resume drive and park before its linked child
      // is admitted; durable authorization must survive that ordering.
      const canRetryReleased = vi.fn(() => Effect.succeed(true))
      const admit = ControlAffinity.make({ runs, engineRuns, claimant, canRetryReleased })
      expect(yield* admit("child")).toBe(true)
      expect(canRetryReleased).toHaveBeenCalledExactlyOnceWith("child", "root")
      canRetryReleased.mockImplementation(() => Effect.succeed(false))
      expect(yield* admit("child")).toBe(false)
    })
  ))

it.effect("does not consult a retry grant for a foreign fresh parked owner", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs)
      yield* releaseChild(engineRuns)
      const canRetryReleased = vi.fn(() => Effect.succeed(true))
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant, canRetryReleased })("child")).toBe(false)
      expect(canRetryReleased).not.toHaveBeenCalled()
    })
  ))

it.effect("does not consult retry grants for ordinary or deliberately suspended children", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs, claimant)
      yield* child(engineRuns, "pending")
      yield* releaseChild(engineRuns, true)
      const canRetryReleased = vi.fn(() => Effect.succeed(false))
      const admit = ControlAffinity.make({ runs, engineRuns, claimant, canRetryReleased })
      expect(yield* admit("pending")).toBe(true)
      expect(yield* admit("child")).toBe(true)
      expect(canRetryReleased).not.toHaveBeenCalled()
    })
  ))

it.effect("fails closed for retry authorization errors without swallowing interruption", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs, claimant)
      yield* releaseChild(engineRuns)
      expect(
        yield* ControlAffinity.make({
          runs,
          engineRuns,
          claimant,
          canRetryReleased: () => Effect.die("authorization unavailable")
        })("child")
      ).toBe(false)
      const exit = yield* Effect.exit(
        ControlAffinity.make({
          runs,
          engineRuns,
          claimant,
          canRetryReleased: () => Effect.interrupt
        })("child")
      )
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
    })
  ))

it.effect("does not recover a stale parked owner on an unknown remote host", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs, { ...peer, hostId: "remote-host" })
      yield* releaseChild(engineRuns)
      yield* TestClock.adjust(staleAfter + 1)
      const isAlive = vi.fn(() => Effect.succeed(false))
      const canRetryReleased = vi.fn(() => Effect.succeed(true))
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant, isAlive, canRetryReleased })("child")).toBe(
        false
      )
      expect(isAlive).not.toHaveBeenCalled()
      expect(canRetryReleased).not.toHaveBeenCalled()
    })
  ))

it.effect("silently denies absent or malformed parked ownership instead of logging observer warnings", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* parent(runs)
      yield* releaseChild(engineRuns)
      const row = yield* runs.get("root")
      const logs: Array<unknown> = []
      const capture = Logger.layer([Logger.make((entry) => void logs.push(entry.message))], {
        mergeWithExisting: false
      })
      for (
        const summary of [{ updatedAt: 0 }, { updatedAt: 0, parkedBy: "malformed" }, { parkedBy: JSON.stringify(peer) }]
      ) {
        const faulty = {
          ...runs,
          get: (id: string) =>
            id === "root" ? Effect.succeed({ ...row, stateJson: JSON.stringify(summary) }) : runs.get(id)
        }
        expect(
          yield* ControlAffinity.make({ runs: faulty, engineRuns, claimant })("child").pipe(Effect.provide(capture))
        ).toBe(false)
      }
      expect(logs).toHaveLength(0)
    })
  ))

/**
 * A configured host that re-drives an `agent/run` root it claimed re-drives
 * that root's approved module with it (#3144). Everything the module spawned
 * keeps the explicit retry fence, as does any other shape of child.
 */
const moduleTree = (
  runs: RunStore.Service,
  engineRuns: RunStore.Service,
  options: {
    readonly rootFlow?: string
    readonly moduleFlow?: string
    readonly onParentExit?: "cancel" | "detach"
    readonly releaseWorker?: boolean
    readonly owner?: Ownership.OwnerId
    readonly parked?: boolean
  } = {}
) =>
  Effect.gen(function*() {
    const owner = options.owner ?? claimant
    yield* runs.create("root", JSON.stringify({ runId: "root", flowId: "native", status: "running" }))
    const now = yield* Clock.currentTimeMillis
    expect((yield* runs.claimAndOwn("root", yield* runs.get("root"), owner, now))._tag).toBe("Activated")
    if (options.parked === true) {
      expect(
        (yield* runs.transitionOwned(
          "root",
          owner,
          "suspended",
          JSON.stringify({ flowId: "native", parkedBy: JSON.stringify(owner), updatedAt: now })
        ))._tag
      ).toBe("Transitioned")
    }
    yield* engineRuns.create(
      "root",
      JSON.stringify({ version: 1, flowName: options.rootFlow ?? "agent/run", payload: {} })
    )
    const release = (id: string, state: object) =>
      Effect.gen(function*() {
        yield* engineRuns.create(id, JSON.stringify(state))
        expect((yield* engineRuns.claimAndOwn(id, yield* engineRuns.get(id), claimant, now))._tag).toBe("Activated")
        expect((yield* engineRuns.transitionOwned(id, claimant, "suspended", JSON.stringify(state)))._tag).toBe(
          "Transitioned"
        )
      })
    const module = {
      version: 1,
      flowName: options.moduleFlow ?? "native",
      payload: {},
      parentExecutionId: "root",
      onParentExit: options.onParentExit ?? "cancel"
    }
    if (options.releaseWorker === true) {
      yield* engineRuns.create("module", JSON.stringify(module))
      yield* release("worker", {
        version: 1,
        flowName: "native/Worker",
        payload: {},
        parentExecutionId: "module",
        onParentExit: "cancel"
      })
    } else {
      yield* release("module", module)
    }
  })

it.effect("re-drives the released approved module of the agent/run root this process is driving", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* moduleTree(runs, engineRuns)
      const canRetryReleased = vi.fn(() => Effect.succeed(false))
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant, canRetryReleased })("module")).toBe(true)
      expect(canRetryReleased).not.toHaveBeenCalled()
    })
  ))

it.effect.each(
  [
    ["a worker the module spawned", { releaseWorker: true }, "worker"],
    ["a detached child", { onParentExit: "detach" as const }, "module"],
    ["a child of another flow than the approved one", { moduleFlow: "other" }, "module"],
    ["a child of a root that is not agent/run", { rootFlow: "native" }, "module"]
  ] as const
)("keeps the explicit retry fence for %s", ([, options, id]) =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* moduleTree(runs, engineRuns, options)
      const canRetryReleased = vi.fn(() => Effect.succeed(false))
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant, canRetryReleased })(id)).toBe(false)
      expect(canRetryReleased).toHaveBeenCalledExactlyOnceWith(id, "root")
    })
  ))

it.effect("keeps the fence when the root is parked or claimed by another process", () =>
  stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* moduleTree(runs, engineRuns, { parked: true })
      const canRetryReleased = vi.fn(() => Effect.succeed(false))
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant, canRetryReleased })("module")).toBe(false)
      expect(canRetryReleased).toHaveBeenCalledExactlyOnceWith("module", "root")
    })
  ).pipe(Effect.andThen(stores((runs, engineRuns) =>
    Effect.gen(function*() {
      yield* moduleTree(runs, engineRuns, { owner: peer })
      const canRetryReleased = vi.fn(() => Effect.succeed(true))
      expect(yield* ControlAffinity.make({ runs, engineRuns, claimant, canRetryReleased })("module")).toBe(false)
      expect(canRetryReleased).not.toHaveBeenCalled()
    })
  ))))
