import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * A run parked on its task-time budget, answered after its process exits.
 *
 * The allowance is 500 ms of active time with `onExceeded: park`. The first
 * model call takes 1.1 s, so the second call's admission parks the run on a
 * `budget/` approval request. Composition A then closes. After a wait longer
 * than the raise the request proposes, composition B opens the same
 * `control.db` and `engine.db` and answers: approve is Continue, deny is Stop.
 *
 * Continue must complete the run. Wall time since the clock zero is past the
 * raised ceiling by then, so a budget that counts parked time as spent asks
 * again forever (#2120). Stop must fail the run without another provider call.
 *
 * Both compositions use the production control plane, durable engine, and
 * `AgentSession` budget provision; the only in-memory state is the scripted
 * model's call log.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Control, ControlFacts, ControlLive, ControlRuntime, ControlSchema, SqlControlRuntime } from "@smthrs/control"
import * as CoreFlow from "@smthrs/core/Flow"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { FlowRuntime } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
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
import { Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
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
import * as RunawayGuard from "../src/RunawayGuard.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
import * as StandardFlows from "../src/StandardFlows.ts"
import * as Safety from "./Safety.ts"

const allowanceMillis = 500
const firstCallMillis = 1_100
const betweenProcessesMillis = 1_500

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

const envelope: ControlSchema.Envelope = { capabilities: ["proc:spawn:*"], flows: [], budget: {} }

const agentDescriptor = new Descriptor.FlowDescriptor({
  name: "agents/runaway",
  description: "The agent whose task-time budget parks across a process boundary.",
  body: new Descriptor.BodyRefMarkdown({
    path: "/flows/agents/runaway/flow.md",
    baseDirectory: "/flows/agents/runaway",
    contentDigest: "b".repeat(64)
  }),
  input: new Descriptor.SchemaRefNone(),
  output: new Descriptor.SchemaRefNone(),
  model: Option.some("anthropic:test-model"),
  flows: [],
  capabilities: ["proc:spawn:*"],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  placement: Option.none(),
  modelInvocable: false,
  path: "/flows/agents/runaway",
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
          text: "Work for a while, then finish the task.",
          baseDirectory: "/flows/agents/runaway"
        })
      )
  })
)

const controlFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = [
  {
    flowId: agentDescriptor.name,
    executionDigest: Descriptor.executionDigest(agentDescriptor),
    description: agentDescriptor.description,
    deployClass: false,
    envelope
  }
]

const cellEvents = (source: string, id: string): ReadonlyArray<ModelEvent.ModelEvent> => [
  ModelEvent.ModelEvent.TextStart({ type: "text-start", id }),
  ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id, text: "```cell\n" + source + "\n```" }),
  ModelEvent.ModelEvent.TextEnd({ type: "text-end", id }),
  ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
]

/** Every provider call made by either composition, in order. */
const modelCalls: Array<string> = []

/** What provider call `n` (from zero, across both compositions) answers, and how long it takes. */
type Script = (n: number) => { readonly source: string; readonly delayMillis: number }

/** The first call is slow and does not finish; every later call finishes at once. */
const slowFirstCall: Script = (n) =>
  n === 0
    ? { source: `console.log("working")`, delayMillis: firstCallMillis }
    : { source: `ctx.done("settled")`, delayMillis: 0 }

let script: Script = slowFirstCall

const scripted = (host: string): Model.Model =>
  Model.make({
    stream: () =>
      Stream.unwrap(
        Effect.gen(function*() {
          const n = modelCalls.length
          const { delayMillis, source } = script(n)
          modelCalls.push(host)
          if (delayMillis > 0) yield* Effect.sleep(`${delayMillis} millis`)
          return Stream.fromIterable(cellEvents(source, `cell-${n}`))
        })
      )
  })

/** Every invocation of the `test/slow` flow's handler, by either composition. */
const slowCalls: Array<string> = []

const slowFlow = CoreFlow.make({
  name: "test/slow",
  description: "Takes two seconds the first time it is called, and no time after.",
  input: Schema.Struct({}),
  output: Schema.Struct({ n: Schema.Number }),
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})

