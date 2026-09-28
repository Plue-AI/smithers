import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * A nested human wait seen from a host that runs TWO databases.
 *
 * `@smthrs/control` `SqlControlRuntime` can compute a run tree's open human
 * waits itself when it shares a database with the engine. A deployed host does
 * not: `@smthrs/cli` `NativeControl` keeps the control plane's coordination
 * rows in `control.db` and every execution a flow spawns in `engine.db`, and
 * the comment on that composition says why — leaking the engine's stores back
 * would silently redirect `ControlLive` to the wrong database.
 *
 * So on the production coding host the rollup found nothing. Workspace
 * 6f2733a3 had `coding/PreparePlan` parked on `coding-clarification` with its
 * `waiting_request` written and `flows_run_parents` linking it up through
 * three ancestors to `run-1`, all in `engine.db`, while
 * `List {status: "waiting-approval"}` answered `[]`, `List {}` answered
 * `run-1` as `parked` on an `event` with no `pendingWaits`, and the approvals
 * projection had no rows.
 *
 * The one reader of both databases is `ControlExecutor.readExecution`, whose
 * answer `ControlLive.observe` writes over the control plane's own copy. This
 * suite is that topology: two databases, the production observation port, and
 * the gateway read path on top.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as AgentSession from "@smthrs/agent/AgentSession"
import { Control } from "@smthrs/control/Control"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as ControlLive from "@smthrs/control/ControlLive"
import { layerNoopAuth } from "@smthrs/control/ControlRpcs"
import type { ControlEvent, PlanCard } from "@smthrs/control/ControlSchema"
import type { DurableFlow } from "@smthrs/control/SqlControlRuntime"
import * as SqlControlRuntime from "@smthrs/control/SqlControlRuntime"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import * as EngineStore from "@smthrs/engine-store/EngineStore"
import * as EngineMigrations from "@smthrs/engine-store/Migrations"
import * as OwnerIdentity from "@smthrs/engine-store/OwnerIdentity"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import { Action, Flow, HumanTask, Interpreter } from "@smthrs/flow"
import * as GatewayProjection from "@smthrs/gateway/GatewayProjection"
import { GatewayRpcs } from "@smthrs/gateway/GatewayRpcs"
import * as GatewayServer from "@smthrs/gateway/GatewayServer"
import * as Projections from "@smthrs/gateway/Projections"
import { ExecutionFact } from "@smthrs/journal"
import * as Journal from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as JournalMigrations from "@smthrs/journal/Migrations"
import * as SqlJournal from "@smthrs/journal/SqlJournal"
import { Jj } from "@smthrs/kernel"
import { NotificationQueue } from "@smthrs/notifications"
import { Registry } from "@smthrs/registry"
import * as AttemptStore from "@smthrs/run-store/AttemptStore"
import * as RunStoreMigrations from "@smthrs/run-store/Migrations"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import { Context, Effect, Layer, Schema, type Scope } from "effect"
import { RpcTest } from "effect/unstable/rpc"
import { describe, expect, it } from "vitest"
import * as EngineJournalProjection from "../src/internal/EngineJournalProjection.ts"

const prompt = "Which service owns the retry budget?"
const flowId = "coding/Request"

/** The execution that asks the person, three `.child()` boundaries down. */
const PreparePlan = Flow.make("coding/PreparePlan", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => HumanTask.action.call({ name: "coding-clarification", kind: "ask", prompt, maxAttempts: 3 })
})

const PrepareWithWiki = Flow.make("coding/PrepareWithWiki", {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => PreparePlan.child({})
})

const Request = Flow.make(flowId, {
  payload: {},
  success: Schema.Json,
  error: HumanTask.HumanTaskFailed,
  body: () => PrepareWithWiki.child({})
})

/** The one flow the control plane may plan, declared the way a host declares it. */
const durableFlow: DurableFlow = {
  flowId,
  description: "The nested human wait suite's flow",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} }
}

