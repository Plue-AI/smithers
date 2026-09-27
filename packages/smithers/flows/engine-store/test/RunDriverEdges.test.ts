import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database/DurableWriter"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Node } from "@smthrs/plan"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as PubSub from "effect/PubSub"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import * as DurableEngineState from "../src/DurableEngineState.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as JournalRecords from "../src/internal/JournalRecords.ts"
import * as RunDriver from "../src/internal/RunDriver.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { withCrypto } from "./Sha256.ts"

const EdgeFlow = Flow.make("RunDriverEdges/Flow", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const OtherFlow = Flow.make("RunDriverEdges/Other", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const ObjectPayloadFlow = Flow.make("RunDriverEdges/ObjectPayload", {
  payload: { data: Schema.Unknown },
  success: Schema.String,
  body: opaqueHandlerBody
})

const UnregisteredFlow = Flow.make("RunDriverEdges/Unregistered", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const owner: Ownership.OwnerId = { hostId: "edge-host", pid: 7, nonce: "edge" }

const fakeEngine = {} as unknown as FlowRuntime.FlowRuntime["Service"]

const stateJson = (flowName: string, payload: unknown = {}) => JSON.stringify({ version: 1, flowName, payload })

const makeDriver = (
  isAlive: (owner: Ownership.OwnerId) => Effect.Effect<boolean> = () => Effect.succeed(false)
) =>
  RunDriver.make({
    owner,
    journalSource: "run-driver-edges",
    isAlive,
    engine: Effect.succeed(fakeEngine)
  })

const provideJournal = <A, E, R>(
  effect: Effect.Effect<A, E, R | Journal.Journal | RunStore.RunStore>
) =>
  effect.pipe(
    Effect.provide(TestStores.layer()),
    Effect.provide(DurableEngineState.layerMemory),
    Effect.scoped
  ) as Effect.Effect<
    A,
    E,
    Exclude<
      R,
      DurableWriter | Journal.Journal | RunStore.RunStore | DurableEngineState.DurableEngineState | Scope.Scope
    >
  >

const storeError = (code: RunStore.RunStoreErrorCode, method: string) =>
  new RunStore.RunStoreError({ code, method, message: `${code}: ${method}`, cause: undefined })

const decisionsFor = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* JournalRecords.entries(runId, undefined, 100)
    return page.entries
      .filter((entry) => entry.eventType === "flows.engine.run-decision")
      .map((entry) => (entry.payload as { decision: string }).decision)
  })

describe("samePayload", () => {
  it("compares encoded JSON structurally without admitting different payloads", () => {
    const reference = new Date(0)
    const nullPrototypeLeft = Object.assign(Object.create(null) as Record<string, unknown>, { value: 1 })
    const nullPrototypeRight = Object.assign(Object.create(null) as Record<string, unknown>, { value: 1 })
    expect(RunDriver.samePayload({ data: { a: 1, b: [2, 3] } }, { data: { b: [2, 3], a: 1 } })).toBe(true)
    expect(RunDriver.samePayload(-0, 0)).toBe(true)
    expect(RunDriver.samePayload(reference, reference)).toBe(true)
    expect(RunDriver.samePayload(nullPrototypeLeft, nullPrototypeRight)).toBe(true)
    expect(RunDriver.samePayload({ value: 1 }, { value: 2 })).toBe(false)
    expect(RunDriver.samePayload({ value: 1 }, { other: 1 })).toBe(false)
    expect(RunDriver.samePayload({ value: 1 }, { value: 1, other: 2 })).toBe(false)
    expect(RunDriver.samePayload([1, 2], [2, 1])).toBe(false)
    expect(RunDriver.samePayload([1, 2], [1, 2, 3])).toBe(false)
    expect(RunDriver.samePayload([1], { 0: 1 })).toBe(false)
    expect(RunDriver.samePayload({ 0: 1 }, [1])).toBe(false)
    expect(RunDriver.samePayload(null, {})).toBe(false)
    expect(RunDriver.samePayload("left", "right")).toBe(false)
    expect(RunDriver.samePayload({}, new Date(0))).toBe(false)
    expect(RunDriver.samePayload(new Date(0), new Date(0))).toBe(false)
  })
})

describe("RunDriver missing and foreign rows", () => {
  it.effect("drives nothing for an execution whose row does not exist", () =>
    Effect.gen(function*() {
      let executions = 0
      const active = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver()
        yield* driver.register(
          EdgeFlow,
          () =>
            Effect.sync(() => {
              executions++
              return "never"
            })
        )
        // `resume` schedules a wake and then drives; both must be no-ops for a
        // row that was never created.
        yield* driver.resume(EdgeFlow, "ghost")
        return yield* driver.active
      })))

      expect(executions).toBe(0)
      expect([...active]).toEqual([])
    }))

  it.effect("dies when the run store fails for a reason other than a missing row", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const broken = RunStore.makeNoop({
          ...base,
          get: () => Effect.fail(storeError("persistence_failed", "get"))
        })
        const driver = yield* makeDriver().pipe(Effect.provideService(RunStore.RunStore, broken))
        yield* driver.register(EdgeFlow, () => Effect.succeed("never"))
        return yield* Effect.exit(driver.resume(EdgeFlow, "broken"))
      })))

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect((Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined) as RunStore.RunStoreError)
        .toMatchObject({ code: "persistence_failed" })
    }))

  it.effect("leaves an existing row untouched when no handler is registered for its flow", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* store.create("unregistered", stateJson(UnregisteredFlow._tag))
        const driver = yield* makeDriver()
        // Only `EdgeFlow` is registered, so the persisted flow name resolves to
        // no registration and the driver must not claim the row.
        yield* driver.register(EdgeFlow, () => Effect.succeed("never"))
        yield* driver.resume(UnregisteredFlow, "unregistered")
        return {
          row: yield* store.get("unregistered"),
          decisions: yield* decisionsFor("unregistered")
        }
      })))

      expect(result.row.status).toBe("pending")
      expect(result.row.owner).toBeNull()
      expect(result.decisions).toEqual(["wake-scheduled"])
    }))

  it.effect("records claim-lost and skips execution when the row moves under the claim", () =>
    Effect.gen(function*() {
      let executions = 0
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const racing = RunStore.makeNoop({
          ...base,
          claim: (runId, expected, claimant, nowMs) =>
            // Another worker claims first: the expected snapshot no longer
            // matches by the time this claim runs.
            base.claim(runId, expected, { hostId: "rival", pid: 9, nonce: "rival" }, nowMs).pipe(
              Effect.andThen(base.claim(runId, expected, claimant, nowMs))
            )
        })
        const driver = yield* makeDriver().pipe(Effect.provideService(RunStore.RunStore, racing))
        yield* base.create("claim-lost", stateJson(EdgeFlow._tag))
        yield* driver.register(
          EdgeFlow,
          () =>
            Effect.sync(() => {
              executions++
              return "never"
            })
        )
        yield* driver.resume(EdgeFlow, "claim-lost")
        return {
          decisions: yield* decisionsFor("claim-lost"),
          row: yield* base.get("claim-lost")
        }
      })))

      expect(executions).toBe(0)
      expect(result.decisions).toContain("claim-lost")
      expect(result.row.status).toBe("pending")
    }))

  it.effect("stops before executing when the post-activation running transition loses its fence", () =>
    Effect.gen(function*() {
      let executions = 0
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const fenceLost = RunStore.makeNoop({
          ...base,
          transitionOwned: (runId, claimant, status, stateJson, guard) =>
            status === "running"
              // A different owner holds the row by the time the activation
              // transition runs, so the CAS matches no row.
              ? base.transitionOwned(runId, { hostId: "other", pid: 1, nonce: "other" }, status, stateJson, guard)
              : base.transitionOwned(runId, claimant, status, stateJson, guard)
        })
        const driver = yield* makeDriver().pipe(Effect.provideService(RunStore.RunStore, fenceLost))
        yield* base.create("fence-lost", stateJson(EdgeFlow._tag))
        yield* driver.register(
          EdgeFlow,
          () =>
            Effect.sync(() => {
              executions++
              return "never"
            })
        )
        yield* driver.resume(EdgeFlow, "fence-lost")
        return yield* base.get("fence-lost")
      })))

      expect(executions).toBe(0)
      // Activation happened, so the row stays `running` under this owner; the
      // driver simply declines to execute after the failed transition.
      expect(result.status).toBe("running")
    }))

  it.effect("keeps a result unpublished when the terminal transition loses its fence", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const fenceLost = RunStore.makeNoop({
          ...base,
          transitionOwned: (runId, claimant, status, stateJson, guard) =>
            status === "completed"
              ? base.transitionOwned(runId, { hostId: "other", pid: 1, nonce: "other" }, status, stateJson, guard)
              : base.transitionOwned(runId, claimant, status, stateJson, guard)
        })
        const driver = yield* makeDriver().pipe(Effect.provideService(RunStore.RunStore, fenceLost))
        yield* base.create("terminal-fence-lost", stateJson(EdgeFlow._tag))
        yield* driver.register(EdgeFlow, () => Effect.succeed("done"))
        yield* driver.resume(EdgeFlow, "terminal-fence-lost")
        return {
          row: yield* base.get("terminal-fence-lost"),
          decisions: yield* decisionsFor("terminal-fence-lost"),
          polled: yield* driver.poll(EdgeFlow, "terminal-fence-lost")
        }
      })))

      expect(result.row.status).toBe("running")
      expect(result.decisions).not.toContain("transitioned")
      // No result was persisted, so a poll cannot observe a completion.
      expect(Option.isNone(result.polled)).toBe(true)
    }))
})