const slowSource = (host: string): FlowBinding.Source =>
  FlowBinding.source("test/slow", [
    FlowBinding.make({
      flow: slowFlow,
      handler: () =>
        Effect.gen(function*() {
          slowCalls.push(host)
          if (slowCalls.length === 1) yield* Effect.sleep("2 seconds")
          return { n: slowCalls.length }
        })
    })
  ])

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
  snapshot: () => Effect.succeed({ commitId: "runaway-guard", changeId: "runaway-guard" }),
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

/** The time limits and flows one case's compositions run with. */
interface Guarded {
  readonly modelCallMs?: number
  readonly limits?: { readonly callMs?: number; readonly totalMs?: number }
  readonly flows?: (host: string) => ReadonlyArray<FlowBinding.Source>
}

/** One process's control plane and production executor over one pair of SQLite files. */
const host = (root: string, owner: Ownership.OwnerId, engineHost: string, guarded: Guarded = {}) => {
  const registration = AgentSession.layer({
    quotaPolicy: Safety.quotaPolicy,
    // The approved envelope, raised by every approved `budget/` request.
    budget: (approved) => Budget.layerFromEnvelope(approved),
    flows: guarded.flows?.(engineHost) ?? [],
    limits: { memoryBytes: 64 * 1024 * 1024, steps: 5_000_000, ...guarded.limits },
    ...(guarded.modelCallMs === undefined ? {} : { modelCallMs: guarded.modelCallMs }),
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
  // `provideMerge` so a case can drive the engine as a peer's poll would.
  return ControlLive.layer.pipe(
    Layer.provideMerge(engine),
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
  slowCalls.length = 0
  script = slowFirstCall
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "flows-runaway-guard-"))
  roots.add(root)
  return root
}

const readEngineRun = (root: string, runId: string) => {
  const database = new DatabaseSync(join(root, "engine.db"), { readOnly: true })
  try {
    return database.prepare(
      `SELECT status, waiting_reason, waiting_token, waiting_request, owner_host_id
       FROM flows_runs WHERE run_id = ?`
    ).get(runId) as unknown as
      | {
        readonly status: string
        readonly waiting_reason: string | null
        readonly waiting_token: string | null
        readonly waiting_request: string | null
        readonly owner_host_id: string | null
      }
      | undefined
  } finally {
    database.close()
  }
}

/** How many engine journal records a run has; each committed round adds some. */
const countEngineEvents = (root: string, runId: string): number => {
  const database = new DatabaseSync(join(root, "engine.db"), { readOnly: true })
  try {
    const row = database.prepare("SELECT count(*) AS n FROM flows_journal_events WHERE run_id = ?").get(runId) as
      | { readonly n: number }
      | undefined
    return row?.n ?? 0
  } finally {
    database.close()
  }
}

/** Every approval request fact the run's journal holds, in order. */
const readRequestFacts = (root: string, runId: string): ReadonlyArray<typeof ControlFacts.ApprovalRequestFact.Type> => {
  const database = new DatabaseSync(join(root, "engine.db"), { readOnly: true })
  try {
    const rows = database.prepare(
      "SELECT payload_json FROM flows_journal_events WHERE run_id = ? AND event_type = ? ORDER BY seq"
    ).all(runId, "control.approval.requested") as unknown as ReadonlyArray<{ readonly payload_json: string }>
    return rows.map((row) => Schema.decodeUnknownSync(ControlFacts.ApprovalRequestFact)(JSON.parse(row.payload_json)))
  } finally {
    database.close()
  }
}

const firstOwner: Ownership.OwnerId = { hostId: "runaway-first", pid: 1, nonce: "first" }
const secondOwner: Ownership.OwnerId = { hostId: "runaway-second", pid: 2, nonce: "second" }

const terminal = new Set(["control.run.completed", "control.run.failed", "control.run.cancelled"])

/** The first budget question or terminal event after `afterSequence`. */
const nextIncident = (runId: string, afterSequence?: number) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    const events = yield* control.watch({
      runId,
      follow: true,
      ...(afterSequence === undefined ? {} : { afterSequence })
    }).pipe(
      Stream.filter((event) => terminal.has(event.kind) || event.kind === "control.approval.requested"),
      Stream.take(1),
      Stream.runCollect,
      Effect.timeout("60 seconds")
    )
    return events[0]!
  })

