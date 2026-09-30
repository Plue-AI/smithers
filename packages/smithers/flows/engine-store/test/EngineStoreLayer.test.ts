import { describe, expect, it } from "@effect/vitest"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { FlowEngine } from "@smthrs/engine"
import { Action, DurableDeferred, Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { Node } from "@smthrs/plan"
import { type Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Schema from "effect/Schema"
import { TestClock } from "effect/testing"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as StepSandbox from "../src/StepSandbox.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { executeUntilParked } from "./ExecuteUntilParked.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const LayerFlow = Flow.make("EngineStoreLayer/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const otherOwner: Ownership.OwnerId = {
  hostId: "other-host",
  pid: 4242,
  nonce: "other-owner"
}

interface JjCall {
  readonly op: "snapshot" | "restore" | "diff"
  readonly argument: string
}

const recordingJj = (
  calls: Array<JjCall>,
  overrides: Partial<Jj.Jj> = {}
): Jj.Jj =>
  Jj.make({
    snapshot: (message) =>
      Effect.sync(() => {
        calls.push({ op: "snapshot", argument: message ?? "" })
        // A distinct change id: the boundary must hand out the commit id.
        return { commitId: `change-${calls.length}` as never, changeId: `moving-${calls.length}` as never }
      }),
    restore: (changeId) =>
      Effect.sync(() => {
        calls.push({ op: "restore", argument: changeId as string })
      }),
    diff: (from, to) =>
      Effect.sync(() => {
        calls.push({ op: "diff", argument: `${from as string}->${to as string}` })
        return "diff-body"
      }),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed(""),
    ...overrides
  })

const baseLayers = (jj: Jj.Jj, state: DurableEngineState.Service) =>
  Layer.mergeAll(
    TestStores.layer(),
    StepBoundary.layerTest(),
    Layer.succeed(Jj.Jj, jj),
    Layer.succeed(DurableEngineState.DurableEngineState, state)
  )

describe("EngineStore.layer", () => {
  it("names opaque-handler fixtures and refuses accidental body interpretation", () => {
    expect(() => LayerFlow.body({})).toThrow("opaque-handler fixture bodies must not be interpreted")
  })

  it.effect("exposes a snapshot boundary that delegates to Jj with key- and attempt-labelled messages", () =>
    Effect.gen(function*() {
      const calls: Array<JjCall> = []
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const boundary = yield* FlowEngine.SnapshotBoundary
          const options: FlowEngine.SnapshotBoundaryOptions = {
            flow: LayerFlow,
            executionId: "layer-exec",
            key: "step/one",
            attempt: 2,
            metadata: undefined
          }
          const snapshot = yield* boundary.snapshot(options)
          const diff = yield* boundary.diff(snapshot, options)
          yield* boundary.restore(snapshot, options)
          return { snapshot, diff }
        })).pipe(
          Effect.provide(
            EngineStore.layer({
              owner: { hostId: "layer-host" },
              journalSource: "layer-test",
              isAlive: () => Effect.succeed(true)
            }).pipe(
              Layer.provideMerge(baseLayers(recordingJj(calls), DurableEngineState.makeMemory()))
            )
          ),
          Effect.scoped
        )
      )

      expect(result.snapshot).toBe("change-1")
      expect(result.diff).toBe("diff-body")
      expect(calls).toEqual([
        { op: "snapshot", argument: "smithers action step/one attempt 2" },
        { op: "snapshot", argument: "smithers action step/one attempt 2 settled" },
        { op: "diff", argument: "change-1->change-2" },
        { op: "restore", argument: "change-1" }
      ])
    }))

  it.effect("keeps engine checkpoint authority separate from the action-facing Jj service", () =>
    Effect.gen(function*() {
      const actionCalls: Array<JjCall> = []
      const engineCalls: Array<JjCall> = []
      const privileged = recordingJj(engineCalls)
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const boundary = yield* FlowEngine.SnapshotBoundary
          const options: FlowEngine.SnapshotBoundaryOptions = {
            flow: LayerFlow,
            executionId: "private-jj-exec",
            key: "step/private",
            attempt: 3,
            metadata: undefined
          }
          const snapshot = yield* boundary.snapshot(options)
          const diff = yield* boundary.diff(snapshot, options)
          yield* boundary.restore(snapshot, options)
          return { snapshot, diff }
        })).pipe(
          Effect.provide(
            EngineStore.layerWithPrivilegedJj(
              {
                owner: { hostId: "layer-host" },
                journalSource: "layer-test",
                isAlive: () => Effect.succeed(true)
              },
              Layer.succeed(Jj.Jj, privileged)
            ).pipe(
              Layer.provideMerge(
                baseLayers(recordingJj(actionCalls), DurableEngineState.makeMemory())
              )
            )
          ),
          Effect.scoped
        )
      )

      expect(result).toEqual({ snapshot: "change-1", diff: "diff-body" })
      expect(actionCalls).toEqual([])
      expect(engineCalls).toEqual([
        { op: "snapshot", argument: "smithers action step/private attempt 3" },
        { op: "snapshot", argument: "smithers action step/private attempt 3 settled" },
        { op: "diff", argument: "change-1->change-2" },
        { op: "restore", argument: "change-1" }
      ])
    }))

  it.effect("turns a Jj snapshot failure into a defect rather than a typed boundary error", () =>
    Effect.gen(function*() {
      const calls: Array<JjCall> = []
      const failing = recordingJj(calls, {
        snapshot: () => Effect.fail({ _tag: "JjError", message: "worktree busy" } as never)
      })
      const exit = yield* withCrypto(
        Effect.scoped(
          Effect.exit(
            Effect.flatMap(
              FlowEngine.SnapshotBoundary,
              (boundary) =>
                boundary.snapshot({
                  flow: LayerFlow,
                  executionId: "layer-exec",
                  key: "step/two",
                  attempt: 1,
                  metadata: undefined
                })
            )
          )
        ).pipe(
          Effect.provide(
            EngineStore.layer({
              owner: { hostId: "layer-host" },
              journalSource: "layer-test",
              isAlive: () => Effect.succeed(true)
            }).pipe(
              Layer.provideMerge(baseLayers(failing, DurableEngineState.makeMemory()))
            )
          ),
          Effect.scoped
        )
      )

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(calls).toEqual([])
    }))

  it.effect("provides a flow engine from the same layer that drives a registered flow to completion", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const row = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          yield* engine.register(LayerFlow, () => Effect.succeed("layered"))
          const value = yield* engine.execute(LayerFlow, {
            executionId: "layered-run",
            payload: {},
            discard: false
          })
          const store = yield* RunStore.RunStore
          return { value, row: yield* store.get("layered-run") }
        })).pipe(
          Effect.provide(
            EngineStore.layer({
              owner: { hostId: "layer-host" },
              journalSource: "layer-test",
              isAlive: () => Effect.succeed(true)
            }).pipe(
              Layer.provideMerge(baseLayers(recordingJj([]), state))
            )
          ),
          Effect.scoped
        )
      )

      expect(row.value).toBe("layered")
      expect(row.row.status).toBe("completed")
    }))
})

