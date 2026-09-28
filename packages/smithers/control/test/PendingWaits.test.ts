/**
 * Reading one parked execution as a wait a person can end.
 *
 * Two readers produce these rows and they must agree: the control plane's own
 * SQL runtime, when it shares a database with the engine, and the executor's
 * observation port, when it does not — which is what a deployed host runs.
 * This is the one definition both call.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as AgentSession from "@smthrs/agent/AgentSession"
import * as Sha256 from "@smthrs/crypto/Sha256"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, DurableDeferred, Flow, type FlowRuntime, HumanTask, Interpreter } from "@smthrs/flow"
import * as Jj from "@smthrs/jj"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import { Effect, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Control } from "../src/Control.ts"
import * as ControlExecutor from "../src/ControlExecutor.ts"
import * as ControlLive from "../src/ControlLive.ts"
import { ControlRuntime } from "../src/ControlRuntime.ts"
import * as SqlControlRuntime from "../src/SqlControlRuntime.ts"

/** A durable deferred token: base64 of `[flowName, executionId, deferredName]`. */
const token = (deferredName: string): string =>
  globalThis.btoa(JSON.stringify(["coding/PreparePlan", "execution-1", deferredName]))

const base = { runId: "execution-1", reason: ControlExecutor.humanWaitReason, createdAt: 42 }

describe("pendingWaitOf", () => {
  it("names the question and the attempt a HumanTask parked on", () => {
    expect(ControlExecutor.pendingWaitOf({
      ...base,
      flowId: "coding/PreparePlan",
      token: token("WaitFor/coding-clarification#1"),
      request: { kind: "ask", prompt: "Which service?" }
    })).toEqual({
      runId: "execution-1",
      flowId: "coding/PreparePlan",
      reason: "approval",
      token: token("WaitFor/coding-clarification#1"),
      tokenDigest: Sha256.digestSync(token("WaitFor/coding-clarification#1")),
      name: "coding-clarification",
      attempt: 1,
      request: { kind: "ask", prompt: "Which service?" },
      createdAt: 42
    })
  })

  it("names a plain WaitFor gate, which has no attempt", () => {
    const row = ControlExecutor.pendingWaitOf({ ...base, token: token("WaitFor/sign-off") })
    expect(row).toMatchObject({ name: "sign-off" })
    expect(row === undefined ? "unread" : Object.keys(row)).not.toContain("attempt")
    // Nothing was declared about the question, so nothing is claimed about it.
    expect(row === undefined ? "unread" : Object.keys(row)).not.toContain("request")
    expect(row === undefined ? "unread" : Object.keys(row)).not.toContain("flowId")
  })

  it("is not a wait a person can end when it is not an approval park", () => {
    expect(ControlExecutor.pendingWaitOf({ ...base, reason: "timer", token: token("WaitFor/later") }))
      .toBeUndefined()
  })

  it("is not answerable when the park recorded no wait address", () => {
    for (const absent of [null, undefined]) {
      expect(ControlExecutor.pendingWaitOf({ ...base, token: absent })).toBeUndefined()
    }
  })

  it("still travels when the token names nothing this plane can read", () => {
    // The token is the durable address either way, so the wait stays
    // answerable; only the name a person was asked under is missing.
    for (
      const opaque of [
        "not-base64-at-all!!",
        globalThis.btoa("not json"),
        globalThis.btoa(JSON.stringify(["flow", "execution-1", 7])),
        token("DurableQueue/items"),
        token("WaitFor/release#not-a-number"),
        token("WaitFor/release#0")
      ]
    ) {
      const row = ControlExecutor.pendingWaitOf({ ...base, token: opaque })
      expect(row?.token).toBe(opaque)
      expect(row?.reason).toBe("approval")
    }
    // A `#` suffix that is not an attempt leaves the whole point as the name.
    expect(ControlExecutor.pendingWaitOf({ ...base, token: token("WaitFor/release#x") })?.name)
      .toBe("release#x")
    expect(ControlExecutor.pendingWaitOf({ ...base, token: globalThis.btoa("not json") })?.name)
      .toBeUndefined()
  })
})