const stubJj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "nested-wait-suite" as never, changeId: "nested-wait-suite" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

/**
 * The ENGINE's database. Its own `TestDatabase`, which is the point: the
 * control plane below builds its own, exactly as a host does.
 *
 * `Layer.fresh` wraps the whole storage graph for the reason `NativeControl`
 * gives: every store layer here is a singleton, and one shared memo map would
 * otherwise hand the engine the control plane's instances over the other
 * database — which is one database again, and not the topology under test.
 */
const engineDatabase = Layer.fresh(
  Layer.mergeAll(
    SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
    RunStore.layer,
    AttemptStore.layer,
    CacheStore.layer,
    DurableEngineState.layer
  ).pipe(
    Layer.provideMerge(Layer.effectDiscard(EngineMigrations.run)),
    Layer.provideMerge(Layer.merge(TestDatabase.layer, NodeCrypto.layer))
  )
)

/**
 * The engine, reachable from the control plane's side and nothing else.
 *
 * Only these four closures cross back, as only the executor crosses back in a
 * host composition. The engine's `RunStore` and `DurableEngineState` stay
 * inside: a control plane that could see them would not be the topology under
 * test.
 */
class Engine extends Context.Service<Engine, {
  readonly copyTo: (runId: string, journal: Journal.Service) => Effect.Effect<void>
  readonly start: (runId: string) => Effect.Effect<void>
  readonly observe: (runId: string) => Effect.Effect<ControlExecutor.ExecutionObservation>
  readonly deliverSignal: (input: ControlExecutor.Signal) => Effect.Effect<ControlExecutor.SignalDelivery>
  /** Polls until an execution BELOW `runId` is parked on a human wait. */
  readonly parkedBelow: (runId: string) => Effect.Effect<DurableEngineState.WaitingRow>
  /** Polls until the execution reaches a terminal status, and reports it. */
  readonly settled: (runId: string) => Effect.Effect<string>
}>()("smithers/test/NestedEngine") {}

const engineLayer = Layer.effect(Engine)(
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const engineJournal = yield* Journal.Journal
    const runs = yield* RunStore.RunStore
    const services = yield* Effect.context<Effect.Services<ReturnType<typeof Request.execute>>>()
    const settled = (runId: string, attempts = 4_000): Effect.Effect<string> =>
      Effect.gen(function*() {
        const row = yield* Effect.orDie(runs.get(runId))
        if (!["suspended", "running", "pending"].includes(row.status) || attempts <= 0) return row.status
        yield* Effect.yieldNow
        return yield* settled(runId, attempts - 1)
      })
    const parkedBelow = (
      runId: string,
      attempts = 4_000
    ): Effect.Effect<DurableEngineState.WaitingRow> =>
      Effect.gen(function*() {
        const open = yield* state.waitingTree(runId)
        const human = open.find((row) => row.reason === "approval" && row.runId !== runId)
        if (human !== undefined) return human
        if (attempts <= 0) return yield* Effect.die(`no execution below ${runId} parked on a human wait`)
        yield* Effect.yieldNow
        return yield* parkedBelow(runId, attempts - 1)
      })
    return {
      copyTo: (runId: string, controlJournal: Journal.Service) =>
        Effect.gen(function*() {
          const bridge = yield* EngineJournalProjection.make({
            executionId: runId,
            controlRunId: runId,
            engineJournal,
            controlJournal,
            engineState: state,
            runLineage: runs.lineage
          })
          yield* bridge.catchUp.pipe(Effect.orDie)
        }),
      start: (runId: string) =>
        Effect.provideContext(
          Effect.asVoid(Request.execute({}, { executionId: runId, discard: true })),
          services
        ).pipe(Effect.orDie),
      observe: (runId: string) =>
        Effect.orDie(
          AgentSession.readExecution(runId).pipe(
            Effect.provideService(RunStore.RunStore, runs),
            Effect.provideService(DurableEngineState.DurableEngineState, state)
          )
        ),
      deliverSignal: (input: ControlExecutor.Signal) =>
        // Signal delivery reads the engine's `DurableEngineState` and `FlowRuntime`.
        AgentSession.deliverSignal(input).pipe(
          Effect.provideService(DurableEngineState.DurableEngineState, state),
          Effect.provideContext(services),
          Effect.orDie
        ),
      parkedBelow,
      settled
    }
  })
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      HumanTask.layer,
      Interpreter.layer(Request),
      Interpreter.layer(PrepareWithWiki),
      Interpreter.layer(PreparePlan)
    )
      .pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(
          EngineStore.layer({
            owner: { hostId: "nested-wait-suite" },
            journalSource: "nested-wait-suite",
            isAlive: () => Effect.succeed(false)
          })
        ),
        Layer.provideMerge(Layer.mergeAll(StepBoundary.layerTest(), stubJj, OwnerIdentity.layer)),
        Layer.provideMerge(engineDatabase)
      )
  )
)