describe("EngineStore.make liveness", () => {
  it.effect("forwards the stable registration-sweep wake identity to the journal", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const entries = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const runs = yield* RunStore.RunStore
          yield* runs.create(
            "historical-deferred",
            JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: LayerFlow._tag, payload: {} })
          )
          yield* state.completeDeferred({
            flowName: LayerFlow._tag,
            executionId: "historical-deferred",
            deferredName: "answer",
            exit: Exit.succeed("ready"),
            completedAtMs: 1
          })
          const engine = yield* EngineStore.make({
            owner: { hostId: "layer-host" },
            journalSource: "layer-test",
            isAlive: () => Effect.succeed(true)
          })
          yield* engine.register(LayerFlow, () => Effect.succeed("resumed"))
          const journal = yield* Journal.Journal
          yield* journal.flush
          return (yield* journal.entries({ runId: "historical-deferred" as never, limit: 100 })).entries
        })).pipe(Effect.provide(baseLayers(recordingJj([]), state)))
      )

      const wakes = entries.filter((entry) =>
        entry.eventType === "flows.engine.run-decision" &&
        (entry.payload as { readonly decision?: string }).decision === "wake-scheduled"
      )
      expect(wakes).toHaveLength(1)
      expect(wakes[0]).toMatchObject({
        sourceId: "layer-test:wake:[\"EngineStoreLayer/Flow\",\"historical-deferred\",\"answer\"]",
        sourceSeq: 0
      })
    }))

  // Real elapsed time: `it.effect`'s TestClock would stall this.
  it.live("uses a supplied liveness probe, so a live foreign owner is never stolen from", () =>
    Effect.gen(function*() {
      let executions = 0
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          // Seed a `running` row owned by another host whose heartbeat is
          // ancient, so only the liveness probe stands between it and a steal.
          // Seed the ownership write under a clock at zero. The live clock
          // then observes a stale lease, so the liveness probe decides.
          const owned = yield* Effect.gen(function*() {
            yield* store.create(
              "foreign-run",
              JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: LayerFlow._tag, payload: {} })
            )
            const created = yield* store.get("foreign-run")
            const expected = { status: created.status, owner: created.owner, heartbeatAtMs: created.heartbeatAtMs }
            return yield* store.claimAndOwn("foreign-run", expected, otherOwner, 0)
          }).pipe(Effect.provide(TestClock.layer()))
          expect(owned._tag).toBe("Activated")

          const engine = yield* EngineStore.make({
            owner: { hostId: "layer-host" },
            journalSource: "layer-test",
            isAlive: () => Effect.succeed(true)
          })
          yield* engine.register(
            LayerFlow,
            () =>
              Effect.sync(() => {
                executions++
                return "stolen"
              })
          )
          yield* engine.resume(LayerFlow, "foreign-run")
          const journal = yield* Journal.Journal
          yield* journal.flush
          const entries = yield* journal.entries({ runId: "foreign-run" as never, limit: 100 })
          return { row: yield* store.get("foreign-run"), entries: entries.entries }
        })).pipe(
          Effect.provide(baseLayers(recordingJj([]), DurableEngineState.makeMemory()))
        )
      )

      expect(executions).toBe(0)
      expect(result.row.status).toBe("running")
      expect(result.row.owner).toEqual(otherOwner)
      const decisions = result.entries
        .filter((entry) => entry.eventType === "flows.engine.run-decision")
        .map((entry) => (entry.payload as { decision: string }).decision)
      expect(decisions).toContain("steal-refused-owner-alive")
    }))

  // Real elapsed time, for the same reason as the probe case above.
  it.live("reclaims an abandoned run with no liveness probe supplied at all", () =>
    Effect.gen(function*() {
      // `Options.isAlive` used to be required, so a composition that had
      // nothing but the persisted lease could not be written: the honest
      // answer for a host with no probe is "I do not know", and the only way
      // to say it was `() => Effect.succeed(true)`, which strands a
      // hard-killed owner's runs forever. Omitting the option now means the
      // lease decides.
      let executions = 0
      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          // The same seeding as the probe case: a foreign owner holding a
          // `running` row whose lease expired at time 0 and is never renewed,
          // which is what SIGKILL leaves behind.
          const owned = yield* Effect.gen(function*() {
            yield* store.create(
              "abandoned-run",
              JSON.stringify({ capabilityCeilings: [[]], version: 1, flowName: LayerFlow._tag, payload: {} })
            )
            const created = yield* store.get("abandoned-run")
            const expected = { status: created.status, owner: created.owner, heartbeatAtMs: created.heartbeatAtMs }
            return yield* store.claimAndOwn("abandoned-run", expected, otherOwner, 0)
          }).pipe(Effect.provide(TestClock.layer()))
          expect(owned._tag).toBe("Activated")

          const engine = yield* EngineStore.make({
            owner: { hostId: "layer-host" },
            journalSource: "layer-test"
          })
          yield* engine.register(
            LayerFlow,
            () =>
              Effect.sync(() => {
                executions++
                return "reclaimed"
              })
          )
          yield* engine.resume(LayerFlow, "abandoned-run")
          const journal = yield* Journal.Journal
          yield* journal.flush
          const entries = yield* journal.entries({ runId: "abandoned-run" as never, limit: 100 })
          return { row: yield* store.get("abandoned-run"), entries: entries.entries }
        })).pipe(
          Effect.provide(baseLayers(recordingJj([]), DurableEngineState.makeMemory()))
        )
      )

      expect(executions).toBe(1)
      expect(result.row.status).toBe("completed")
      const steals = result.entries
        .filter((entry) => entry.eventType === "flows.engine.run-decision")
        .map((entry) => entry.payload as { readonly decision: string; readonly evidence?: string })
        .filter((decision) => decision.decision === "stolen-and-activated")
      expect(steals).toEqual([expect.objectContaining({ evidence: "lease-expired" })])
    }))

  it.effect("replays an action that declares no idempotency key from its own run journal", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      let dispatches = 0
      const unkeyed = Action.make({
        name: "unkeyed",
        success: Schema.String,
        tier: "sealed",
        execute: Effect.sync(() => {
          dispatches++
          return `dispatch-${dispatches}`
        })
      })
      const gate = DurableDeferred.make("engine-store-gate", { success: Schema.String })
      const handler = () =>
        Effect.gen(function*() {
          const value = yield* unkeyed
          const released = yield* DurableDeferred.await(gate)
          return `${value}/${released}`
        })

      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const makeEngine = EngineStore.make({
            owner: { hostId: "layer-host" },
            journalSource: "layer-test",
            isAlive: () => Effect.succeed(false)
          })
          const first = yield* makeEngine
          yield* first.register(LayerFlow, handler)
          yield* executeUntilParked(first, LayerFlow, {
            executionId: "unkeyed-run",
            payload: {},
            discard: true
          })
          const store = yield* RunStore.RunStore
          const suspended = yield* store.get("unkeyed-run")

          // A fresh engine over the same durable state models a restart.
          const restarted = yield* makeEngine
          yield* restarted.register(LayerFlow, handler)
          yield* restarted.deferredDone(gate, {
            flowName: LayerFlow._tag,
            executionId: "unkeyed-run",
            deferredName: gate.name,
            exit: Exit.succeed("released")
          })
          yield* TestDatabase.until(store.get("unkeyed-run").pipe(Effect.map((row) => row.status === "completed")))
          const value = yield* restarted.execute(LayerFlow, {
            executionId: "unkeyed-run",
            payload: {},
            discard: false
          })
          return { suspended, value }
        })).pipe(
          Effect.provide(baseLayers(recordingJj([]), state))
        )
      )

      expect(result.suspended.status).toBe("suspended")
      expect(result.value).toBe("dispatch-1/released")
      // Replay came from the run's own attempt journal, not a second dispatch.
      expect(dispatches).toBe(1)
    }))
})

