import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * What an agent run's latency budget keeps when the process that started it
 * exits.
 *
 * The first composition makes one real model call, records the latency clock
 * zero, and parks the run on an in-run approval. Its scope then closes. A
 * second composition opens the same `control.db` and `engine.db`, approves the
 * park, and drives the next frame. The resumed run measures from the original
 * clock zero, minus the time it spent parked (#2120): a slow first call
 * refuses the next frame without calling the second process's model, and a
 * long park alone does not.
 *
 * Both compositions use the production control plane, durable engine, and
 * `AgentSession` budget provision. The only in-memory state is the scripted
 * model's call log, which observes whether the durable refusal happened before
 * the provider boundary.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Control, ControlLive, ControlRuntime, ControlSchema, SqlControlRuntime } from "@smthrs/control"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Jj from "@smthrs/jj"
import { Migrations, SqlJournal } from "@smthrs/journal"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { NotificationQueue } from "@smthrs/notifications"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { Migrations as RunStoreMigrations, type Ownership, RunStore } from "@smthrs/run-store"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentSession from "../src/AgentSession.ts"
import * as Budget from "../src/Budget.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
import * as Safety from "./Safety.ts"

const latencyMaxMillis = 1_000
const betweenProcessesMillis = 2_000
/** How long the first provider call takes in the case that overruns while active. */
let firstCallMillis = 0

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/messages",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const envelope: ControlSchema.Envelope = { capabilities: [], flows: [], budget: {} }

const agentDescriptor = new Descriptor.FlowDescriptor({
  name: "agents/budget-parker",
  description: "The agent whose latency budget crosses a process boundary.",
  body: new Descriptor.BodyRefMarkdown({
    path: "/flows/agents/budget-parker/flow.md",
    baseDirectory: "/flows/agents/budget-parker",
    contentDigest: "a".repeat(64)
  }),
  input: new Descriptor.SchemaRefNone(),
  output: new Descriptor.SchemaRefNone(),
  model: Option.some("anthropic:test-model"),
  flows: [],
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  placement: Option.none(),
  modelInvocable: false,
  path: "/flows/agents/budget-parker",
  frontmatter: {},
  provenance: new Descriptor.Provenance({ source: "test", root: "/flows" })
})

const registryLayer = Layer.succeed(Registry.Registry)(
  Registry.makeNoop({
    list: () => Effect.succeed([agentDescriptor]),
    visible: () => Effect.succeed([]),
    get: () => Effect.succeed(agentDescriptor),
    getOption: (name) => Effect.succeed(name === agentDescriptor.name ? Option.some(agentDescriptor) : Option.none()),
    loadBody: () =>
      Effect.succeed(
        new Descriptor.FlowBodyPrompt({
          text: "Ask for approval, then finish the task.",
          baseDirectory: "/flows/agents/budget-parker"
        })
      )
  })
)

const controlFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = [
  {
    flowId: "agents/budget-parker",
    executionDigest: Descriptor.executionDigest(agentDescriptor),
    description: "The agent whose latency budget crosses a process boundary.",
    deployClass: false,
    envelope
  }
]

/**
 * The first frame parks, then settles as `continue` after approval so the
 * resumed run must cross the model boundary again.
 */
const askFrame =
  `const decision = await ctx.call("ask", { question: "continue after the budget wait?", options: ["yes", "no"] })
console.log("approved=" + decision.approved)`

/** The frame a fresh latency allowance would let the second process run. */
const doneFrame = `ctx.done("settled")`

const cellEvents = (source: string, id: string): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: "```cell\n" + source + "\n```" }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

/** Every provider call made by either composition, in order. */
const modelCalls: Array<string> = []

const scripted = (host: string): Model.Model =>
  Model.make({
    stream: () =>
      Stream.unwrap(
        Effect.gen(function*() {
          const source = modelCalls.length === 0 ? askFrame : doneFrame
          const id = `cell-${modelCalls.length}`
          const slow = modelCalls.length === 0 ? firstCallMillis : 0
          modelCalls.push(host)
          if (slow > 0) yield* Effect.sleep(`${slow} millis`)
          return Stream.fromIterable(cellEvents(source, id))
        })
      )
  })

const seatFor = (host: string): SeatResolver.Service["resolve"] => (id) =>
  Effect.succeed(
    Seat.make({
      id,
      modelId: "test-model",
      model: scripted(host),
      route,
      contextWindowTokens: SeatResolver.contextWindowTokensFor("test-model")
    })
  )