/** Composition A: launches the run and returns once it parks on its budget. */
const parkInFirstProcess = (
  root: string,
  budget: ControlSchema.Envelope["budget"] = { milliseconds: allowanceMillis, onExceeded: "park" },
  guarded: Guarded = {}
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const card = yield* control.plan({ flowId: agentDescriptor.name, input: {}, budget })
      yield* control.approve(card.approval)
      const receipt = yield* control.run({
        _tag: "Plan",
        planId: card.planId,
        digest: card.digest,
        envelope: card.envelope,
        idempotencyKey: "run:runaway"
      })
      if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
        return yield* Effect.die("expected an accepted run")
      }
      const runId = receipt.runId
      const requested = yield* nextIncident(runId)
      if (requested.kind !== "control.approval.requested") return { runId, kind: requested.kind }
      // The park is settled once the control summary reads it, as the CLI does.
      yield* control.list({ _tag: "runs", filters: { runId } }).pipe(
        Effect.flatMap((page) =>
          page._tag === "runs" && page.items[0]?.status === "parked" ? Effect.void : Effect.fail(page)
        ),
        Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 1_500 }),
        Effect.orDie
      )
      const approval = Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(
        (requested.payload as { readonly payload: unknown }).payload
      )
      return { runId, kind: requested.kind, sequence: requested.sequence, approval }
    }).pipe(Effect.provide(host(root, firstOwner, "runaway-first", guarded)), Effect.scoped, Effect.orDie)
  )

/** Composition B: answers the park and follows the run to its next incident. */
const answerInSecondProcess = (
  root: string,
  parked: { readonly runId: string; readonly sequence: number; readonly approval: ControlSchema.ApprovalPayload },
  answer: "continue" | "stop",
  guarded: Guarded = {}
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const runtime = yield* ControlRuntime.ControlRuntime
      yield* answer === "continue" ? control.approve(parked.approval) : control.deny(parked.approval)
      const next = yield* nextIncident(parked.runId, parked.sequence)
      const payload = next.kind === "control.approval.requested"
        ? Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(
          (next.payload as { readonly payload: unknown }).payload
        )
        : undefined
      return { kind: next.kind, sequence: next.sequence, approval: payload, run: yield* runtime.getRun(parked.runId) }
    }).pipe(Effect.provide(host(root, secondOwner, "runaway-second", guarded)), Effect.scoped, Effect.orDie)
  )

/**
 * Composition B drives a round nobody asked for, as a peer's poll would, and
 * returns the parked row and run once that round has settled.
 */
const unaskedRound = (root: string, runId: string, guarded: Guarded = {}) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const engine = yield* FlowRuntime.FlowRuntime
      const runtime = yield* ControlRuntime.ControlRuntime
      expect((yield* runtime.pendingResumes).filter((entry) => entry.runId === runId)).toEqual([])
      const before = countEngineEvents(root, runId)
      yield* engine.resume(AgentSession.agentFlow, runId)
      let row = readEngineRun(root, runId)
      for (let attempt = 0; attempt < 1_500; attempt++) {
        row = readEngineRun(root, runId)
        if (countEngineEvents(root, runId) > before && row?.status === "suspended" && row.owner_host_id === null) break
        yield* Effect.sleep("20 millis")
      }
      expect(countEngineEvents(root, runId)).toBeGreaterThan(before)
      return { row, run: yield* runtime.getRun(runId) }
    }).pipe(Effect.provide(host(root, secondOwner, "runaway-second", guarded)), Effect.scoped, Effect.orDie)
  )