describe("RunDriver poll", () => {
  it.effect("fails typed for a missing row and reports None for a foreign flow tag and an unfinished run", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* store.create("other-flow", stateJson(OtherFlow._tag))
        yield* store.create("no-result", stateJson(EdgeFlow._tag))
        yield* driver.register(EdgeFlow, () => Effect.succeed("done"))
        yield* driver.execute(EdgeFlow, { executionId: "settled", payload: {}, discard: true })
        return {
          // An id with no run row at all is a typed not-found; `Option.none`
          // is reserved for a run the store knows and has not settled.
          missing: yield* Effect.flip(driver.poll(EdgeFlow, "absent")),
          foreign: yield* driver.poll(EdgeFlow, "other-flow"),
          unfinished: yield* driver.poll(EdgeFlow, "no-result"),
          settled: yield* driver.poll(EdgeFlow, "settled")
        }
      })))

      expect(result.missing).toMatchObject({
        _tag: "@smthrs/flow/FlowExecutionNotFound",
        code: "execution_not_found",
        executionId: "absent"
      })
      expect(Option.isNone(result.foreign)).toBe(true)
      expect(Option.isNone(result.unfinished)).toBe(true)
      expect(Option.isSome(result.settled)).toBe(true)
    }))

  it.effect("dies when polling hits a store failure that is not a missing row", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const broken = RunStore.makeNoop({
          ...base,
          get: () => Effect.fail(storeError("decode_failed", "get"))
        })
        const driver = yield* makeDriver().pipe(Effect.provideService(RunStore.RunStore, broken))
        return yield* Effect.exit(driver.poll(EdgeFlow, "broken"))
      })))

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    }))

  it.effect("reports Suspended to a caller whose execution parked without a result", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver()
        yield* driver.register(
          EdgeFlow,
          () => Effect.flatMap(FlowRuntime.FlowInstance, Flow.suspend)
        )
        return yield* driver.execute(EdgeFlow, {
          executionId: "parked",
          payload: {},
          discard: false
        })
      })))

      expect(result).toBeInstanceOf(Flow.Suspended)
    }))
})

describe("RunDriver execute preconditions", () => {
  it.effect("joins an existing execution when encoded object keys arrive in a different order", () =>
    Effect.gen(function*() {
      let executions = 0
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver()
        yield* driver.register(
          ObjectPayloadFlow,
          () =>
            Effect.sync(() => {
              executions++
              return "joined"
            })
        )
        const first = yield* driver.execute(ObjectPayloadFlow, {
          executionId: "object-payload",
          payload: { data: { a: 1, b: 2 } },
          discard: false
        })
        const second = yield* driver.execute(ObjectPayloadFlow, {
          executionId: "object-payload",
          payload: { data: { b: 2, a: 1 } },
          discard: false
        })
        return { first, second }
      })))

      expect(result.first).toEqual(result.second)
      expect(executions).toBe(1)
    }))

  it.effect("dies when asked to execute an unregistered flow", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver()
        return yield* Effect.exit(driver.execute(UnregisteredFlow, {
          executionId: "unregistered-execute",
          payload: {},
          discard: true
        }))
      })))

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(((Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined) as Error).message)
        .toBe(`Flow ${UnregisteredFlow._tag} is not registered`)
    }))

  it.effect("dies when an execution id already belongs to a different flow", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* store.create("shared-id", stateJson(OtherFlow._tag))
        const driver = yield* makeDriver()
        yield* driver.register(EdgeFlow, () => Effect.succeed("done"))
        return yield* Effect.exit(driver.execute(EdgeFlow, {
          executionId: "shared-id",
          payload: {},
          discard: true
        }))
      })))

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
      expect(defect).toBeInstanceOf(FlowEngine.ExecutionIdentityConflict)
      expect(defect).toMatchObject({
        code: "execution_identity_conflict",
        executionId: "shared-id",
        field: "flow",
        expected: OtherFlow._tag,
        actual: EdgeFlow._tag
      })
    }))

  it.effect("tags an encoded-payload conflict", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        yield* store.create(
          "payload-conflict",
          stateJson(ObjectPayloadFlow._tag, { data: { value: "first" } })
        )
        const driver = yield* makeDriver()
        yield* driver.register(ObjectPayloadFlow, () => Effect.succeed("done"))
        return yield* Effect.exit(driver.execute(ObjectPayloadFlow, {
          executionId: "payload-conflict",
          payload: { data: { value: "second" } },
          discard: true
        }))
      })))

      const defect = Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isDieReason)?.defect : undefined
      expect(defect).toBeInstanceOf(FlowEngine.ExecutionIdentityConflict)
      expect(defect).toMatchObject({
        code: "execution_identity_conflict",
        executionId: "payload-conflict",
        field: "payload",
        expected: "the encoded payload the execution was admitted with",
        actual: "a different encoded payload"
      })
    }))

  it.effect("dies when run creation fails for a reason other than the row already existing", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const broken = RunStore.makeNoop({
          ...base,
          create: () => Effect.fail(storeError("persistence_failed", "create"))
        })
        const driver = yield* makeDriver().pipe(Effect.provideService(RunStore.RunStore, broken))
        yield* driver.register(EdgeFlow, () => Effect.succeed("done"))
        return yield* Effect.exit(driver.execute(EdgeFlow, {
          executionId: "create-broken",
          payload: {},
          discard: true
        }))
      })))

      expect(((Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined) as RunStore.RunStoreError).code)
        .toBe("persistence_failed")
    }))

  it.effect("stays interrupted when run creation is interrupted rather than failing (B4)", () =>
    Effect.gen(function*() {
      // `store.create` runs under `Effect.exit`, so an interrupt-only cause is
      // captured as an Exit carrying no `Fail` reason.
      // `Option.getOrThrow(Exit.findErrorOption(created))` threw a raw
      // `NoSuchElementError` on that cause and discarded the original, so a
      // caller that cancelled the fiber mid-write saw a crash instead of the
      // cancellation it asked for (issue #151).
      const exit = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const interrupting = RunStore.makeNoop({
          ...base,
          create: () => Effect.interrupt
        })
        const driver = yield* makeDriver().pipe(Effect.provideService(RunStore.RunStore, interrupting))
        yield* driver.register(EdgeFlow, () => Effect.succeed("done"))
        return yield* Effect.exit(driver.execute(EdgeFlow, {
          executionId: "create-interrupted",
          payload: {},
          discard: true
        }))
      })))

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false)
    }))
})