describe("EngineStore boundary metadata", () => {
  it.effect("propagates declared nondeterminism through a keyed durable cache race", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      const bothStarted = yield* Deferred.make<void>()
      const executions = yield* Ref.make(0)
      const action = Action.make({
        name: "hermetic-nondeterministic",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "engine-store-nondeterministic-v1",
        nondeterministic: true,
        metadata: { readSet: [], writeSet: ["output.txt"], boundaryMode: "hard" },
        execute: Effect.gen(function*() {
          const ordinal = yield* Ref.updateAndGet(executions, (value) => value + 1)
          if (ordinal === 2) yield* Deferred.succeed(bothStarted, undefined)
          yield* Deferred.await(bothStarted)
          return `result-${ordinal}`
        })
      })

      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const engine = yield* EngineStore.make({
            owner: { hostId: "layer-host" },
            journalSource: "layer-test",
            isAlive: () => Effect.succeed(false)
          })
          yield* engine.register(LayerFlow, () => action as unknown as Effect.Effect<string, never, never>)
          const raced = yield* Effect.all([
            engine.execute(LayerFlow, {
              executionId: "nondeterministic-a",
              payload: {},
              discard: false
            }),
            engine.execute(LayerFlow, {
              executionId: "nondeterministic-b",
              payload: {},
              discard: false
            })
          ], { concurrency: "unbounded" })
          const replayed = yield* engine.execute(LayerFlow, {
            executionId: "nondeterministic-c",
            payload: {},
            discard: false
          })
          const journal = yield* Journal.Journal
          yield* journal.flush
          const pages = yield* Effect.forEach(
            ["nondeterministic-a", "nondeterministic-b"],
            (runId) => journal.entries({ runId: runId as never, limit: 100 })
          )
          return {
            raced,
            replayed,
            executions: yield* Ref.get(executions),
            firstWriterEvents: pages.flatMap((page) => page.entries).filter((entry) =>
              entry.eventType === "flows.engine.cache-provenance" &&
              (entry.payload as { readonly action?: string }).action === "conflict_first_writer"
            )
          }
        })).pipe(
          Effect.provide(
            Layer.mergeAll(
              baseLayers(recordingJj([]), state),
              StepSandbox.layerTest(),
              Action.layerCacheEnvironment({ layers: [], capabilities: {} })
            )
          )
        )
      )

      expect(new Set(result.raced)).toEqual(new Set(["result-1", "result-2"]))
      expect(result.raced).toContain(result.replayed)
      expect(result.executions).toBe(2)
      expect(result.firstWriterEvents).toHaveLength(1)
    }))

  it.effect("forwards a hermetic boundary descriptor so a sealed result is shared across runs", () =>
    Effect.gen(function*() {
      const state = DurableEngineState.makeMemory()
      let dispatches = 0
      const hermetic = Action.make({
        name: "hermetic",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "engine-store-hermetic-v1",
        metadata: { readSet: [], writeSet: ["output.txt"], boundaryMode: "hard" },
        execute: Effect.sync(() => {
          dispatches++
          return "hermetic-result"
        })
      })

      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const engine = yield* EngineStore.make({
            owner: { hostId: "layer-host" },
            journalSource: "layer-test",
            isAlive: () => Effect.succeed(false)
          })
          yield* engine.register(LayerFlow, () => hermetic as unknown as Effect.Effect<string, never, never>)
          const first = yield* engine.execute(LayerFlow, {
            executionId: "hermetic-a",
            payload: {},
            discard: false
          })
          const second = yield* engine.execute(LayerFlow, {
            executionId: "hermetic-b",
            payload: {},
            discard: false
          })
          return { first, second }
        })).pipe(
          Effect.provide(
            Layer.mergeAll(
              baseLayers(recordingJj([]), state),
              StepSandbox.layerTest(),
              // Cross-run reuse is only offered once the composition states the
              // environment its sealed keys were computed under: an undeclared
              // environment pins the key to its own execution, so the two runs
              // would address distinct rows and never share.
              Action.layerCacheEnvironment({ layers: [], capabilities: {} })
            )
          )
        )
      )

      expect(result.first).toBe("hermetic-result")
      expect(result.second).toBe("hermetic-result")
      // The declared hard boundary with whole-tree write proof makes the sealed
      // result cacheable, so the second run replays it instead of dispatching.
      expect(dispatches).toBe(1)
    }))

  it.effect("keeps a sealed result run-local while the cache environment is absent", () =>
    Effect.gen(function*() {
      // The admission half of the same invariant: identical declarations, an
      // identical hard boundary, and no declared environment must still execute
      // twice, because nothing proves the second run resolves the same layers
      // and capabilities as the first.
      const state = DurableEngineState.makeMemory()
      let dispatches = 0
      const hermetic = Action.make({
        name: "hermetic-undeclared",
        success: Schema.String,
        tier: "sealed",
        idempotencyKey: "engine-store-hermetic-undeclared-v1",
        metadata: { readSet: [], writeSet: ["output.txt"], boundaryMode: "hard" },
        execute: Effect.sync(() => {
          dispatches++
          return `hermetic-result-${dispatches}`
        })
      })

      const result = yield* withCrypto(
        Effect.scoped(Effect.gen(function*() {
          const engine = yield* EngineStore.make({
            owner: { hostId: "layer-host" },
            journalSource: "layer-test",
            isAlive: () => Effect.succeed(false)
          })
          yield* engine.register(LayerFlow, () => hermetic as unknown as Effect.Effect<string, never, never>)
          const first = yield* engine.execute(LayerFlow, {
            executionId: "undeclared-a",
            payload: {},
            discard: false
          })
          const second = yield* engine.execute(LayerFlow, {
            executionId: "undeclared-b",
            payload: {},
            discard: false
          })
          return { first, second }
        })).pipe(Effect.provide(baseLayers(recordingJj([]), state)))
      )

      expect(result.first).toBe("hermetic-result-1")
      expect(result.second).toBe("hermetic-result-2")
      expect(dispatches).toBe(2)
    }))
})