describe("answerableWait", () => {
  const envelope = { capabilities: [], flows: [], budget: {} }

  it("reads a human wait out of the payload the projection published", () => {
    // The projection publishes the durable wait token as the digest and the
    // wait point's own name as the request id, which is all a decision needs
    // to tell a question from a grant.
    expect(ControlExecutor.answerableWait({
      _tag: "Node",
      runId: "run-1",
      requestId: "coding-clarification#1",
      digest: token("WaitFor/coding-clarification#1"),
      envelope
    })).toEqual({ name: "coding-clarification#1", token: token("WaitFor/coding-clarification#1") })
  })

  it("is not a question when the digest is an ordinary request digest", () => {
    // A capability gate: the run asked the control plane for permission, and a
    // registered approval token decides it.
    for (
      const digest of [
        "9829dcfa757bfd57477cac4b52b51a1377da9d31e1d6adb6de9e76f22784ed8a",
        globalThis.btoa("not json"),
        token("DurableQueue/items")
      ]
    ) {
      expect(ControlExecutor.answerableWait({ _tag: "Node", runId: "run-1", requestId: "gate", digest, envelope }))
        .toBeUndefined()
    }
  })

  it("is not a question when the target is a plan", () => {
    expect(ControlExecutor.answerableWait({
      _tag: "Plan",
      planId: "plan-1",
      digest: token("WaitFor/coding-clarification#1"),
      envelope
    })).toBeUndefined()
  })
})

/**
 * Regression #2753: the engine writes a durable wait token as UTF-8 base64url
 * (`DurableDeferred.TokenParsed.asToken`), and `waitPointOf` read it back with
 * Latin-1 `atob`. A wait named `révision` came back as `rÃ©vision`, and a
 * `审批` or `🚀` token, whose base64url alphabet `atob` refuses, named nothing,
 * so `answerableWait` sent the answer down the grant path.
 */
describe("regression: Control wait metadata and answer classification misdecode Unicode durable tokens", () => {
  const names = ["révision", "审批", "🚀"]
  const canonical = (deferredName: string): string =>
    new DurableDeferred.TokenParsed({ flowName: "unicode/Ask", executionId: "execution-1", deferredName }).asToken

  it("reads the name and attempt out of an engine-encoded token", () => {
    for (const name of names) {
      expect(ControlExecutor.pendingWaitOf({ ...base, token: canonical(`WaitFor/${name}#2`) }))
        .toMatchObject({ name, attempt: 2 })
      expect(ControlExecutor.pendingWaitOf({ ...base, token: canonical(`WaitFor/${name}`) })?.name).toBe(name)
      expect(ControlExecutor.pendingWaitOf({ ...base, token: canonical(`DurableQueue/${name}`) })?.name)
        .toBeUndefined()
    }
  })

  it("classifies an engine-encoded human wait as a question", () => {
    for (const name of names) {
      const digest = canonical(`WaitFor/${name}#1`)
      expect(ControlExecutor.answerableWait({
        _tag: "Node",
        runId: "run-1",
        requestId: `${name}#1`,
        digest,
        envelope: { capabilities: [], flows: [], budget: {} }
      })).toEqual({ name: `${name}#1`, token: digest })
    }
  })

  it.each(names)("names a real HumanTask wait %s and answers it through its projected target", async (name) => {
    const Ask = Flow.make(`unicode/Ask/${name}`, {
      payload: {},
      success: Schema.Json,
      error: HumanTask.HumanTaskFailed,
      body: () => HumanTask.action.call({ name, kind: "ask", prompt: "Which?", maxAttempts: 3 })
    })
    const observed = await runOn(
      humanWaitStack(Interpreter.layer(Ask)),
      Effect.gen(function*() {
        const control = yield* Control
        const runtime = yield* ControlRuntime
        yield* Ask.execute({}, { executionId: "run-u", discard: true })
        const parked = yield* parkedOn("run-u")
        const summary = yield* runtime.getRun("run-u")
        const wait = summary.pendingWaits?.[0]
        // The approvals projection publishes the token as the digest and the
        // wait point as the request id; the gateway classifies exactly this.
        const target = {
          _tag: "Node" as const,
          runId: "run-u",
          requestId: wait?.attempt === undefined ? String(wait?.name) : `${wait.name}#${wait.attempt}`,
          digest: parked.token ?? "",
          envelope: { capabilities: [], flows: [], budget: {} }
        }
        const answerable = ControlExecutor.answerableWait(target)
        const receipt = answerable === undefined ? undefined : yield* control.signal({
          runId: "run-u",
          signal: { name: answerable.name, payload: "yes" },
          idempotencyKey: "signal:run-u"
        })
        return { wait, answerable, receipt, status: yield* settledRun("run-u") }
      })
    )
    expect(observed.wait).toMatchObject({ name, attempt: 1 })
    expect(observed.answerable?.name).toBe(`${name}#1`)
    expect(observed.receipt?._tag).toBe("Accepted")
    expect(observed.status).toBe("completed")
  }, 30_000)
})