/**
 * Every wake the engine itself initiates, reported to the host that guards
 * re-entry into a parked run.
 *
 * The class is closed and this is the enumeration of it: a durable deferred
 * completing, a durable clock firing, and a child settling under a parent
 * that parked on it. An operator's own resume is deliberately outside it —
 * the host has already claimed that one before the engine hears of it — and
 * so is a wake against a run that is not parked, which has a round of its own
 * to carry it.
 */
describe("RunDriver requestResume", () => {
  const recordingDriver = (recorded: Array<readonly [string, RunDriver.RequestedResumeReason]>) =>
    RunDriver.make({
      owner,
      journalSource: "run-driver-edges",
      isAlive: () => Effect.succeed(false),
      engine: Effect.succeed(fakeEngine),
      requestResume: (executionId, reason) => Effect.sync(() => void recorded.push([executionId, reason]))
    })

  const suspend = (runId: string) =>
    Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      yield* store.create(runId, stateJson(EdgeFlow._tag))
      yield* store.claimAndOwn(runId, { status: "pending", owner: null, heartbeatAtMs: null }, owner, 0)
      yield* store.transitionOwned(runId, owner, "suspended", undefined)
    })

  it.effect("reports every scheduled wake for a parked run, and never the operator's own", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const recorded: Array<readonly [string, RunDriver.RequestedResumeReason]> = []
        const driver = yield* recordingDriver(recorded)
        yield* suspend("parked")
        yield* driver.scheduleResume(EdgeFlow._tag, "parked", "deferred")
        yield* driver.scheduleResume(EdgeFlow._tag, "parked", "clock")
        yield* driver.scheduleResume(EdgeFlow._tag, "parked", "parent")
        yield* driver.scheduleResume(EdgeFlow._tag, "parked", "operator")
        return { recorded, decisions: yield* decisionsFor("parked") }
      })))

      expect(result.recorded).toEqual([
        ["parked", "deferred"],
        ["parked", "clock"],
        ["parked", "parent"]
      ])
      // The operator's wake still happened; it is the RECORD that is refused,
      // because `Control.resume` claims the control row itself and a second
      // request would buy the park a second re-drive.
      expect(result.decisions).toEqual(["wake-scheduled", "wake-scheduled", "wake-scheduled", "wake-scheduled"])
    }))

  it.effect("reports nothing for a wake against a run that is not parked", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const recorded: Array<readonly [string, RunDriver.RequestedResumeReason]> = []
        const driver = yield* recordingDriver(recorded)
        yield* store.create("pending", stateJson(EdgeFlow._tag))
        yield* driver.scheduleResume(EdgeFlow._tag, "pending", "clock")
        return { recorded, decisions: yield* decisionsFor("pending") }
      })))

      expect(result.recorded).toEqual([])
      expect(result.decisions).toEqual(["wake-scheduled"])
    }))

  it.effect("reports the parent a settling child wakes, when that parent is parked", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const engineState = yield* DurableEngineState.DurableEngineState
        const recorded: Array<readonly [string, RunDriver.RequestedResumeReason]> = []
        const driver = yield* recordingDriver(recorded)
        yield* driver.register(EdgeFlow, () => Effect.succeed("done"))
        yield* suspend("waiting-parent")
        yield* engineState.park("waiting-parent", { reason: "event" }, owner)
        yield* driver.execute(EdgeFlow, {
          executionId: "settling-child",
          payload: {},
          discard: true,
          parent: FlowEngine.makeInstance(EdgeFlow, "waiting-parent")
        })
        return recorded
      })))

      // A child settlement never passes through `scheduleResume`: the driver
      // wakes the parent's coordinator directly, and this is the only place
      // that wake is announced.
      expect(result).toEqual([["waiting-parent", "parent"]])
    }))

  it.effect("reports nothing for a parent that is still inside its own round", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const recorded: Array<readonly [string, RunDriver.RequestedResumeReason]> = []
        const driver = yield* recordingDriver(recorded)
        yield* driver.register(EdgeFlow, () => Effect.succeed("done"))
        yield* store.create("running-parent", stateJson(EdgeFlow._tag))
        yield* driver.execute(EdgeFlow, {
          executionId: "running-child",
          payload: {},
          discard: true,
          parent: FlowEngine.makeInstance(EdgeFlow, "running-parent")
        })
        return recorded
      })))

      expect(result).toEqual([])
    }))
})

