/**
 * N-08: a run parked inside {@link module:DurableDeferred.raceAll} resumes on
 * the durable engine.
 *
 * A race between a durable wait and a durable timer is the shape every
 * deadline in the tree is built from, so a durable engine that parks the race
 * and cannot re-enter it makes `HumanTask.timeoutMs`, `Action.raceAll`, and
 * every wait-versus-timer race unusable. The defect was in the attempt row:
 * a body that parked ended its fiber by self-interruption, and the dispatch
 * recorded that interrupt as a `failed` attempt, which the replay branch then
 * rethrew on every later drive — the run died with "All fibers interrupted
 * without error" instead of resuming. The memory engine writes no attempt row
 * and so never saw it, which is why the cases here run against the real SQLite
 * stores (`TestStores.layerAt`).
 */
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, DurableClock, DurableDeferred, Flow, FlowRuntime, HumanTask, Interpreter } from "@smthrs/flow"
import { Journal } from "@smthrs/journal"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, type Ownership, RunStore } from "@smthrs/run-store"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as EngineStore from "../src/EngineStore.ts"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as EffectRecords from "../src/internal/EffectRecords.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { opaqueHandlerBody } from "./fixtures/OpaqueHandlerBody.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "raced-park-resume" as never, changeId: "raced-park-resume" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

type Services =
  | Layer.Success<ReturnType<typeof TestStores.layerAt>>
  | StepBoundary.Service
  | Jj.Jj
  | Crypto.Crypto

const provide = <A, E>(effect: Effect.Effect<A, E, Services>) =>
  withCrypto(
    effect.pipe(
      Effect.provideService(Jj.Jj, jj),
      Effect.provide(StepBoundary.layerTest()),
      Effect.provide(TestStores.layerAt(":memory:"))
    )
  )

const makeEngine = EngineStore.make({
  owner: { hostId: "raced-park-host" },
  journalSource: "raced-park-test",
  isAlive: () => Effect.succeed(false)
})

/** The run row once the driver has settled it, without waiting the clock out. */
const settles = (runId: string) =>
  Effect.gen(function*() {
    const store = yield* RunStore.RunStore
    for (let turn = 0; turn < 400; turn++) {
      const row = yield* store.get(runId)
      if (row.status === "completed" || row.status === "failed" || row.status === "cancelled") return row
      yield* Effect.sleep("5 millis")
    }
    return yield* Effect.die(new Error(`run ${runId} never settled`))
  })