/** The CONTROL plane's database: its own file, its own migrations. */
const controlDatabase = Layer.mergeAll(
  SqlJournal.layer({ capacity: 1024, overflow: "reject" }),
  RunStore.layer
).pipe(
  Layer.provideMerge(DatabaseMigrations.layer([JournalMigrations.set, RunStoreMigrations.set])),
  Layer.provideMerge(Layer.merge(TestDatabase.layer, NodeCrypto.layer))
)

/** The acceptance and observation ports, both answered by the engine. */
const executor = Layer.effect(ControlExecutor.ControlExecutor)(
  Effect.gen(function*() {
    const engine = yield* Engine
    const scope = yield* Effect.scope
    return ControlExecutor.makeNoop({
      readExecution: (runId) => engine.observe(runId),
      deliverSignal: (input) => engine.deliverSignal(input),
      // Started and not awaited, as a host starts an accepted launch: the
      // run parks, and acceptance is not its settlement.
      launch: (input) => Effect.as(Effect.forkIn(engine.start(input.run.runId), scope), "accepted" as const)
    })
  })
)

/**
 * The mount a card submits through, over the same control plane.
 *
 * `ControlPrincipal` is what the shared auth middleware supplies in a served
 * composition; here the suite names the operator directly, which is what a
 * local decision is journaled as.
 */
const stack = Layer.merge(GatewayServer.layerHandlers, layerNoopAuth({ id: "local", kind: "operator", stampedAt: 0 }))
  .pipe(
    Layer.provideMerge(Projections.layerWith({}))
  ).pipe(
    Layer.provideMerge(ControlLive.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        SqlControlRuntime.layer({ flows: [durableFlow] }).pipe(Layer.orDie),
        NotificationQueue.layer,
        Registry.layerNoop(),
        executor
      ).pipe(Layer.provideMerge(controlDatabase))
    ),
    Layer.provideMerge(engineLayer)
  )

const run = <A, E>(body: Effect.Effect<A, E, Layer.Success<typeof stack> | Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.provide(body, stack).pipe(Effect.scoped, Effect.orDie))

const approvalOf = (card: PlanCard) => ({
  target: { _tag: "Plan" as const, planId: card.planId, digest: card.digest, envelope: card.envelope },
  scope: card.approval.scope,
  idempotencyKey: `approve:${card.planId}`
})

/** Plans, approves, and launches the flow, returning once it has parked. */
const parked = Effect.gen(function*() {
  const control = yield* Control
  const engine = yield* Engine
  const card = yield* control.plan({ flowId, input: {} })
  yield* control.approve(approvalOf(card))
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: `run:${card.planId}`
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) return yield* Effect.die("expected a run")
  return { runId: receipt.runId, wait: yield* engine.parkedBelow(receipt.runId) }
})