describe("RunDriver scheduleResume", () => {
  it.effect("ignores a wake for a missing row and for a flow-name mismatch", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* store.create("mismatched", stateJson(OtherFlow._tag))
        yield* driver.scheduleResume(EdgeFlow._tag, "absent", "deferred")
        yield* driver.scheduleResume(EdgeFlow._tag, "mismatched", "clock")
        return {
          absent: yield* decisionsFor("absent"),
          mismatched: yield* decisionsFor("mismatched")
        }
      })))

      expect(result.absent).toEqual([])
      expect(result.mismatched).toEqual([])
    }))

  it.effect("records the wake reason for a matching row", () =>
    Effect.gen(function*() {
      const decisions = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* store.create("wakeable", stateJson(EdgeFlow._tag))
        yield* driver.scheduleResume(EdgeFlow._tag, "wakeable", "parent")
        return yield* decisionsFor("wakeable")
      })))

      expect(decisions).toEqual(["wake-scheduled"])
    }))

  /**
   * B-03: the decision was emitted before anything checked the row. A timer
   * armed before its run was cancelled still fires, and an external trigger
   * can complete a deferred long after the run it belongs to settled; both
   * reach `scheduleResume`. The terminal reject lived one layer down in
   * `claimAndActivate`, so every one of those wrote a `wake-scheduled`
   * decision into the journal of a run that can never wake again.
   */
  it.effect("ignores a wake for a run that has already settled", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* store.create("settled", stateJson(EdgeFlow._tag))
        yield* store.claimAndOwn("settled", { status: "pending", owner: null, heartbeatAtMs: null }, owner, 0)
        yield* store.transitionOwned("settled", owner, "completed", undefined)
        yield* driver.scheduleResume(EdgeFlow._tag, "settled", "deferred")
        yield* driver.scheduleResume(EdgeFlow._tag, "settled", "clock")
        return { decisions: yield* decisionsFor("settled"), active: yield* driver.active }
      })))

      expect(result.decisions).toEqual([])
      // Nothing was enqueued either: a settled run is not woken and then
      // refused, it is not woken.
      expect([...result.active]).toEqual([])
    }))

  it.effect("dies when the wake lookup hits a store failure that is not a missing row", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const broken = RunStore.makeNoop({
          ...base,
          get: () => Effect.fail(storeError("persistence_failed", "get"))
        })
        const driver = yield* makeDriver().pipe(Effect.provideService(RunStore.RunStore, broken))
        return yield* Effect.exit(driver.scheduleResume(EdgeFlow._tag, "broken", "operator"))
      })))

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    }))
})

describe("RunDriver interruption settlement", () => {
  it.effect("leaves a running run unchanged when its durable cancel request fails", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        let started = false
        const brokenAfterStart = RunStore.makeNoop({
          ...base,
          // Once the flow is running, every `get` fails: neither the cancel
          // poll nor the interruption settlement may treat that as evidence of
          // a cancellation request.
          get: (runId) => started ? Effect.fail(storeError("persistence_failed", "get")) : base.get(runId),
          // The durable cancel request cannot be recorded either, so no
          // evidence of operator intent survives the interruption.
          requestCancel: () => Effect.fail(storeError("persistence_failed", "requestCancel"))
        })
        const driver = yield* makeDriver().pipe(
          Effect.provideService(RunStore.RunStore, brokenAfterStart)
        )
        const running = yield* Deferred.make<void>()
        yield* driver.register(
          EdgeFlow,
          () =>
            Effect.sync(() => {
              started = true
            }).pipe(
              Effect.andThen(Deferred.succeed(running, undefined)),
              Effect.andThen(Effect.never)
            )
        )
        const fiber = yield* driver.execute(EdgeFlow, {
          executionId: "interrupted-release",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(running)
        const reported = yield* Effect.exit(driver.interrupt(EdgeFlow, "interrupted-release"))
        started = false
        const row = yield* base.get("interrupted-release")
        const decisions = yield* decisionsFor("interrupted-release")
        // Test cleanup is a shutdown interruption, which remains reclaimable.
        yield* Fiber.interrupt(fiber)
        return {
          reported,
          row,
          decisions
        }
      })))

      // The caller is told the cancellation was never recorded instead of being
      // handed a false success (the request used to be `Effect.ignore`d).
      expect(Exit.isFailure(result.reported)).toBe(true)
      const failure = Cause.squash((result.reported as Exit.Failure<void, never>).cause)
      expect(failure).toBeInstanceOf(FlowRuntime.CancelRequestFailed)
      expect((failure as FlowRuntime.CancelRequestFailed).code).toBe("cancel_request_failed")
      expect((failure as FlowRuntime.CancelRequestFailed).executionId).toBe("interrupted-release")
      // The public call failed, so it did not interrupt the drive fiber or make
      // any durable lifecycle transition. The caller can retry against the same
      // owned run instead of observing a false-success side effect.
      expect(result.row.status).toBe("running")
      expect(result.row.owner).not.toBeNull()
      expect(result.row.cancelRequestedAtMs).toBeNull()
      expect(result.decisions).not.toContain("interrupt-released")
      expect(result.decisions).not.toContain("transitioned")
    }))
})

describe("JournalRecords.entries", () => {
  it.effect("pages engine records from the beginning and after a sequence number", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver()
        const store = yield* RunStore.RunStore
        yield* store.create("paged", stateJson(EdgeFlow._tag))
        yield* driver.scheduleResume(EdgeFlow._tag, "paged", "deferred")
        yield* driver.scheduleResume(EdgeFlow._tag, "paged", "clock")
        const journal = yield* Journal.Journal
        yield* journal.flush
        const all = yield* JournalRecords.entries("paged", undefined, 100)
        const after = yield* JournalRecords.entries("paged", all.entries[0]!.seq, 100)
        const limited = yield* JournalRecords.entries("paged", undefined, 1)
        return { all: all.entries, after: after.entries, limited: limited.entries }
      })))

      expect(result.all.length).toBeGreaterThanOrEqual(2)
      expect(result.after.map((entry) => entry.seq)).toEqual(
        result.all.slice(1).map((entry) => entry.seq)
      )
      expect(result.limited).toHaveLength(1)
    }))
})

describe("RunDriver stale-owner recovery", () => {
  // Real elapsed time: `it.effect`'s TestClock would stall this.
  it.live("labels a same-host steal as a dead pid and runs the flow itself", () =>
    Effect.gen(function*() {
      const evidence: Array<unknown> = []
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const recording = RunStore.makeNoop({
          ...base,
          steal: (runId, expected, claimant, nowMs, stealEvidence) =>
            Effect.sync(() => {
              evidence.push(stealEvidence)
            }).pipe(Effect.andThen(base.steal(runId, expected, claimant, nowMs, stealEvidence)))
        })
        // A previous process on this host owned the row and died. Seed its
        // ownership under a clock at zero so the live driver sees a stale
        // heartbeat.
        const deadSameHost: Ownership.OwnerId = { hostId: owner.hostId, pid: owner.pid + 1, nonce: "dead" }
        const owned = yield* Effect.gen(function*() {
          yield* base.create("same-host", stateJson(EdgeFlow._tag))
          const created = yield* base.get("same-host")
          const expected = { status: created.status, owner: created.owner, heartbeatAtMs: created.heartbeatAtMs }
          return yield* base.claimAndOwn("same-host", expected, deadSameHost, 0)
        }).pipe(Effect.provide(TestClock.layer()))
        if (owned._tag !== "Activated") return yield* Effect.die(new Error("claim lost"))

        const driver = yield* makeDriver().pipe(Effect.provideService(RunStore.RunStore, recording))
        yield* driver.register(EdgeFlow, () => Effect.succeed("recovered"))
        yield* driver.resume(EdgeFlow, "same-host")
        return {
          row: yield* base.get("same-host"),
          decisions: yield* decisionsFor("same-host")
        }
      })))

      expect(evidence).toEqual([
        expect.objectContaining({ kind: "same-host-pid-dead" })
      ])
      expect(result.row.status).toBe("completed")
      expect(result.decisions).toContain("stolen-and-activated")
    }))

  it.effect("dies when the drive-time row read fails for a reason other than a missing row", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        yield* base.create("drive-broken", stateJson(EdgeFlow._tag))
        let reads = 0
        const brokenOnDrive = RunStore.makeNoop({
          ...base,
          // The wake-time lookup succeeds; the drive-time lookup does not.
          get: (runId) => ++reads > 1 ? Effect.fail(storeError("decode_failed", "get")) : base.get(runId)
        })
        const driver = yield* makeDriver().pipe(Effect.provideService(RunStore.RunStore, brokenOnDrive))
        yield* driver.register(EdgeFlow, () => Effect.succeed("never"))
        return yield* Effect.exit(driver.resume(EdgeFlow, "drive-broken"))
      })))

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(((Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined) as RunStore.RunStoreError).code)
        .toBe("decode_failed")
    }))
})