const jj = Jj.make({
  snapshot: () => Effect.succeed({ commitId: "pending-waits" as never, changeId: "pending-waits" as never }),
  restore: () => Effect.void,
  diff: () => Effect.succeed(""),
  workspaceAdd: () => Effect.void,
  workspaceForget: () => Effect.void,
  status: () => Effect.succeed("")
})

/** The real durable engine and control plane over one database, as a host runs them. */
const humanWaitStack = (interpreter: Layer.Layer<never, any, any>) => {
  const database = Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer
  ).pipe(
    Layer.provideMerge(Layer.effectDiscard(EngineMigrations.run)),
    Layer.provideMerge(Layer.merge(TestDatabase.layer, NodeCrypto.layer))
  )
  const engine = Layer.mergeAll(HumanTask.layer, interpreter).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(
      EngineStore.layer({
        owner: { hostId: "pending-waits" },
        journalSource: "pending-waits",
        isAlive: () => Effect.succeed(false)
      })
    ),
    Layer.provideMerge(Layer.mergeAll(StepBoundary.layerTest(), Layer.succeed(Jj.Jj, jj), OwnerIdentity.layer))
  )
  const bridge = Layer.effect(ControlExecutor.ControlExecutor)(
    Effect.gen(function*() {
      const services = yield* Effect.context<DurableEngineState.DurableEngineState | FlowRuntime.FlowRuntime>()
      return ControlExecutor.makeNoop({
        deliverSignal: Effect.fn("PendingWaits.deliverSignal")((input) =>
          Effect.provide(AgentSession.deliverSignal(input), services).pipe(Effect.orDie)
        )
      })
    })
  )
  const plane = Layer.provideMerge(
    ControlLive.layer,
    Layer.mergeAll(SqlControlRuntime.layer({}).pipe(Layer.orDie), NotificationQueue.layer, bridge, Registry.layerNoop())
  )
  return Layer.merge(plane, engine).pipe(Layer.provideMerge(database))
}

const runOn = <A, E, R>(stack: Layer.Any, body: Effect.Effect<A, E, R>): Promise<A> =>
  Effect.runPromise(Effect.provide(body, stack as unknown as Layer.Layer<R>).pipe(Effect.scoped, Effect.orDie))

const parkedOn = (
  runId: string,
  attempts = 4_000
): Effect.Effect<DurableEngineState.WaitingRow, unknown, DurableEngineState.DurableEngineState> =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const human = (yield* state.waitingTree(runId)).find((row) => row.reason === "approval")
    if (human !== undefined) return human
    if (attempts <= 0) return yield* Effect.die(`${runId} never parked on a human wait`)
    yield* Effect.yieldNow
    return yield* parkedOn(runId, attempts - 1)
  })

const settledRun = (runId: string, attempts = 4_000): Effect.Effect<string, unknown, RunStore.RunStore> =>
  Effect.gen(function*() {
    const row = yield* (yield* RunStore.RunStore).get(runId)
    if (!["suspended", "running", "pending"].includes(row.status) || attempts <= 0) return row.status
    yield* Effect.yieldNow
    return yield* settledRun(runId, attempts - 1)
  })