const jj = Jj.layerNoop({
  snapshot: () => Effect.succeed({ commitId: "budget-across-processes", changeId: "budget-across-processes" }),
  restore: () => Effect.void,
  diff: () => Effect.succeed("")
})

const controlStores = (filename: string) =>
  Layer.mergeAll(SqlJournal.layer({ capacity: 1024, overflow: "reject" }), RunStore.layer).pipe(
    Layer.provideMerge(
      Layer.provideMerge(
        DatabaseMigrations.layer([Migrations.set, RunStoreMigrations.set]),
        Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
      )
    )
  )

/**
 * One process's control plane and production executor over one pair of SQLite
 * files, composed the same way as `NodeControl`.
 */
const host = (root: string, owner: Ownership.OwnerId, engineHost: string) => {
  const registration = AgentSession.layer({
    quotaPolicy: Safety.quotaPolicy,
    budget: (_envelope) => Budget.layer({ latency: { maxMillis: latencyMaxMillis } }),
    flows: [],
    limits: { memoryBytes: 64 * 1024 * 1024, steps: 5_000_000 },
    maxFrames: 4
  }).pipe(
    Layer.provide(
      Layer.mergeAll(Agent.layer, SeatResolver.layer({ resolve: seatFor(engineHost) }), scriptedCompletionJudge).pipe(
        Layer.provide(Safety.layer)
      )
    )
  )
  const engine = NodeRuntime.layer(
    {
      filename: join(root, "engine.db"),
      workspaceRoot: root,
      owner: { hostId: engineHost },
      isAlive: () => Effect.succeed(false)
    },
    StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    registration
  ).pipe(Layer.provide([AtomicFileSystem.layer, NodeCrypto.layer, jj]))
  return ControlLive.layer.pipe(
    Layer.provide(engine),
    Layer.provideMerge(
      Layer.mergeAll(
        SqlControlRuntime.layer({ owner, flows: controlFlows }).pipe(Layer.orDie),
        NotificationQueue.layer,
        registryLayer
      )
    ),
    Layer.provideMerge(Layer.merge(controlStores(join(root, "control.db")), NodeCrypto.layer))
  )
}

const roots = new Set<string>()

afterEach(async () => {
  modelCalls.length = 0
  firstCallMillis = 0
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "flows-budget-process-"))
  roots.add(root)
  return root
}

interface EngineRow {
  readonly status: string
  readonly waiting_reason: string | null
  readonly state_json: string
}

const readEngineRun = (root: string, runId: string): EngineRow | undefined => {
  const database = new DatabaseSync(join(root, "engine.db"), { readOnly: true })
  try {
    return database.prepare(
      "SELECT status, waiting_reason, state_json FROM flows_runs WHERE run_id = ?"
    ).get(runId) as unknown as EngineRow | undefined
  } finally {
    database.close()
  }
}

/** Waits for the engine's terminal write after the control plane settles. */
const awaitEngineStatus = (
  root: string,
  runId: string,
  status: string,
  attempts = 300
): Effect.Effect<EngineRow | undefined> =>
  Effect.gen(function*() {
    const row = readEngineRun(root, runId)
    if (row?.status === status || attempts <= 0) return row
    yield* Effect.sleep("100 millis")
    return yield* awaitEngineStatus(root, runId, status, attempts - 1)
  })

/** The durable latency clock zeros recorded for one run, in journal order. */
const readBudgetStarts = (root: string, runId: string): ReadonlyArray<{ readonly startedAt: number }> => {
  const database = new DatabaseSync(join(root, "engine.db"), { readOnly: true })
  try {
    const rows = database.prepare(
      "SELECT payload_json FROM flows_journal_events WHERE run_id = ? AND event_type = ? ORDER BY seq"
    ).all(runId, Budget.budgetStartedEvent) as unknown as ReadonlyArray<{ readonly payload_json: string }>
    return rows.map((row) => JSON.parse(row.payload_json) as { readonly startedAt: number })
  } finally {
    database.close()
  }
}

const firstOwner: Ownership.OwnerId = { hostId: "budget-first", pid: 1, nonce: "first" }
const secondOwner: Ownership.OwnerId = { hostId: "budget-second", pid: 2, nonce: "second" }

const launch = Effect.gen(function*() {
  const control = yield* Control.Control
  const card = yield* control.plan({ flowId: "agents/budget-parker", input: {} })
  yield* control.approve(card.approval)
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: "run:budget-parker"
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
    return yield* Effect.die("expected an accepted run")
  }
  return receipt.runId
})