describe("RunDriver parent-chain traversal", () => {
  it.effect("treats a parent whose row is missing as having no ancestors", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver()
        yield* driver.register(EdgeFlow, () => Effect.succeed("child-ran"))
        // The parent execution has no persisted row at all: the walk ends
        // there rather than failing or reporting a cycle.
        yield* driver.execute(EdgeFlow, {
          executionId: "orphan-child",
          payload: {},
          discard: true,
          parent: { executionId: "ghost-parent" } as FlowRuntime.FlowInstance["Service"]
        })
        return yield* (yield* RunStore.RunStore).get("orphan-child")
      })))

      expect(result.status).toBe("completed")
    }))

  it.effect("dies when the parent-chain read fails for a reason other than a missing row", () =>
    Effect.gen(function*() {
      const exit = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const broken = RunStore.makeNoop({
          ...base,
          get: () => Effect.fail(storeError("persistence_failed", "get"))
        })
        const driver = yield* makeDriver().pipe(Effect.provideService(RunStore.RunStore, broken))
        yield* driver.register(EdgeFlow, () => Effect.succeed("never"))
        return yield* Effect.exit(driver.execute(EdgeFlow, {
          executionId: "cycle-read-broken",
          payload: {},
          discard: true,
          parent: { executionId: "some-parent" } as FlowRuntime.FlowInstance["Service"]
        }))
      })))

      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
    }))
})

describe("RunDriver registration lifecycle", () => {
  it.effect("removes a flow entirely when overlapping registrations for it are released", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const driver = yield* makeDriver()
        yield* Effect.scoped(Effect.gen(function*() {
          yield* driver.register(EdgeFlow, () => Effect.succeed("old"))
          // A second registration replaces the first in the map; releasing the
          // superseded one must not delete the survivor, and releasing both
          // must leave the flow unregistered.
          yield* driver.register(EdgeFlow, () => Effect.succeed("new"))
        }))
        const afterRelease = yield* Effect.exit(driver.execute(EdgeFlow, {
          executionId: "registration-order",
          payload: {},
          discard: true
        }))
        yield* driver.register(EdgeFlow, () => Effect.succeed("re-registered"))
        const afterReregister = yield* Effect.exit(driver.execute(EdgeFlow, {
          executionId: "registration-order-2",
          payload: {},
          discard: true
        }))
        return { afterRelease, afterReregister }
      })))

      expect(Exit.isFailure(result.afterRelease)).toBe(true)
      expect(((Cause.squash((result.afterRelease as Exit.Failure<never, never>).cause)) as Error).message)
        .toBe(`Flow ${EdgeFlow._tag} is not registered`)
      expect(Exit.isSuccess(result.afterReregister)).toBe(true)
    }))
})

