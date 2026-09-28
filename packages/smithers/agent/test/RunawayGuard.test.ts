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
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
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

const envelope: ControlSchema.Envelope = { capabilities: [], flows: [], budget: {} }

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
  capabilities: [],
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

/** The first call is slow and does not finish; every later call finishes at once. */
const scripted = (host: string): Model.Model =>
  Model.make({
    stream: () =>
      Stream.unwrap(
        Effect.gen(function*() {
          const first = modelCalls.length === 0
          const id = `cell-${modelCalls.length}`
          modelCalls.push(host)
          if (first) yield* Effect.sleep(`${firstCallMillis} millis`)
          return Stream.fromIterable(cellEvents(first ? `console.log("working")` : `ctx.done("settled")`, id))
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

/** One process's control plane and production executor over one pair of SQLite files. */
const host = (root: string, owner: Ownership.OwnerId, engineHost: string) => {
  const registration = AgentSession.layer({
    quotaPolicy: Safety.quotaPolicy,
    // The approved envelope, raised by every approved `budget/` request.
    budget: (approved) => Budget.layerFromEnvelope(approved),
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
    return database.prepare("SELECT status, waiting_reason FROM flows_runs WHERE run_id = ?").get(runId) as unknown as
      | { readonly status: string; readonly waiting_reason: string | null }
      | undefined
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
const parkInFirstProcess = (root: string) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const card = yield* control.plan({
        flowId: agentDescriptor.name,
        input: {},
        budget: { milliseconds: allowanceMillis, onExceeded: "park" }
      })
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
    }).pipe(Effect.provide(host(root, firstOwner, "runaway-first")), Effect.scoped, Effect.orDie)
  )

/** Composition B: answers the park and follows the run to its next incident. */
const answerInSecondProcess = (
  root: string,
  parked: { readonly runId: string; readonly sequence: number; readonly approval: ControlSchema.ApprovalPayload },
  answer: "continue" | "stop"
) =>
  Effect.runPromise(
    Effect.gen(function*() {
      const control = yield* Control.Control
      const runtime = yield* ControlRuntime.ControlRuntime
      yield* answer === "continue" ? control.approve(parked.approval) : control.deny(parked.approval)
      const next = yield* nextIncident(parked.runId, parked.sequence)
      return { kind: next.kind, run: yield* runtime.getRun(parked.runId) }
    }).pipe(Effect.provide(host(root, secondOwner, "runaway-second")), Effect.scoped, Effect.orDie)
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
})