const RaceFlow = Flow.make("RacedParkResume/Race", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const gate = DurableDeferred.make("raced-park-gate", { success: Schema.String })

const racedHandler = () =>
  DurableDeferred.raceAll({
    name: "raced-park",
    success: Schema.String,
    error: Schema.Never,
    effects: [
      DurableDeferred.await(gate),
      Effect.as(
        DurableClock.sleep({
          name: "raced-park-timeout",
          duration: "5 minutes",
          inMemoryThreshold: Duration.zero
        }),
        "timeout"
      )
    ]
  })

describe("a flow body parked on a raced deferred resumes durably", () => {
  it.effect("re-drives the race and settles on the completion that arrived", () =>
    provide(Effect.gen(function*() {
      const store = yield* RunStore.RunStore
      const parked = yield* Effect.scoped(Effect.gen(function*() {
        const engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
        yield* engine.register(RaceFlow, racedHandler)
        yield* engine.execute(RaceFlow, {
          executionId: "raced-park",
          payload: {},
          discard: true
        })
        return yield* store.get("raced-park")
      }))

      const settled = yield* Effect.scoped(Effect.gen(function*() {
        const engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
        yield* engine.register(RaceFlow, racedHandler)
        yield* engine.deferredDone(gate, {
          flowName: RaceFlow._tag,
          executionId: "raced-park",
          deferredName: gate.name,
          exit: Exit.succeed("answered")
        })
        yield* engine.execute(RaceFlow, {
          executionId: "raced-park",
          payload: {},
          discard: true
        })
        return yield* store.get("raced-park")
      }))

      expect(parked.status).toBe("suspended")
      expect(settled.status).toBe("completed")
    })))
})

const Asked = Flow.make("RacedParkResume/HumanTask", {
  payload: { name: Schema.String, timeoutMs: Schema.Number },
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: ({ name, timeoutMs }) => HumanTask.action.call({ name, kind: "ask", prompt: "Why?", timeoutMs })
})

/**
 * Runs `body` with the question's flow registered on a fresh durable engine.
 *
 * The registration stays live for the WHOLE body: a deadline is delivered by
 * the engine's own timer, which re-drives the run through the driver's
 * registration table, so a case that closed the layer after starting the run
 * would park forever against an unregistered flow.
 */
const asking = <A, E>(
  body: (
    engine: FlowRuntime.FlowRuntime["Service"]
  ) => Effect.Effect<
    A,
    E,
    | Services
    | Layer.Success<typeof HumanTask.layer>
    | Layer.Success<typeof Action.layerImplementations>
    | FlowRuntime.FlowRuntime
    | Scope.Scope
  >
) =>
  provide(Effect.scoped(Effect.gen(function*() {
    const engine = (yield* makeEngine) as FlowRuntime.FlowRuntime["Service"]
    return yield* body(engine).pipe(
      Effect.provide(
        Layer.mergeAll(HumanTask.layer, Interpreter.layer(Asked)).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine as never))
        )
      )
    )
  })))

describe("HumanTask.timeoutMs on the durable engine", () => {
  // The asynchronous resume is observed through settles' bounded sleep/poll
  // loop; a frozen clock with no adjuster stalls at its first poll.
  it.live("parks the raced attempt without settling its row, and settles on the answer", () =>
    asking(() =>
      Effect.gen(function*() {
        const store = yield* RunStore.RunStore
        const attempts = yield* AttemptStore.AttemptStore
        const payload = { name: "release", timeoutMs: 60_000 }

        yield* Effect.orDie(Asked.execute(payload, { executionId: "human-raced", discard: true }))
        const parked = yield* store.get("human-raced")
        // The attempt the question parked in is unsettled, not failed: the next
        // drive re-enters it under the same number rather than burning a retry.
        const parkedAttempts = yield* Effect.forEach(
          [1, 2],
          (attempt) =>
            attempts.get({
              runId: "human-raced",
              stepKeyDigest: sha256(JSON.stringify({ kind: "invocation", action: HumanTask.tag })),
              attempt
            })
        )

        yield* HumanTask.answer({
          token: DurableDeferred.tokenFromExecutionId(HumanTask.deferred("release", 1), {
            flow: Asked,
            executionId: "human-raced"
          }),
          value: "because"
        })
        const settled = yield* settles("human-raced")
        const result = yield* Effect.orDie(Asked.poll("human-raced"))

        expect(parked.status).toBe("suspended")
        expect(
          parkedAttempts.flatMap((row) => Option.isSome(row) ? [row.value.state] : [])
        ).not.toContain("failed")
        expect(settled.status).toBe("completed")
        expect(
          Option.isSome(result) && result.value._tag === "Complete" && Exit.isSuccess(result.value.exit)
            ? result.value.exit.value
            : undefined
        ).toBe("because")
      })
    ))

  // Real elapsed time: the deadline is delivered by the engine's own armed
  // timer, and `it.effect`'s TestClock never advances for it.
  it.live("fails the question with the timeout code when the deadline passes unanswered", () =>
    asking(() =>
      Effect.gen(function*() {
        const payload = { name: "deadline", timeoutMs: 25 }

        yield* Effect.orDie(Asked.execute(payload, { executionId: "human-deadline", discard: true }))
        const settled = yield* settles("human-deadline")
        const result = yield* Effect.orDie(Asked.poll("human-deadline"))

        expect(settled.status).toBe("failed")
        const failure = Option.isSome(result) && result.value._tag === "Complete" &&
            Exit.isFailure(result.value.exit)
          ? result.value.exit.cause.reasons[0]
          : undefined
        expect(failure).toMatchObject({
          error: { _tag: "@smthrs/flow/HumanTaskFailed", code: "timeout", task: "deadline" }
        })
      })
    ))
})