describe("RunDriver cancellation paths", () => {
  it.effect("skips the interruption record when the cancel transition loses its fence", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const fenceLost = RunStore.makeNoop({
          ...base,
          transitionOwned: (runId, claimant, status, state, guard) =>
            status === "cancelled"
              ? base.transitionOwned(runId, { hostId: "other", pid: 1, nonce: "other" }, status, state, guard)
              : base.transitionOwned(runId, claimant, status, state, guard)
        })
        const driver = yield* makeDriver().pipe(Effect.provideService(RunStore.RunStore, fenceLost))
        const running = yield* Deferred.make<void>()
        yield* driver.register(
          EdgeFlow,
          () => Deferred.succeed(running, undefined).pipe(Effect.andThen(Effect.never))
        )
        const fiber = yield* driver.execute(EdgeFlow, {
          executionId: "cancel-fence-lost",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(running)
        yield* driver.interrupt(EdgeFlow, "cancel-fence-lost")
        yield* Fiber.await(fiber)
        const journal = yield* Journal.Journal
        yield* journal.flush
        const page = yield* JournalRecords.entries("cancel-fence-lost", undefined, 100)
        return {
          row: yield* base.get("cancel-fence-lost"),
          types: page.entries.map((entry) => entry.eventType)
        }
      })))

      // The CAS matched no row, so the run was never closed and no
      // interruption record was written for a cancellation that did not happen.
      expect(result.row.status).toBe("running")
      expect(result.types).not.toContain("flows.engine.interrupted")
    }))

  it.effect("records a cancel request for a run that has no live instance", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* store.create("not-running", stateJson(EdgeFlow._tag))
        yield* driver.interrupt(EdgeFlow, "not-running")
        return yield* store.get("not-running")
      })))

      expect(result.cancelRequestedAtMs).not.toBeNull()
      expect(result.status).toBe("pending")
    }))

  it.effect("reports Suspended to the caller when the run settles without a persisted result", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const base = yield* RunStore.RunStore
        const fenceLost = RunStore.makeNoop({
          ...base,
          transitionOwned: (runId, claimant, status, state, guard) =>
            status === "completed"
              ? base.transitionOwned(runId, { hostId: "other", pid: 1, nonce: "other" }, status, state, guard)
              : base.transitionOwned(runId, claimant, status, state, guard)
        })
        const driver = yield* makeDriver().pipe(Effect.provideService(RunStore.RunStore, fenceLost))
        yield* driver.register(EdgeFlow, () => Effect.succeed("done"))
        return yield* driver.execute(EdgeFlow, {
          executionId: "no-result",
          payload: {},
          discard: false
        })
      })))

      expect(result).toBeInstanceOf(Flow.Suspended)
    }))

  /**
   * X-11: the durable engine has ONE cancellation path.
   *
   * `interruptUnsafe` promises forced cancellation without cleanup, and the
   * durable driver answered it with `interrupt` — a cooperative, durable,
   * cascading cancellation that runs every finalizer. A caller reaching for
   * the unsafe path to tear a wedged run down got the safe one and no
   * indication that its request had been reinterpreted. rc.0 refuses it
   * instead, so the feature cannot appear to half-work.
   *
   * The code AND the reason are contract text: the release policy "Durable
   * interruptUnsafe" is the release note an operator reads, and the failure a
   * caller catches has to say the same thing in the same words. Asserted
   * exactly, not by substring, so a reworded refusal is a test failure rather
   * than a silent divergence from the published wording.
   */
  it.effect("refuses interruptUnsafe with a typed unsupported failure", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* store.create("unsafe-interrupt", stateJson(EdgeFlow._tag))
        const failure = yield* Effect.flip(driver.interruptUnsafe(EdgeFlow, "unsafe-interrupt"))
        return { failure, row: yield* store.get("unsafe-interrupt") }
      })))

      expect(result.failure).toBeInstanceOf(FlowRuntime.CancelRequestFailed)
      expect(result.failure.code).toBe("unsafe_interrupt_unsupported")
      expect(result.failure.executionId).toBe("unsafe-interrupt")
      expect(result.failure.reason).toBe(
        "The durable engine has one cancellation path, interrupt, which is durable and cascades to " +
          "linked children. FlowRuntime.interruptUnsafe on the durable engine fails with " +
          "unsafe_interrupt_unsupported instead of forcing cancellation without cleanup."
      )
      // The refusal changes nothing: no cancellation was requested, so the
      // caller can still ask for the supported one.
      expect(result.row.cancelRequestedAtMs).toBeNull()
      expect(result.row.status).toBe("pending")
    }))

  /**
   * B-03, the other half: the sweep queries stop OFFERING a settled run's
   * timers, and the terminal transition stops leaving them pending in the
   * first place. Both matter — the in-memory state without a `runs` view
   * cannot join anything, and a clock row that stays pending forever is
   * durable work no sweep will ever finish.
   */
  const scheduleClockFor = (state: DurableEngineState.Service, executionId: string) =>
    state.scheduleClock({
      flowName: EdgeFlow._tag,
      executionId,
      clockName: "edge-clock",
      deferredName: "edge-deferred",
      dueAtMs: 600_000,
      completedAtMs: null
    }, owner)

  const clockOf = (state: DurableEngineState.Service, executionId: string) =>
    state.clock({ flowName: EdgeFlow._tag, executionId, clockName: "edge-clock" })

  it.effect("completes the run's pending clock rows when it finishes", () =>
    Effect.gen(function*() {
      const row = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        const driver = yield* makeDriver()
        yield* store.create("clocked-complete", stateJson(EdgeFlow._tag), {
          lineageId: "clocked-complete",
          roundOrdinal: 0
        })
        yield* scheduleClockFor(state, "clocked-complete")
        yield* driver.register(EdgeFlow, () => Effect.succeed("done"))
        yield* driver.execute(EdgeFlow, { executionId: "clocked-complete", payload: {}, discard: true })
        return yield* clockOf(state, "clocked-complete")
      })))

      expect(Option.isSome(row)).toBe(true)
      expect(Option.isSome(row) ? row.value.completedAtMs : undefined).not.toBeNull()
    }))

  it.effect("completes the run's pending clock rows when it is cancelled", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournal(Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const state = yield* DurableEngineState.DurableEngineState
        const driver = yield* makeDriver()
        const running = yield* Deferred.make<void>()
        yield* driver.register(
          EdgeFlow,
          () => Deferred.succeed(running, undefined).pipe(Effect.andThen(Effect.never))
        )
        const fiber = yield* driver.execute(EdgeFlow, {
          executionId: "clocked-cancel",
          payload: {},
          discard: true
        }).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Deferred.await(running)
        yield* scheduleClockFor(state, "clocked-cancel")
        yield* driver.interrupt(EdgeFlow, "clocked-cancel")
        yield* Fiber.await(fiber)
        return {
          row: yield* store.get("clocked-cancel"),
          clock: yield* clockOf(state, "clocked-cancel")
        }
      })))

      expect(result.row.status).toBe("cancelled")
      expect(Option.isSome(result.clock) ? result.clock.value.completedAtMs : undefined).not.toBeNull()
    }))
})

const provideJournalWithTestClock = <A, E, R>(
  effect: Effect.Effect<A, E, R | Journal.Journal | RunStore.RunStore>
) =>
  effect.pipe(
    Effect.provide(TestStores.layer()),
    Effect.provide(DurableEngineState.layerMemory),
    Effect.provide(TestClock.layer()),
    Effect.scoped
  ) as Effect.Effect<
    A,
    E,
    Exclude<
      R,
      DurableWriter | Journal.Journal | RunStore.RunStore | DurableEngineState.DurableEngineState | Scope.Scope
    >
  >

describe("RunDriver parked-cancel sweep", () => {
  it.effect("ignores parked entries whose run row can no longer be read", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournalWithTestClock(Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        yield* driver.register(EdgeFlow, () => Effect.succeed("never"))
        // A waiting row that outlived its run row — the sweeper must survive
        // the failed lookup and keep sweeping.
        yield* state.park("vanished", { reason: "event" }, owner)
        yield* store.create("still-there", stateJson(EdgeFlow._tag))
        yield* state.park("still-there", { reason: "event" }, owner)

        yield* TestClock.adjust(Ownership.heartbeatInterval)
        yield* Effect.yieldNow
        return {
          parked: yield* state.waitingRuns(),
          row: yield* store.get("still-there")
        }
      })))

      // Neither entry was cancel-requested, so the sweep left both parked and
      // never woke the surviving run.
      expect(result.parked.map((row) => row.runId).sort()).toEqual(["still-there", "vanished"])
      expect(result.row.status).toBe("pending")
    }))

  it.effect("wakes a parked run whose cancellation was requested by another process", () =>
    Effect.gen(function*() {
      const result = yield* withCrypto(provideJournalWithTestClock(Effect.gen(function*() {
        const state = yield* DurableEngineState.DurableEngineState
        const store = yield* RunStore.RunStore
        const driver = yield* makeDriver()
        let executions = 0
        yield* driver.register(
          EdgeFlow,
          () =>
            Effect.sync(() => {
              executions++
              return "never"
            })
        )
        yield* store.create("parked-cancel", stateJson(EdgeFlow._tag))
        const created = yield* store.get("parked-cancel")
        const expected = { status: created.status, owner: created.owner, heartbeatAtMs: created.heartbeatAtMs }
        const claim = yield* store.claim("parked-cancel", expected, owner, 0)
        if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
        yield* store.activate("parked-cancel", owner, claim.claimedAtMs, expected)
        yield* state.park("parked-cancel", { reason: "event" }, owner)
        yield* store.transitionOwned("parked-cancel", owner, "suspended", stateJson(EdgeFlow._tag))
        yield* store.requestCancel("parked-cancel", 1)

        let row = yield* store.get("parked-cancel")
        for (let index = 0; index < 2000 && row.status !== "cancelled"; index++) {
          yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 2)))
          yield* TestClock.adjust(Ownership.heartbeatInterval)
          yield* Effect.yieldNow
          row = yield* store.get("parked-cancel")
        }
        return { row, executions, parked: yield* state.waitingRuns() }
      })))

      expect(result.row.status).toBe("cancelled")
      // The re-activation cancel guard closed the run without re-running it.
      expect(result.executions).toBe(0)
      expect(result.parked).toEqual([])
    }))
})

/**
 * The old three cleanup cases now pin transaction rollback, preservation of
 * a replacement's committed marker, and refusal of an obsolete owner's park.
 * Every store outcome below comes from the production SQLite adapters. Memory
 * state reads its owner view from those same rows before attempting a park.
 */