const askPayload = (runId: string) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const requested = yield* control.watch({ runId }).pipe(
      Stream.filter((event) => event.kind === "control.approval.requested"),
      Stream.take(1),
      Stream.runCollect
    )
    const payload = (requested[0]?.payload as { readonly payload: unknown }).payload
    return Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(payload)
  })

/** Waits for the same durable park event the CLI treats as process settlement. */
const awaitParkEvent = (runId: string) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    yield* control.watch({ runId }).pipe(
      Stream.filter((event) => event.kind === "control.run.waiting-approval"),
      Stream.take(1),
      Stream.runDrain
    )
  })

/** Waits until the resumed run reaches any terminal control status. */
const awaitTerminalEvent = (runId: string) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const events = yield* control.watch({ runId }).pipe(
      Stream.filter((event) =>
        event.kind === "control.run.completed" ||
        event.kind === "control.run.failed" ||
        event.kind === "control.run.cancelled"
      ),
      Stream.take(1),
      Stream.runCollect
    )
    return events[0]?.kind
  })

/** Composition A calls the provider once, parks on the ask, and then exits completely. */
const parkInFirstProcess = (root: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const runId = yield* launch
      const approval = yield* askPayload(runId)
      yield* awaitParkEvent(runId)
      return { runId, approval }
    }).pipe(Effect.provide(host(root, firstOwner, "budget-first")), Effect.scoped, Effect.orDie)
  )

/** Composition B opens only after A's scope is gone, uses the same files, and approves. */
const approveInSecondProcess = (
  root: string,
  parked: { readonly runId: string; readonly approval: ControlSchema.ApprovalPayload },
  status: string
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const runtime = yield* ControlRuntime.ControlRuntime
      yield* control.approve(parked.approval)
      const event = yield* awaitTerminalEvent(parked.runId).pipe(Effect.timeout("100 seconds"))
      const engineRow = yield* awaitEngineStatus(root, parked.runId, status)
      return { engineRow, event, run: yield* runtime.getRun(parked.runId) }
    }).pipe(Effect.provide(host(root, secondOwner, "budget-second")), Effect.scoped, Effect.orDie)
  )

describe("a durable latency budget when its process exits", () => {
  it("refuses the resumed run's next model call from the original clock zero", async () => {
    const root = makeRoot()
    // The first call alone outruns the allowance while the run is active.
    firstCallMillis = latencyMaxMillis + 200

    const parked = await parkInFirstProcess(root)

    expect(modelCalls).toEqual(["budget-first"])
    expect(readEngineRun(root, parked.runId)).toMatchObject({ status: "suspended", waiting_reason: "approval" })
    const started = readBudgetStarts(root, parked.runId)
    expect(started).toHaveLength(1)
    expect(Number.isFinite(started[0]?.startedAt)).toBe(true)

    const settled = await approveInSecondProcess(root, parked, "failed")

    expect(settled.event).toBe("control.run.failed")
    expect(settled.run.status).toBe("failed")
    expect(modelCalls).toEqual(["budget-first"])
    expect(readBudgetStarts(root, parked.runId)).toEqual(started)

    const engineRow = settled.engineRow
    expect(engineRow?.status).toBe("failed")
    const failure = JSON.stringify(JSON.parse(engineRow?.state_json ?? "{}"))
    expect(failure).toContain("flows/agent/BudgetExceeded")
    expect(failure).toContain("\"scope\":\"latency\"")

    // Without durable zero recovery, B records a fresh zero. The replayed
    // first step costs nothing, and the new second call falls inside the fresh
    // allowance, so `doneFrame` reaches the provider and completes the run.
  }, 180_000)

  it("excludes an ordinary approval suspension across restart from the task allowance", async () => {
    const root = makeRoot()
    const parked = await parkInFirstProcess(root)

    expect(modelCalls).toEqual(["budget-first"])
    const started = readBudgetStarts(root, parked.runId)
    expect(started).toHaveLength(1)

    // Budget and engine clocks use real wall time. No TestClock participates.
    // The park alone outlasts the whole allowance.
    await new Promise((resolve) => setTimeout(resolve, betweenProcessesMillis))

    const settled = await approveInSecondProcess(root, parked, "completed")

    expect(settled.event).toBe("control.run.completed")
    expect(settled.run.status).toBe("completed")
    expect(modelCalls).toEqual(["budget-first", "budget-second"])
    // Excluding the park did not reset the ledger's clock zero.
    expect(readBudgetStarts(root, parked.runId)).toEqual(started)
  }, 180_000)
})