/**
 * A park is not a settlement at the EFFECT BOUNDARY either.
 *
 * The terminal boundary record says an irreversible or compensable effect
 * finished and names what nobody can testify to (`unknown`). A parked dispatch
 * has not finished: the attempt row deliberately stays `running` so the next
 * drive re-enters the same attempt. Writing `unknown` for the park closed a
 * boundary that is still open, and made a routine park-and-resume read
 * `intended, unknown, succeeded` in the journal a rewind classifies the doomed
 * suffix from.
 */
const boundaryStatuses = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const page = yield* journal.entries({ runId: runId as never, limit: 50 })
    return page.entries
      .filter((entry) => entry.eventType === EffectRecords.eventType)
      .map((entry) => (entry.payload as { readonly effect: { readonly status: string } }).effect.status)
  })

const ParkedIrreversible = Flow.make("RacedParkResume/Irreversible", {
  payload: {},
  success: Schema.String,
  body: opaqueHandlerBody
})

const boundaryOwner: Ownership.OwnerId = { hostId: "raced-park-boundary", pid: 1, nonce: "owner" }

/** Dispatches one irreversible action under an owned, active run row. */
const dispatchIrreversible = (runId: string, execute: () => Effect.Effect<unknown, unknown>) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const existing = yield* Effect.option(runs.get(runId))
    if (Option.isNone(existing)) {
      yield* runs.create(runId, "{}")
      const pending = yield* runs.get(runId)
      const snapshot = { status: pending.status, owner: pending.owner, heartbeatAtMs: pending.heartbeatAtMs }
      const claim = yield* runs.claim(runId, snapshot, boundaryOwner, 1)
      if (claim._tag !== "Claimed") return yield* Effect.die(new Error("claim lost"))
      yield* runs.activate(runId, boundaryOwner, claim.claimedAtMs, snapshot)
    }
    return yield* Effect.exit(
      ActionPersistence.make({
        runId,
        owner: boundaryOwner,
        sourceId: "raced-park-boundary",
        execute
      })({ action: { name: "billing/Charge" }, attempt: 1, key: `${runId}-key`, tier: "irreversible" })
    )
  })

describe("an irreversible dispatch that parks", () => {
  it.effect("leaves its effect boundary open, and closes it when the resumed attempt settles", () =>
    provide(Effect.scoped(Effect.gen(function*() {
      const instance = FlowEngine.makeInstance(ParkedIrreversible as never, "boundary-park")
      const parked = yield* dispatchIrreversible("boundary-park", () =>
        Effect.gen(function*() {
          // What `Flow.suspend` does: mark the instance, then end the fiber by
          // self-interruption.
          instance.suspended = true
          return yield* Effect.interrupt
        })).pipe(Effect.provideService(FlowRuntime.FlowInstance, instance))
      const afterPark = yield* boundaryStatuses("boundary-park")

      instance.suspended = false
      const settled = yield* dispatchIrreversible("boundary-park", () => Effect.succeed("receipt")).pipe(
        Effect.provideService(FlowRuntime.FlowInstance, instance)
      )
      const afterResume = yield* boundaryStatuses("boundary-park")

      expect(Exit.isFailure(parked)).toBe(true)
      expect(afterPark).toEqual(["intended"])
      expect(Exit.isSuccess(settled)).toBe(true)
      // One crossing, one intent, one settlement: the re-drive re-emits the
      // same `intended` record under the same attempt id, which the lifecycle
      // emit keeps at one row.
      expect(afterResume).toEqual(["intended", "succeeded"])
    }))))
})