describe("a host whose control plane and engine keep separate databases", () => {
  it("replays the nested question and status, then removes the answered wait without replaying its authority", async () => {
    await run(Effect.gen(function*() {
      const control = yield* Control
      const engine = yield* Engine
      const journal = yield* Journal.Journal
      const { runId } = yield* parked
      const read = Effect.gen(function*() {
        yield* engine.copyTo(runId, journal)
        const page = yield* journal.entries({ runId: runId as JournalEvent.RunId, limit: 1000 })
        const events: ReadonlyArray<ControlEvent> = page.entries.map((entry) => ({
          runId,
          sequence: entry.seq,
          occurredAt: entry.emittedAtMs,
          kind: entry.eventType,
          payload: entry.payload as ControlEvent["payload"]
        }))
        const listed = yield* control.list({ _tag: "runs", filters: { runId } })
        if (listed._tag !== "runs" || listed.items[0] === undefined) return yield* Effect.die("missing root")
        return { events, summary: listed.items[0] }
      })
      const before = yield* read
      const folded = ExecutionFact.foldControl(before.events, runId, before.summary.executionView)
      expect(folded?.provenance).toMatchObject({ source: "events", humanWaits: "events" })
      expect(folded?.view).toEqual(before.summary.executionView)
      expect(folded?.view?.humanWaits?.[0]?.waiting?.request).toMatchObject({ prompt, kind: "ask" })
      expect(GatewayProjection.runSummary(before.summary, before.events).status).toBe("waiting-approval")
      const approvals = GatewayProjection.approvals(before.events, before.summary)
      expect(approvals[0]).toMatchObject({ title: prompt, questionProvenance: "events", status: "pending" })
      // Historical facts cannot recreate an answerable row after its current
      // opaque wake address has gone. Only the live observation supplies it.
      expect(GatewayProjection.approvals(before.events, { ...before.summary, pendingWaits: undefined })).toEqual([])
      const receipt = yield* control.signal({
        runId,
        signal: { name: approvals[0]!.requestId, payload: "the scheduler owns it" },
        idempotencyKey: `verified-signal:${runId}`
      })
      expect(receipt._tag).toBe("Accepted")
      let after = yield* read
      for (
        let attempt = 0;
        attempt < 4000 &&
        (after.summary.executionView?.humanWaits?.length !== 0 ||
          ExecutionFact.foldControl(after.events, runId, after.summary.executionView)?.provenance.source !== "events");
        attempt++
      ) {
        yield* Effect.yieldNow
        after = yield* read
      }
      const settled = ExecutionFact.foldControl(after.events, runId, after.summary.executionView)
      expect(settled?.provenance).toMatchObject({ source: "events", humanWaits: "events" })
      expect(settled?.view?.humanWaits).toEqual([])
      expect(GatewayProjection.approvals(after.events, after.summary)).toEqual([])
    }))
  })

  it("lists the root run as waiting-approval with the nested question", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const { runId, wait } = yield* parked

      const inbox = yield* control.list({ _tag: "runs", filters: { status: "waiting-approval" } })
      const all = yield* control.list({ _tag: "runs" })
      return {
        runId,
        wait,
        inbox: inbox._tag === "runs" ? inbox.items : [],
        listed: all._tag === "runs" ? all.items.find((item) => item.runId === runId) : undefined
      }
    }))

    // The wait is held by an execution the control plane's database has never
    // heard of, which is the whole difficulty.
    expect(observed.wait.runId).not.toBe(observed.runId)

    // `List {status:"waiting-approval"}` answered [] on the deployed host.
    expect(observed.inbox.map((item) => item.runId)).toContain(observed.runId)
    // `List {}` answered `parked` on an `event` with no pendingWaits.
    expect(observed.listed?.status).toBe("waiting-approval")
    const waits = observed.listed?.pendingWaits ?? []
    expect(waits.map((item) => item.runId)).toEqual([observed.wait.runId])
    expect(waits[0]).toMatchObject({
      reason: "approval",
      name: "coding-clarification",
      attempt: 1,
      token: observed.wait.token,
      request: { kind: "ask", prompt, name: "coding-clarification", maxAttempts: 3 }
    })
  })

  it("serves the nested gate through the run-scoped approvals projection", async () => {
    const rows = await run(Effect.gen(function*() {
      const projections = yield* Projections.Projections
      const { runId } = yield* parked
      const snapshot = yield* projections.snapshot({ _tag: "approvals", runId })
      return snapshot.rows as ReadonlyArray<GatewayProjection.ApprovalRow>
    }))

    // "No approvals are pending" is what the product showed for exactly this.
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      requestId: "coding-clarification#1",
      title: prompt,
      status: "pending",
      request: { kind: "ask", maxAttempts: 3 }
    })
    expect(rows[0]?.waitRunId).not.toBe(rows[0]?.runId)
  })

  /**
   * The act a person actually performs: Send answer on the card.
   *
   * The card submits `Approval.Submit` with the row's payload and the value
   * typed into it, which is a different path from `Signal`. Submitted as an
   * ordinary approval it reached `Control.approve`, which looks for a
   * registered approval token — a `HumanTask` parks itself on a durable wait
   * and never registers one — and answered `/control/RunNotFound` naming a run
   * that was listed, rendered and waiting (workspace 4bb93306, run-1).
   */
  it("clears the wait and resumes the flow when the answer is submitted as an approval", async () => {
    const observed = await run(Effect.gen(function*() {
      const projections = yield* Projections.Projections
      const engine = yield* Engine
      const { runId } = yield* parked
      const rows = (yield* projections.snapshot({ _tag: "approvals", runId })).rows as ReadonlyArray<
        GatewayProjection.ApprovalRow
      >
      const gate = rows[0]!

      // Exactly what the card sends: the published payload, unchanged, plus
      // the value the person typed.
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      const submitted = yield* rpc["Approval.Submit"]({
        ...gate.payload,
        decision: "approve",
        answer: "the scheduler owns it"
      })

      return {
        runId,
        submitted,
        settled: yield* engine.settled(runId),
        observation: yield* engine.observe(runId)
      }
    }))

    expect(observed.submitted.decision._tag).toBe("Accepted")
    // The wait is gone and the flow ran on: the planner settled with the answer.
    expect(observed.settled).toBe("completed")
    expect(
      observed.observation._tag === "Observed" ? observed.observation.pendingWaits : ["unread"]
    ).toBeUndefined()
  })

  it("refuses the same submission with no answer, without claiming the run is gone", async () => {
    const failure = await run(Effect.gen(function*() {
      const projections = yield* Projections.Projections
      const { runId } = yield* parked
      const rows = (yield* projections.snapshot({ _tag: "approvals", runId })).rows as ReadonlyArray<
        GatewayProjection.ApprovalRow
      >
      const rpc = yield* RpcTest.makeClient(GatewayRpcs)
      return yield* Effect.flip(rpc["Approval.Submit"]({ ...rows[0]!.payload, decision: "approve" }))
    }))

    expect(failure._tag).toBe("/control/InvalidInput")
    expect(String((failure as { issue?: string }).issue)).toContain("coding-clarification#1")
  })

  it("answers the nested wait from a signal addressed to the root run", async () => {
    const observed = await run(Effect.gen(function*() {
      const control = yield* Control
      const { runId } = yield* parked
      const receipt = yield* control.signal({
        runId,
        signal: { name: "coding-clarification", payload: "the scheduler owns it" },
        idempotencyKey: `signal:${runId}`
      })
      return { receipt, observation: yield* (yield* Engine).observe(runId) }
    }))

    expect(observed.receipt._tag).toBe("Accepted")
    // The wait is gone: the tree no longer owes anybody an answer.
    expect(observed.observation._tag === "Observed" ? observed.observation.pendingWaits : ["unread"]).toBeUndefined()
  })
})