describe("RunDriver atomic waiting markers", () => {
  it.effect("takes the memory-state transaction before a cancellation's writer transaction", () =>
    withCrypto(provideJournal(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const state = yield* DurableEngineState.DurableEngineState
      const writer = yield* DurableWriter
      let depth = 0
      const cancellationDepths: Array<number> = []
      const wrapped: DurableEngineState.Service = {
        ...state,
        transaction: (effect, options) =>
          state.transaction(
            Effect.sync(() => depth++).pipe(
              Effect.andThen(effect),
              Effect.ensuring(Effect.sync(() => depth--))
            ),
            options
          )
      }
      const observed: DurableWriter["Service"] = {
        write: (effect) =>
          Effect.suspend(() => {
            cancellationDepths.push(depth)
            return writer.write(effect)
          })
      }
      const driver = yield* makeDriver().pipe(
        Effect.provideService(DurableEngineState.DurableEngineState, wrapped),
        Effect.provideService(DurableWriter, observed)
      )
      yield* store.create("cancel-lock-order", stateJson(EdgeFlow._tag))
      yield* driver.interrupt(EdgeFlow, "cancel-lock-order")
      expect(cancellationDepths).toEqual([1])
      expect((yield* store.get("cancel-lock-order")).cancelRequestedAtMs).not.toBeNull()
    }))))

  const replacementOwner: Ownership.OwnerId = { hostId: "replacement", pid: 8, nonce: "replacement" }
  const executionId = "release-marker"
  const released = { reason: "released" } as const
  const identical = { reason: "approval", token: "same-token", wakeAt: 42_000 } as const

  for (const implementation of ["sql", "memory"] as const) {
    const scenario = (options: {
      readonly replacement?: DurableEngineState.Waiting
      readonly ownWaiting?: DurableEngineState.Waiting | undefined
      readonly mode?: "release" | "suspend" | "quarantine"
      readonly refuseTransition?: boolean
      readonly recover?: boolean
    }) =>
      withCrypto(
        Effect.gen(function*() {
          const store = yield* RunStore.RunStore
          const journal = yield* Journal.Journal
          const sql = yield* SqlClient.SqlClient
          const sqlState = yield* DurableEngineState.DurableEngineState
          const views = new Map<string, DurableEngineState.MemoryRunView>()
          const base = implementation === "sql" ? sqlState : DurableEngineState.makeMemory({
            runs: (runId) => Option.fromNullishOr(views.get(runId)),
            listRuns: () => views.entries()
          })
          const state: DurableEngineState.Service = {
            ...base,
            park: (runId, waiting, claimant) =>
              store.get(runId).pipe(
                Effect.tap((row) => Effect.sync(() => views.set(runId, row))),
                Effect.andThen(base.park(runId, waiting, claimant)),
                Effect.orDie
              )
          }
          const snapshot = Effect.gen(function*() {
            const rows = yield* sql`SELECT * FROM flows_runs WHERE run_id = ${executionId}`
            return JSON.stringify({ row: rows[0], waiting: yield* state.waiting(executionId) })
          })
          const takeover = Effect.gen(function*() {
            const row = yield* store.get(executionId)
            const expected = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
            expect(row.owner).toEqual(owner)
            const nowMs = row.heartbeatAtMs! + 31_000
            const clock = yield* Clock.Clock
            const claim = yield* store.steal(executionId, expected, replacementOwner, nowMs, {
              expectedOwner: owner,
              checkedAtMs: nowMs,
              kind: "lease-expired"
            }).pipe(Effect.provideService(Clock.Clock, {
              ...clock,
              currentTimeMillis: Effect.succeed(nowMs),
              currentTimeMillisUnsafe: () => nowMs,
              currentTimeNanos: Effect.succeed(BigInt(nowMs) * 1_000_000n),
              currentTimeNanosUnsafe: () => BigInt(nowMs) * 1_000_000n
            }))
            expect(claim._tag).toBe("Claimed")
            if (claim._tag !== "Claimed") return yield* Effect.die("replacement claim lost")
            expect(yield* store.activate(executionId, replacementOwner, claim.claimedAtMs, expected))
              .toEqual({ _tag: "Activated" })
            yield* state.transaction(journal.transact(Effect.gen(function*() {
              expect((yield* state.park(executionId, options.replacement!, replacementOwner))._tag).toBe("Parked")
              expect(yield* store.transitionOwned(executionId, replacementOwner, "suspended", row.stateJson))
                .toEqual({ _tag: "Transitioned" })
            })))
          })
          const atBoundary = yield* Deferred.make<void>()
          const continueSettlement = yield* Deferred.make<void>()
          const running = yield* Deferred.make<void>()
          const continueBody = yield* Deferred.make<void>()
          let armed = false
          let resumed = false
          let boundary: "transaction" | "park" | undefined
          let transactionDepth = 0
          const parkDepths: Array<number> = []
          const wakeDepths: Array<number> = []
          const cleanupCalls: Array<string> = []
          const pause = (where: "transaction" | "park") =>
            Effect.gen(function*() {
              if (!armed) return
              armed = false
              boundary = where
              yield* Deferred.succeed(atBoundary, undefined)
              yield* Deferred.await(continueSettlement)
              resumed = true
            })
          const wrappedState: DurableEngineState.Service = {
            ...state,
            transaction: (effect, options) =>
              pause("transaction").pipe(Effect.andThen(state.transaction(
                Effect.sync(() => transactionDepth++).pipe(
                  Effect.andThen(effect),
                  Effect.ensuring(Effect.sync(() => transactionDepth--))
                ),
                options
              ))),
            park: (runId, waiting, claimant) =>
              Effect.gen(function*() {
                parkDepths.push(transactionDepth)
                const parked = yield* state.park(runId, waiting, claimant)
                // On the old implementation this is the first boundary and the
                // park has already committed. The atomic implementation pauses
                // before its transaction, so a replacement commits independently.
                yield* pause("park")
                return parked
              }),
            waiting: (runId) =>
              Effect.suspend(() => {
                if (resumed) cleanupCalls.push("waiting")
                return state.waiting(runId)
              }),
            wake: (runId) =>
              Effect.suspend(() => {
                wakeDepths.push(transactionDepth)
                if (resumed) cleanupCalls.push("wake")
                return state.wake(runId)
              })
          }
          let refused = false
          let suspendedTransitions = 0
          const wrappedStore: RunStore.Service = {
            ...store,
            transitionOwned: (runId, claimant, status, persisted, guard) =>
              Effect.gen(function*() {
                if (status === "suspended") suspendedTransitions++
                if (options.refuseTransition && status === "suspended" && !refused) {
                  refused = true
                  // Real fence loss inside the transaction, after its park. This
                  // speculative release and marker must both roll back when the
                  // driver's subsequent owner CAS fails, even with memory state.
                  expect(yield* store.transitionOwned(runId, claimant, status, persisted, guard))
                    .toEqual({ _tag: "Transitioned" })
                }
                return yield* store.transitionOwned(runId, claimant, status, persisted, guard)
              })
          }
          const driverScope = yield* Scope.make()
          const driver = yield* makeDriver().pipe(
            Effect.provideService(RunStore.RunStore, wrappedStore),
            Effect.provideService(DurableEngineState.DurableEngineState, wrappedState),
            Scope.provide(driverScope)
          )
          yield* driver.register(EdgeFlow, () =>
            Effect.gen(function*() {
              const instance = yield* FlowRuntime.FlowInstance
              if (options.ownWaiting !== undefined) {
                instance.waiting = options.ownWaiting
                if ((options.mode ?? "release") === "release") instance.suspended = true
              }
              yield* Deferred.succeed(running, undefined)
              yield* Deferred.await(continueBody)
              if (options.mode === "suspend") return yield* Flow.suspend(instance)
              if (options.mode === "quarantine") {
                return yield* Effect.die(
                  new ActionPersistence.AttemptEvidenceQuarantined({
                    code: "attempt_evidence_quarantined",
                    keyDigest: "quarantined-key",
                    attempt: 1,
                    path: "output",
                    recordedDigest: "recorded",
                    measuredDigest: "measured"
                  })
                )
              }
              return yield* Effect.never
            }))
          // resume joins one drive without leaving execute's additional wake.
          yield* store.create(executionId, stateJson(EdgeFlow._tag))
          const driving = yield* driver.resume(EdgeFlow, executionId).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(running)
          armed = options.replacement !== undefined
          const settling = yield* ((options.mode ?? "release") === "release"
            ? Scope.close(driverScope, Exit.void)
            : Deferred.succeed(continueBody, undefined).pipe(Effect.andThen(Fiber.join(driving))))
            .pipe(Effect.forkChild({ startImmediately: true }))
          let before: string | undefined
          if (options.replacement !== undefined) {
            yield* Deferred.await(atBoundary)
            yield* takeover
            before = yield* snapshot
            yield* Deferred.succeed(continueSettlement, undefined)
          }
          yield* Fiber.join(settling)
          yield* Fiber.await(driving)
          const after = yield* snapshot
          if (options.replacement !== undefined) {
            expect(after).toBe(before)
            expect(cleanupCalls).toEqual([])
            expect(suspendedTransitions).toBe(0)
          }
          const row = yield* store.get(executionId)
          const waiting = yield* state.waiting(executionId)
          const swept = yield* state.waitingRuns({ reason: "released" })
          const decisions = yield* decisionsFor(executionId)
          yield* Scope.close(driverScope, Exit.void)
          let recovered: RunStore.RunRow | undefined
          if (options.recover) {
            const recovery = yield* RunDriver.make({
              owner: { ...replacementOwner, nonce: "sweeper" },
              journalSource: "replacement-recovery",
              engine: Effect.succeed(fakeEngine)
            }).pipe(Effect.provideService(DurableEngineState.DurableEngineState, state))
            let executions = 0
            yield* recovery.register(EdgeFlow, () =>
              Effect.sync(() => {
                executions++
                return "recovered"
              }))
            // Subscribe before advancing the injected clock. The completed
            // decision is published after the real sweep's transaction commits.
            const subscription = yield* journal.changes
            yield* TestClock.adjust(Ownership.heartbeatInterval)
            while (true) {
              const change = yield* PubSub.take(subscription)
              if (
                change.runId === executionId && change.eventType === "flows.engine.run-decision" &&
                (change.payload as { status?: string }).status === "completed"
              ) break
            }
            recovered = yield* store.get(executionId)
            expect(executions).toBe(1)
            expect(recovered.status).toBe("completed")
            expect(JSON.parse(recovered.stateJson).result).toMatchObject({ _tag: "Complete" })
            expect(Option.isNone(yield* state.waiting(executionId))).toBe(true)
          }
          return {
            before,
            after,
            row,
            waiting,
            swept,
            decisions,
            cleanupCalls,
            boundary,
            parkDepths,
            wakeDepths,
            recovered
          }
        }).pipe(Effect.provide(TestStores.layerAt(":memory:")), Effect.scoped)
      )

    it.effect(`${implementation}: rolls back its own released marker when the release transition loses the fence`, () =>
      Effect.gen(function*() {
        const result = yield* scenario({ refuseTransition: true })
        expect(Option.isNone(result.waiting)).toBe(true)
        expect(result.row.status).toBe("running")
        expect(result.row.owner).toEqual(owner)
        expect(result.decisions).not.toContain("interrupt-released")
        expect(result.parkDepths).toEqual([1])
      }))

    for (
      const [name, marker, ownWaiting] of [
        ["same reason", { reason: "released", token: "replacement-marker" }, undefined],
        ["identical released payload", released, undefined],
        ["identical token and wakeAt", identical, identical],
        ["different reason", { reason: "event", token: "replacement-marker" }, undefined]
      ] as const
    ) {
      it.effect(`${implementation}: keeps a waiting row a new owner parked in the meantime (${name})`, () =>
        Effect.gen(function*() {
          const result = yield* scenario({ replacement: marker, ownWaiting, recover: marker.reason === "released" })
          expect(result.boundary).toBe("transaction")
          expect(result.after).toBe(result.before)
          expect(result.row.status).toBe("suspended")
          expect(result.waiting).toEqual(Option.some({
            runId: executionId,
            reason: marker.reason,
            token: "token" in marker ? marker.token : null,
            wakeAt: "wakeAt" in marker ? marker.wakeAt : null
          }))
          expect(result.cleanupCalls).toEqual([])
          expect(result.decisions).not.toContain("interrupt-released")
          if (marker.reason === "released") expect(result.swept.map((row) => row.runId)).toContain(executionId)
        }))
    }

    it.effect(`${implementation}: does not touch the waiting row when its own park was refused`, () =>
      Effect.gen(function*() {
        const result = yield* scenario({ replacement: identical })
        expect(result.after).toBe(result.before)
        expect(result.cleanupCalls).toEqual([])
        expect(result.decisions).not.toContain("interrupt-released")
      }))

    for (const mode of ["release", "suspend", "quarantine"] as const) {
      it.effect(`${implementation}: atomically parks and suspends its own ${mode}`, () =>
        Effect.gen(function*() {
          const result = yield* scenario({ mode })
          expect(result.row.status).toBe("suspended")
          expect(result.row.owner).toBeNull()
          expect(Option.isSome(result.waiting) && result.waiting.value.reason)
            .toBe(mode === "release" ? "released" : mode === "suspend" ? "event" : "quarantine")
          expect(result.parkDepths).toEqual([1])
          expect(result.wakeDepths).toEqual([1])
        }))

      if (mode !== "release") {
        it.effect(`${implementation}: ${mode} cannot overwrite a replacement's identical marker`, () =>
          Effect.gen(function*() {
            const marker = mode === "suspend" ? identical : { reason: "quarantine", token: "quarantined-key" }
            const result = yield* scenario({ mode, ownWaiting: marker, replacement: marker })
            expect(result.after).toBe(result.before)
            expect(result.row.status).toBe("suspended")
            expect(result.parkDepths).toEqual([1])
            expect(result.cleanupCalls).toEqual([])
          }))
      }
    }
  }
})