describe("a run parked on its task-time budget", () => {
  it("a task-time park survives restart and Continue completes the run", async () => {
    const root = makeRoot()
    const parked = await parkInFirstProcess(root)

    expect(parked.kind).toBe("control.approval.requested")
    if (parked.approval === undefined) return
    expect(modelCalls).toEqual(["runaway-first"])
    expect(readEngineRun(root, parked.runId)).toMatchObject({ status: "suspended", waiting_reason: "budget" })
    // The raise covers the active time spent plus one more allowance.
    const proposed = parked.approval.target.envelope.budget.milliseconds!
    expect(proposed).toBeGreaterThanOrEqual(firstCallMillis + allowanceMillis)
    expect(proposed).toBeLessThan(firstCallMillis + allowanceMillis + betweenProcessesMillis)
    // The request carries the guard's exact facts, frozen when it tripped.
    const [request, ...others] = readRequestFacts(root, parked.runId)
    expect(others).toEqual([])
    expect(request?.incident).toMatchObject({
      classification: "Runaway",
      source: "latency",
      max: allowanceMillis,
      next: 0,
      allowance: proposed,
      message: expect.stringMatching(/of its 500 ms budget/)
    })
    expect(request!.incident!.used).toBeGreaterThanOrEqual(firstCallMillis)
    expect(proposed).toBe(request!.incident!.used! + (request!.incident!.reserved ?? 0) + allowanceMillis)

    // Parked wall time past the raised ceiling is not task time.
    await new Promise((resolve) => setTimeout(resolve, betweenProcessesMillis))

    const settled = await answerInSecondProcess(root, parked, "continue")

    expect(settled.kind).toBe("control.run.completed")
    expect(settled.run.status).toBe("completed")
    expect(modelCalls).toEqual(["runaway-first", "runaway-second"])
  }, 180_000)

  it("Stop fails the parked run without another provider call", async () => {
    const root = makeRoot()
    const parked = await parkInFirstProcess(root)

    expect(parked.kind).toBe("control.approval.requested")
    if (parked.approval === undefined) return

    const settled = await answerInSecondProcess(root, parked, "stop")

    expect(settled.kind).toBe("control.run.failed")
    expect(settled.run.status).toBe("failed")
    expect(modelCalls).toEqual(["runaway-first"])
  }, 180_000)

  /**
   * A round nobody asked for re-parks the run in a host that did not park
   * it. The engine cleared the waiting columns when it activated that round,
   * so the budget request's token and question come back from the run's
   * durable approval facts, or the parked row no longer names the question
   * Continue answers.
   */
  it("an unasked round in a fresh host keeps the budget park's token and question", async () => {
    const root = makeRoot()
    const parked = await parkInFirstProcess(root)

    expect(parked.kind).toBe("control.approval.requested")
    const first = readEngineRun(root, parked.runId)
    expect(first).toMatchObject({ status: "suspended", waiting_reason: "budget" })
    expect(first?.waiting_token).toMatch(/^budget\//)
    expect(JSON.parse(first?.waiting_request ?? "null")).toEqual({ question: expect.stringMatching(/^Raise the /) })
    const requested = readRequestFacts(root, parked.runId)
    expect(requested).toHaveLength(1)
    expect(requested[0]?.incident?.classification).toBe("Runaway")

    const observed = await unaskedRound(root, parked.runId)

    expect(observed.row).toMatchObject({
      status: "suspended",
      waiting_reason: "budget",
      waiting_token: first?.waiting_token,
      waiting_request: first?.waiting_request
    })
    expect(observed.run.status).toBe("parked")
    expect(modelCalls).toEqual(["runaway-first"])
    // The fresh host re-parked on the recorded incident: no second request,
    // and no fact measured again.
    expect(readRequestFacts(root, parked.runId)).toEqual(requested)
  }, 180_000)
})

/** A park the run's operator has not answered yet. */
type Parked = Awaited<ReturnType<typeof parkInFirstProcess>>

/**
 * Parks a run on its first timeout, with ceilings far out of reach so only a
 * timeout parks, and returns the question it asked.
 */
const parkOnTimeout = async (root: string, guarded: Guarded) => {
  const parked: Parked = await parkInFirstProcess(root, { milliseconds: 600_000, onExceeded: "park" }, guarded)
  expect(parked.kind).toBe("control.approval.requested")
  return { runId: parked.runId, sequence: parked.sequence!, approval: parked.approval! }
}

describe("a run parked on a timeout", () => {
  const modelTimeout: Guarded = { modelCallMs: 300 }
  /** Both attempts of the first call outrun the 300 ms call limit; later calls answer at once. */
  const hangingCalls: Script = (n) => ({ source: `ctx.done("settled")`, delayMillis: n < 2 ? 1_000 : 0 })

  it(
    "parks an exhausted model call as a Stuck incident, holds it across restart, and Continue re-issues it",
    async () => {
      script = hangingCalls
      const root = makeRoot()
      const parked = await parkOnTimeout(root, modelTimeout)

      // The call and its one overrun retry, then the park.
      expect(modelCalls).toEqual(["runaway-first", "runaway-first"])
      expect(readEngineRun(root, parked.runId)).toMatchObject({ status: "suspended", waiting_reason: "budget" })
      const requested = readRequestFacts(root, parked.runId)
      expect(requested).toHaveLength(1)
      expect(requested[0]?.requestId).toMatch(/\/timeout\/[0-9a-f]{64}\/1$/)
      expect(requested[0]?.incident).toMatchObject({
        classification: "Stuck",
        source: "model-call",
        max: 300,
        allowance: 300,
        message: expect.stringMatching(/ran past its/)
      })

      // A restarted host with no answer re-parks on the same request and calls nothing.
      const pending = await unaskedRound(root, parked.runId, modelTimeout)
      expect(pending.row).toMatchObject({ status: "suspended", waiting_reason: "budget" })
      expect(pending.run.status).toBe("parked")
      expect(modelCalls).toHaveLength(2)
      expect(readRequestFacts(root, parked.runId)).toEqual(requested)

      const settled = await answerInSecondProcess(root, parked, "continue", modelTimeout)

      expect(settled.kind).toBe("control.run.completed")
      expect(settled.run.status).toBe("completed")
      // Continue authorized exactly one more call.
      expect(modelCalls).toEqual(["runaway-first", "runaway-first", "runaway-second"])
      expect(readRequestFacts(root, parked.runId)).toEqual(requested)
    },
    180_000
  )

  it("Stop fails a model-call timeout without calling the provider again", async () => {
    script = hangingCalls
    const root = makeRoot()
    const parked = await parkOnTimeout(root, modelTimeout)

    const settled = await answerInSecondProcess(root, parked, "stop", modelTimeout)

    expect(settled.kind).toBe("control.run.failed")
    expect(settled.run.status).toBe("failed")
    expect(modelCalls).toHaveLength(2)
  }, 180_000)

  const slowTool: Guarded = { limits: { callMs: 300 }, flows: (host) => [slowSource(host)] }
  const callsSlow: Script = (n) => ({
    source: n === 0 ? `const r = await ctx.call("test/slow", {})\nctx.done("slow=" + r.n)` : `ctx.done("again")`,
    delayMillis: 0
  })

  it("parks a tool call past its limit and Continue issues it again", async () => {
    script = callsSlow
    const root = makeRoot()
    const parked = await parkOnTimeout(root, slowTool)

    expect(slowCalls).toEqual(["runaway-first"])
    const [request] = readRequestFacts(root, parked.runId)
    expect(request?.incident).toMatchObject({ classification: "Stuck", source: "tool-call", max: 300, allowance: 300 })

    const settled = await answerInSecondProcess(root, parked, "continue", slowTool)

    expect(settled.kind).toBe("control.run.completed")
    // The timed-out call ran again in the resumed frame; the model was not asked again.
    expect(slowCalls).toEqual(["runaway-first", "runaway-second"])
    expect(modelCalls).toEqual(["runaway-first"])
  }, 180_000)

  it("Stop refuses the timed-out tool call before it runs again", async () => {
    script = callsSlow
    const root = makeRoot()
    const parked = await parkOnTimeout(root, slowTool)

    const settled = await answerInSecondProcess(root, parked, "stop", slowTool)

    expect(settled.kind).toBe("control.run.failed")
    expect(slowCalls).toEqual(["runaway-first"])
    expect(modelCalls).toEqual(["runaway-first"])
  }, 180_000)

  it("parks a cell past its wall-clock limit and Continue evaluates it again", async () => {
    const slowCell: Guarded = { limits: { totalMs: 500, callMs: 5_000 }, flows: (host) => [slowSource(host)] }
    script = callsSlow
    const root = makeRoot()
    const parked = await parkOnTimeout(root, slowCell)

    const [request] = readRequestFacts(root, parked.runId)
    expect(request?.incident).toMatchObject({ classification: "Stuck", source: "cell", max: 500, allowance: 500 })

    const settled = await answerInSecondProcess(root, parked, "continue", slowCell)

    expect(settled.kind).toBe("control.run.completed")
    expect(slowCalls).toEqual(["runaway-first", "runaway-second"])
    expect(modelCalls).toEqual(["runaway-first"])
  }, 180_000)

  it("parks a command's own timeout, asks again after Continue, and Stop fails the run", async () => {
    const shell = Effect.runSync(Effect.context<NodeServices.NodeServices>().pipe(Effect.provide(NodeServices.layer)))
    const bash: Guarded = { flows: () => [StandardFlows.shell(shell)] }
    script = (n) => ({
      source: n === 0
        ? `await ctx.call("bash", { command: "sleep 5", timeoutMs: 200 })\nctx.done("ran")`
        : `ctx.done("again")`,
      delayMillis: 0
    })
    const root = makeRoot()
    const parked = await parkOnTimeout(root, bash)

    const [first] = readRequestFacts(root, parked.runId)
    expect(first?.incident).toMatchObject({ classification: "Stuck", source: "tool-call" })
    expect(first?.requestId).toMatch(/\/1$/)

    // Continue runs the command again under the same limit; it times out again
    // and the run asks again under a new request rather than looping.
    const again = await answerInSecondProcess(root, parked, "continue", bash)
    expect(again.kind).toBe("control.approval.requested")
    const requests = readRequestFacts(root, parked.runId)
    expect(requests.map((request) => request.requestId.slice(-2))).toEqual(["/1", "/2"])

    const settled = await answerInSecondProcess(
      root,
      { runId: parked.runId, sequence: again.sequence, approval: again.approval! },
      "stop",
      bash
    )
    expect(settled.kind).toBe("control.run.failed")
    expect(modelCalls).toEqual(["runaway-first"])
  }, 180_000)
})

describe("the incident a tripped guard parks on", () => {
  const exceeded = (fields: Partial<ConstructorParameters<typeof Budget.BudgetExceeded>[0]>) =>
    new Budget.BudgetExceeded({
      scope: "latency",
      onExceeded: "park",
      used: 1_200,
      max: 1_000,
      next: 0,
      message: "latency used 1200 of 1000",
      ...fields
    })

  it("freezes a budget's numbers, the in-flight reservation, and the proposed raise", () => {
    expect(RunawayGuard.incident(exceeded({ reserved: 300 }), 2_000)).toEqual({
      classification: "Runaway",
      source: "latency",
      message: "latency used 1200 of 1000",
      used: 1_200,
      reserved: 300,
      max: 1_000,
      next: 0,
      allowance: 2_000
    })
  })

  it("omits a reservation an older error never carried and an allowance nobody proposed", () => {
    const facts = RunawayGuard.incident(exceeded({ scope: "tokens", used: 900, next: 200, message: "tokens used 900" }))
    expect(facts).toEqual({
      classification: "Runaway",
      source: "tokens",
      message: "tokens used 900",
      used: 900,
      max: 1_000,
      next: 200
    })
    expect(facts).not.toHaveProperty("reserved")
    expect(facts).not.toHaveProperty("allowance")
  })

  it("reads a folded-in daily cap as a token incident, since the incident schema has no daily source", () => {
    const facts = RunawayGuard.incident(exceeded({ scope: "daily", onExceeded: "fail" }))
    expect(facts.source).toBe("tokens")
    expect(Schema.is(ControlFacts.GuardIncident)(facts)).toBe(true)
  })

  it("offers one more run under the limit only when the timeout said its limit", () => {
    const limited = new RunawayGuard.Timeout({
      source: "cell",
      subject: "cell-1",
      limitMillis: 500,
      message: "cell ran past 500 ms"
    })
    const unlimited = new RunawayGuard.Timeout({ source: "tool-call", subject: "bash-1", message: "bash timed out" })
    expect(RunawayGuard.incident(limited)).toEqual({
      classification: "Stuck",
      source: "cell",
      message: "cell ran past 500 ms",
      subject: "cell-1",
      max: 500,
      allowance: 500
    })
    expect(RunawayGuard.incident(unlimited)).toEqual({
      classification: "Stuck",
      source: "tool-call",
      message: "bash timed out",
      subject: "bash-1"
    })
  })
})
