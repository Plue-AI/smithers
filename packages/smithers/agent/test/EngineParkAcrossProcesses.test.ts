import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * What a durable park survives when the process that parked the run exits.
 *
 * A park is not a cancellation. `DurableEngineState` says so in its waiting
 * vocabulary: `timer`, `approval`, and `event` are runs waiting to be woken,
 * `released` is a run whose owner went away without settling it, and only an
 * operator cancel is terminal. The release validation found every one of those
 * collapsed into `cancelled`: `AgentSession`'s driver wrapped `engine.execute`
 * in an `Effect.onInterrupt` that called `engine.interrupt` — the DURABLE
 * cancel — for every interruption of the driver fiber, and a park and a
 * shutdown both interrupt it. The engine row was finalized `cancelled`, the
 * clock deadline was stamped completed 150 seconds before it fell due, and
 * `flows.engine.interrupted {"outcome":"cancelled"}` went into the journal of
 * a run nobody had cancelled.
 *
 * Every case here is two compositions over one pair of real SQLite files, and
 * the first composition's scope CLOSES between them: that close is the
 * detached `smithers up -d` process exiting, and it is the whole experiment.
 * The rows are then read with `node:sqlite` rather than through a service, so
 * the assertion is about what is on disk for the next process to find.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Control, ControlLive, ControlRuntime, ControlSchema, SqlControlRuntime } from "@smthrs/control"
import * as ControlExecutor from "@smthrs/control/ControlExecutor"
import * as CoreFlow from "@smthrs/core/Flow"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { AttemptEvidenceQuarantined } from "@smthrs/engine-store/Errors"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
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
import { Cause, Deferred, Duration, Effect, Exit, Layer, Option, Schema, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentSession from "../src/AgentSession.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
import * as Safety from "./Safety.ts"

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
  name: "agents/parker",
  description: "The parking agent.",
  body: new Descriptor.BodyRefMarkdown({
    path: "/flows/agents/parker/flow.md",
    baseDirectory: "/flows/agents/parker",
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
  path: "/flows/agents/parker",
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
        new Descriptor.FlowBodyPrompt({ text: "Park where you are told to.", baseDirectory: "/flows/agents/parker" })
      )
  })
)

const controlFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = [
  {
    flowId: "agents/parker",
    executionDigest: Descriptor.executionDigest(agentDescriptor),
    description: "The parking agent.",
    deployClass: false,
    envelope
  }
]

const noteFlow = CoreFlow.make({
  name: "note/save",
  description: "Save one line to the run's note log.",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ saved: Schema.Number }),
  effects: { reads: [], writes: ["/notes/**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
})

/** A cell that parks on the durable clock: 150 s is above the 60 s in-memory threshold. */
const timerFrame = `await ctx.call("wait", { seconds: 150, reason: "engine park pin" })
await ctx.call("note/save", { text: "woke" })
ctx.done("settled")`

/** A cell that parks on an in-run approval. */
const askFrame = `const decision = await ctx.call("ask", { question: "park here?", options: ["yes", "no"] })
await ctx.call("note/save", { text: "decision=" + decision.approved })
ctx.done("settled")`

/** A cell that is still executing when the process goes away. */
const busyFrame = `await ctx.call("note/save", { text: "busy" })
ctx.done("settled")`

/** The frame the scripted model answers with, chosen per case. */
let frame = timerFrame

const scripted: Model.Model = Model.make({
  stream: () =>
    Stream.fromIterable([
      ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell-0" }),
      ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell-0", text: "```cell\n" + frame + "\n```" }),
      ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell-0" }),
      ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
    ])
})

const seat: SeatResolver.Service["resolve"] = (id) =>
  Effect.succeed(
    Seat.make({
      id,
      modelId: "test-model",
      model: scripted,
      route,
      contextWindowTokens: SeatResolver.contextWindowTokensFor("test-model")
    })
  )

const jj = Jj.layerNoop({
  snapshot: () => Effect.succeed({ commitId: "engine-park", changeId: "engine-park" }),
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

const notes: Array<string> = []

/** Held open by `busyFrame`'s note handler so a run can be caught mid-execution. */
let holdNote: Deferred.Deferred<void> | undefined

/** Resolved by the note handler the instant a run enters it. */
let noteEntered: Deferred.Deferred<void> | undefined

/**
 * A composition that hosts executions: control plane, production executor,
 * real engine over `engine.db`, exactly as `NodeControl` composes them.
 */
const host = (
  root: string,
  owner: Ownership.OwnerId,
  engineHost = "engine-park-host",
  options: {
    readonly beforeResume?: (runId: string) => Effect.Effect<void>
    readonly resumed?: Deferred.Deferred<void>
    readonly adoptsAtOnce?: boolean
    readonly agent?: Agent.Service
    readonly boundary?: Layer.Layer<StepBoundary.Service>
  } = {}
) => {
  const registration = AgentSession.layer({
    quotaPolicy: Safety.quotaPolicy,
    budget: Safety.budget,
    // A composition that did not park the run may only adopt a standing
    // delegation once it has gone unanswered (`AgentSession.hostsPark`). A
    // restart case says so with zero rather than by waiting out the default
    // `Ownership.heartbeatStaleAfter`.
    ...(options.adoptsAtOnce === true ? { abandonedParkAfter: Duration.zero } : {}),
    flows: [
      FlowBinding.source("test/notes", [
        FlowBinding.make({
          flow: noteFlow,
          handler: (input) =>
            Effect.gen(function*() {
              notes.push(`${engineHost}:${input.text}`)
              if (noteEntered !== undefined) yield* Deferred.succeed(noteEntered, void 0)
              if (holdNote !== undefined) yield* Deferred.await(holdNote)
              return { saved: notes.length }
            })
        })
      ])
    ],
    limits: { memoryBytes: 64 * 1024 * 1024, steps: 5_000_000 },
    maxFrames: 4
  }).pipe(
    Layer.provide(Layer.effect(FlowRuntime.FlowRuntime, Effect.map(FlowRuntime.FlowRuntime, (runtime) => ({
      ...runtime,
      resume: (...args: Parameters<typeof runtime.resume>) => runtime.resume(...args).pipe(
        Effect.ensuring(options.resumed === undefined ? Effect.void : Deferred.succeed(options.resumed, void 0))
      )
    })))),
    Layer.provide(
      Layer.mergeAll(
        options.agent === undefined ? Agent.layer : Layer.succeed(Agent.Agent)(options.agent),
        SeatResolver.layer({ resolve: seat }),
        scriptedCompletionJudge
      ).pipe(
        Layer.provide(Safety.layer)
      )
    )
  )
  // The control plane the engine records its own wakes against, captured the
  // way `NativeControl` captures it: the engine layer is built before the
  // control runtime exists, and the record is what tells this composition's
  // park guard a fired clock from its own heartbeat sweep.
  let resumes: ControlRuntime.Service | undefined
  const bindControl = Layer.effectDiscard(
    Effect.map(ControlRuntime.ControlRuntime, (service) => {
      resumes = service
    })
  )
  const engine = NodeRuntime.layer(
    {
      filename: join(root, "engine.db"),
      workspaceRoot: root,
      owner: { hostId: engineHost },
      isAlive: () => Effect.succeed(false),
      requestResume: (runId) =>
        Effect.suspend(() => resumes === undefined ? Effect.void : Effect.ignore(resumes.requestResume(runId)))
    },
    options.boundary ?? StepBoundary.layer,
    WorkspaceSandbox.layerFileSystem(),
    registration
  ).pipe(Layer.provide([AtomicFileSystem.layer, NodeCrypto.layer, jj]))
  // `provideMerge` rather than `provide`: a case may drive the engine itself,
  // which is what a heartbeat sweep or a peer's poll is to the executor.
  return ControlLive.layer.pipe(
    Layer.provideMerge(engine),
    Layer.provideMerge(
      bindControl.pipe(Layer.provideMerge(
        Layer.mergeAll(
          Layer.effect(ControlRuntime.ControlRuntime, Effect.map(ControlRuntime.ControlRuntime, (runtime) => ({
            ...runtime,
            resume: (runId: string) => (options.beforeResume?.(runId) ?? Effect.void).pipe(
              Effect.andThen(runtime.resume(runId))
            )
          }))).pipe(Layer.provide(SqlControlRuntime.layer({ owner, flows: controlFlows }).pipe(Layer.orDie))),
          NotificationQueue.layer,
          registryLayer
        )
      ))
    ),
    Layer.provideMerge(Layer.merge(controlStores(join(root, "control.db")), NodeCrypto.layer))
  )
}

const roots = new Set<string>()

afterEach(async () => {
  notes.length = 0
  frame = timerFrame
  holdNote = undefined
  noteEntered = undefined
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "flows-engine-park-"))
  roots.add(root)
  return root
}

interface EngineRow {
  readonly status: string
  readonly waiting_reason: string | null
  readonly waiting_token: string | null
  readonly waiting_request: string | null
  readonly cancel_requested_at_ms: number | null
  readonly owner_host_id: string | null
}

const readEngineRun = (root: string, runId: string): EngineRow | undefined => {
  const database = new DatabaseSync(join(root, "engine.db"), { readOnly: true })
  try {
    return database.prepare(
      `SELECT status, waiting_reason, waiting_token, waiting_request, cancel_requested_at_ms, owner_host_id
       FROM flows_runs WHERE run_id = ?`
    ).get(runId) as unknown as EngineRow | undefined
  } finally {
    database.close()
  }
}

const readPendingClocks = (root: string, runId: string): ReadonlyArray<{ readonly due_at_ms: number }> => {
  const database = new DatabaseSync(join(root, "engine.db"), { readOnly: true })
  try {
    return database.prepare(
      "SELECT due_at_ms FROM flows_clock_deadlines WHERE execution_id = ? AND completed_at_ms IS NULL"
    ).all(runId) as unknown as ReadonlyArray<{ readonly due_at_ms: number }>
  } finally {
    database.close()
  }
}

/**
 * Moves a run's pending clock deadlines into the past, between two processes.
 *
 * A durable deadline that fell due while the host was down is the ordinary
 * case — the engine re-arms what it finds on disk at registration — and this
 * is how a test states it without waiting one out.
 */
const expireClocks = (root: string, runId: string): void => {
  const database = new DatabaseSync(join(root, "engine.db"))
  try {
    database.prepare(
      "UPDATE flows_clock_deadlines SET due_at_ms = ? WHERE execution_id = ? AND completed_at_ms IS NULL"
    ).run(Date.now() - 1_000, runId)
  } finally {
    database.close()
  }
}

/** How many engine journal records a run has. */
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

/** Every `flows.engine.interrupted` outcome the engine journal holds for a run. */
const readInterruptOutcomes = (root: string, runId: string): ReadonlyArray<string> => {
  const database = new DatabaseSync(join(root, "engine.db"), { readOnly: true })
  try {
    const rows = database.prepare(
      "SELECT payload_json FROM flows_journal_events WHERE run_id = ? AND event_type = 'flows.engine.interrupted'"
    ).all(runId) as unknown as ReadonlyArray<{ readonly payload_json: string }>
    return rows.map((row) => String((JSON.parse(row.payload_json) as { outcome?: unknown }).outcome))
  } finally {
    database.close()
  }
}

const hostOwner: Ownership.OwnerId = { hostId: "engine-park-host", pid: 1, nonce: "host" }
const secondOwner: Ownership.OwnerId = { hostId: "engine-park-second", pid: 2, nonce: "second" }

const awaitStatus = (
  runtime: ControlRuntime.Service,
  runId: string,
  status: ControlSchema.RunStatus,
  attempts = 3_000
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    const run = yield* runtime.getRun(runId)
    if (run.status === status) return
    if (attempts <= 0) return yield* Effect.die(`run ${runId} never reached ${status} (still ${run.status})`)
    yield* Effect.sleep("10 millis")
    return yield* awaitStatus(runtime, runId, status, attempts - 1)
  })

const awaitQuarantine = (root: string, runId: string, attempts = 3_000): Effect.Effect<void> =>
  Effect.gen(function*() {
    const row = readEngineRun(root, runId)
    if (row?.status === "suspended" && row.waiting_reason === "quarantine") return
    if (attempts <= 0) return yield* Effect.die(`run ${runId} did not quarantine: ${JSON.stringify(row)}`)
    yield* Effect.sleep("10 millis")
    return yield* awaitQuarantine(root, runId, attempts - 1)
  })

/** Launches the agent run and returns its id and the ask payload, when one was asked. */
const launch = Effect.gen(function*() {
  const control = yield* Control.Control
  const card = yield* control.plan({ flowId: "agents/parker", input: {} })
  yield* control.approve(card.approval)
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: "run:parker"
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
    return yield* Effect.die("expected an accepted run")
  }
  return receipt.runId
})

/**
 * Waits for exactly the event the shipped CLI waits for.
 *
 * `Command.ts` `settled` counts `control.run.waiting-approval` as "this
 * process has nothing left to drive", and `awaitRun` returns on it, after
 * which the run verb renders its receipt and the scope closes. Polling the
 * control row instead would give the engine a head start the operator loop
 * does not give it, so the park would look durable in a test and be torn in
 * the field.
 */
const awaitParkEvent = (runId: string, status: "parked" | "waiting-approval") =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    yield* control.watch({ runId }).pipe(
      Stream.filter((event) => event.kind === `control.run.${status}`),
      Stream.take(1),
      Stream.runCollect
    )
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

/**
 * Reads the engine row repeatedly for a second after the parking composition
 * is gone. The driver's interrupt handler forked its writes detached, so a
 * single read the instant the scope closed could pass while the cancellation
 * was still in flight.
 */
const settledEngineRow = async (root: string, runId: string): Promise<EngineRow | undefined> => {
  let row = readEngineRun(root, runId)
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    row = readEngineRun(root, runId)
    if (row?.status === "cancelled") return row
  }
  return row
}

describe("an agent execution quarantined by the durable engine", () => {
  it("fences a delegated resume when a peer quarantines after its wait precheck", async () => {
    const root = makeRoot()
    const runId = await Effect.runPromise(Effect.gen(function*() {
      const id = yield* launch
      const runtime = yield* ControlRuntime.ControlRuntime
      yield* awaitStatus(runtime, id, "parked")
      return id
    }).pipe(Effect.provide(host(root, hostOwner)), Effect.scoped, Effect.orDie))
    expect(readEngineRun(root, runId)?.waiting_reason).toBe("timer")
    const resumed = Deferred.makeUnsafe<void>()
    let quarantines = 0
    await Effect.runPromise(Effect.gen(function*() {
      const executor = yield* ControlExecutor.ControlExecutor
      expect(yield* executor.resumeRun({ runId })).toBe("resuming")
      yield* Deferred.await(resumed)
    }).pipe(Effect.provide(host(root, secondOwner, "quarantine-race", {
      resumed,
      beforeResume: (id) => Effect.sync(() => {
        quarantines++
        const database = new DatabaseSync(join(root, "engine.db"))
        try {
          database.prepare("UPDATE flows_runs SET waiting_reason = 'quarantine', waiting_token = 'peer-corruption' WHERE run_id = ?").run(id)
        } finally {
          database.close()
        }
      })
    })), Effect.scoped, Effect.orDie))
    expect(quarantines).toBe(1)
    expect(readEngineRun(root, runId)?.status).toBe("suspended")
    expect(readEngineRun(root, runId)?.waiting_reason).toBe("quarantine")
    expect(readEngineRun(root, runId)?.waiting_token).toBe("peer-corruption")
    expect(notes).toEqual([])
    const database = new DatabaseSync(join(root, "engine.db"), { readOnly: true })
    try {
      const consent = database.prepare(`SELECT COUNT(*) AS count FROM flows_journal
        WHERE run_id = ? AND event_type = 'flows.engine.run-decision'
        AND json_extract(payload_json, '$.decision') = 'wake-scheduled'
        AND json_extract(payload_json, '$.reason') = 'operator'`).get(runId)
      expect(consent).toEqual({ count: 0 })
    } finally {
      database.close()
    }
  }, 120_000)

  it("replays a corrupted succeeded attempt, parks both records, then recovers its saved outcome", async () => {
    const root = makeRoot()
    let dispatches = 0
    let corrupt = false
    const sealed = Action.make({
      name: "AgentSession/quarantine-sealed",
      success: Schema.String,
      tier: "sealed",
      idempotencyKey: "quarantine-v1",
      metadata: { readSet: [], writeSet: ["dist/manifest.json"], boundaryMode: "hard" },
      execute: Effect.sync(() => {
        dispatches++
        return "saved outcome"
      })
    })
    const boundary = Layer.succeed(
      StepBoundary.StepBoundary,
      StepBoundary.make({
        prepare: (descriptor) => Effect.succeed({ descriptor, readSnapshot: StepBoundary.exactReads(descriptor) }),
        settle: () =>
          Effect.succeed({
            declaredOutputs: { paths: ["dist/manifest.json"] },
            diffIdentity: "quarantine-diff",
            wholeTreeWritesVerified: true
          }),
        replayOutputs: () =>
          corrupt
            ? Effect.fail(
              new StepBoundary.BoundaryCorruption({
                code: "boundary_corruption",
                path: "dist/manifest.json",
                recordedDigest: "aa".repeat(32),
                measuredDigest: "bb".repeat(32)
              })
            )
            : Effect.void
      })
    )
    const completed = Stream.make(
      new AgentEvent.TransitionApplied({
        eventType: "flows.harness.transition-applied.v1",
        transition: new Cell.Complete({ output: "saved answer" })
      })
    )
    const agent = Agent.makeNoop({
      run: () =>
        Stream.unwrap(Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          const result = yield* engine.actionExecute(sealed, 1).pipe(Effect.provide(NodeCrypto.layer))
          return result._tag === "Complete" && Exit.isFailure(result.exit)
            ? Stream.die(Cause.squash(result.exit.cause))
            : completed
        }))
    })
    const options = { agent, boundary, adoptsAtOnce: true }
    const runId = await Effect.runPromise(
      Effect.gen(function*() {
        const id = yield* launch
        const runtime = yield* ControlRuntime.ControlRuntime
        yield* awaitStatus(runtime, id, "completed")
        return id
      }).pipe(Effect.provide(host(root, hostOwner, "quarantine-first", options)), Effect.scoped, Effect.orDie)
    )
    expect(dispatches).toBe(1)
    const engineDb = new DatabaseSync(join(root, "engine.db"))
    try {
      engineDb.prepare(`UPDATE flows_runs SET status = 'suspended', waiting_reason = 'released',
        finished_at_ms = NULL, owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL,
        heartbeat_at_ms = NULL, claim_host_id = NULL, claim_pid = NULL, claim_nonce = NULL,
        claimed_at_ms = NULL, state_json = json_remove(state_json, '$.result') WHERE run_id = ?`).run(runId)
      engineDb.prepare("DELETE FROM flows_step_cache").run()
    } finally {
      engineDb.close()
    }
    const controlDb = new DatabaseSync(join(root, "control.db"))
    try {
      controlDb.prepare(`UPDATE flows_runs SET status = 'suspended', waiting_reason = 'event',
        finished_at_ms = NULL, owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL,
        heartbeat_at_ms = NULL, claim_host_id = NULL, claim_pid = NULL, claim_nonce = NULL,
        claimed_at_ms = NULL, state_json = json_set(state_json, '$.status', 'parked') WHERE run_id = ?`).run(runId)
    } finally {
      controlDb.close()
    }
    corrupt = true
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const runtime = yield* ControlRuntime.ControlRuntime
        yield* control.resume({ runId, idempotencyKey: `replay:${runId}` })
        yield* awaitStatus(runtime, runId, "parked")
        yield* awaitQuarantine(root, runId)
      }).pipe(
        Effect.provide(host(root, secondOwner, "quarantine-replay", options)),
        Effect.scoped,
        Effect.orDie
      )
    )
    expect(readEngineRun(root, runId)?.waiting_reason).toBe("quarantine")
    expect(dispatches).toBe(1)

    const background = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        yield* runtime.requestResume(runId)
        yield* Effect.sleep("1200 millis")
        return {
          status: (yield* runtime.getRun(runId)).status,
          pending: (yield* runtime.pendingResumes).filter((entry) => entry.runId === runId)
        }
      }).pipe(
        Effect.provide(host(root, secondOwner, "quarantine-background", { ...options, adoptsAtOnce: true })),
        Effect.scoped,
        Effect.orDie
      )
    )
    expect(background.status).toBe("parked")
    expect(background.pending).toHaveLength(1)
    expect(readEngineRun(root, runId)?.waiting_reason).toBe("quarantine")
    expect(dispatches).toBe(1)

    const recovered = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const runtime = yield* ControlRuntime.ControlRuntime
        const receipt = yield* control.resume({ runId, idempotencyKey: `recover:${runId}` })
        yield* awaitStatus(runtime, runId, "completed")
        const repeated = yield* control.resume({ runId, idempotencyKey: `recover:${runId}` })
        return { receipt, repeated, status: (yield* runtime.getRun(runId)).status }
      }).pipe(
        Effect.provide(host(root, secondOwner, "quarantine-recover", options)),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(recovered.receipt._tag).toBe("Accepted")
    expect(recovered.repeated).toEqual({ _tag: "Terminal", runId, status: "completed" })
    expect(recovered.status).toBe("completed")
    expect(readEngineRun(root, runId)?.status).toBe("completed")
    expect(dispatches).toBe(1)
  }, 120_000)

  it("cancels a quarantined agent run through Control", async () => {
    const root = makeRoot()
    const corruption = new AttemptEvidenceQuarantined({
      code: "attempt_evidence_quarantined",
      keyDigest: "saved-key",
      attempt: 1,
      path: "/saved.txt",
      recordedDigest: "original",
      measuredDigest: "corrupt"
    })
    const agent = Agent.makeNoop({ run: () => Stream.die(corruption) })
    const runId = await Effect.runPromise(
      Effect.gen(function*() {
        const id = yield* launch
        const runtime = yield* ControlRuntime.ControlRuntime
        yield* awaitStatus(runtime, id, "parked")
        yield* awaitQuarantine(root, id)
        return id
      }).pipe(Effect.provide(host(root, hostOwner, "quarantine-cancel-first", { agent })), Effect.scoped, Effect.orDie)
    )

    const cancelled = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const runtime = yield* ControlRuntime.ControlRuntime
        const receipt = yield* control.cancel({ runId, idempotencyKey: `cancel:${runId}` })
        return { receipt, status: (yield* runtime.getRun(runId)).status }
      }).pipe(
        Effect.provide(host(root, secondOwner, "quarantine-cancel-second", { agent, adoptsAtOnce: true })),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(cancelled.receipt).toEqual({ _tag: "Terminal", runId, status: "cancelled" })
    expect(cancelled.status).toBe("cancelled")
    expect(readEngineRun(root, runId)?.status).toBe("cancelled")
  }, 120_000)
})

describe("a run parked on a durable timer when its process exits", () => {
  it("stays suspended on `timer` with its deadline still pending, and is never cancelled", async () => {
    frame = timerFrame
    const root = makeRoot()
    // One process's worth of lifetime: launch, park, exit.
    const runId = await Effect.runPromise(
      Effect.gen(function*() {
        const id = yield* launch
        yield* awaitParkEvent(id, "parked")
        return id
      }).pipe(Effect.provide(host(root, hostOwner)), Effect.scoped, Effect.orDie)
    )

    const row = await settledEngineRow(root, runId)

    expect(row?.status).toBe("suspended")
    expect(row?.waiting_reason).toBe("timer")
    expect(row?.cancel_requested_at_ms).toBeNull()
    // The wait was 150 seconds; nothing may complete that deadline early.
    expect(readPendingClocks(root, runId)).toHaveLength(1)
    expect(readInterruptOutcomes(root, runId)).not.toContain("cancelled")
  }, 120_000)
})

describe("a run parked on an in-run ask when its process exits", () => {
  it("stays suspended on `approval`, and is never cancelled", async () => {
    frame = askFrame
    const root = makeRoot()
    const runId = await Effect.runPromise(
      Effect.gen(function*() {
        const id = yield* launch
        yield* awaitParkEvent(id, "waiting-approval")
        return id
      }).pipe(Effect.provide(host(root, hostOwner)), Effect.scoped, Effect.orDie)
    )

    const row = await settledEngineRow(root, runId)

    expect(row?.status).toBe("suspended")
    expect(row?.waiting_reason).toBe("approval")
    expect(row?.cancel_requested_at_ms).toBeNull()
    expect(readInterruptOutcomes(root, runId)).not.toContain("cancelled")
  }, 120_000)
})

describe("a run still executing when its process shuts down", () => {
  it("is released for reclaim rather than cancelled", async () => {
    frame = busyFrame
    const root = makeRoot()
    const runId = await Effect.runPromise(
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const held = yield* Deferred.make<void>()
        noteEntered = entered
        holdNote = held
        const id = yield* launch
        // Mid-execution, inside a cell call the handler is holding open.
        yield* Deferred.await(entered)
        return id
      }).pipe(Effect.provide(host(root, hostOwner)), Effect.scoped, Effect.orDie)
    )

    const row = await settledEngineRow(root, runId)

    // the release policy: one cancellation path, and shutdown is not it.
    expect(row?.status).not.toBe("cancelled")
    expect(row?.cancel_requested_at_ms).toBeNull()
    expect(row?.waiting_reason).toBe("released")
    expect(readInterruptOutcomes(root, runId)).not.toContain("cancelled")
  }, 120_000)
})

/** The exit condition `packages/smithers/src/Command.ts` `settled` waits on. */
const settledKind = (kind: string): boolean =>
  kind === "control.run.waiting-approval" ||
  kind === "control.run.pending" ||
  kind === "control.run.completed" ||
  kind === "control.run.failed" ||
  kind === "control.run.cancelled"

describe("a running process whose run is cancelled from another one", () => {
  it("is told the run settled, so it has something to stop waiting for", async () => {
    frame = busyFrame
    const root = makeRoot()
    const kinds = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const entered = yield* Deferred.make<void>()
        const held = yield* Deferred.make<void>()
        noteEntered = entered
        holdNote = held
        const runId = yield* launch
        // Mid-execution: the detached `smithers run` process is holding its
        // executor open and waiting for this run's journal to say it has
        // nothing left to drive.
        yield* Deferred.await(entered)
        // A second process over the same two files cancels it. One host id and
        // one pid, which is what two local `smithers` processes are to the
        // store (`SqlControlRuntime` compares host and pid).
        yield* Effect.promise(() =>
          Effect.runPromise(
            Effect.gen(function*() {
              const peer = yield* Control.Control
              yield* peer.cancel({ runId, idempotencyKey: `cli:cancel:${runId}` })
            }).pipe(
              Effect.provide(host(root, hostOwner, "engine-park-canceller")),
              Effect.scoped,
              Effect.orDie
            )
          )
        )
        yield* Deferred.succeed(held, void 0)
        const events = yield* Stream.runCollect(control.watch({ runId, follow: false }))
        return events.map((event) => event.kind)
      }).pipe(Effect.provide(host(root, hostOwner)), Effect.scoped, Effect.orDie)
    )

    expect(kinds.filter(settledKind)).toContain("control.run.cancelled")
  }, 120_000)
})

describe("a parked run resumed by a later process", () => {
  it("continues the ask-parked run to completion when a second process approves", async () => {
    frame = askFrame
    const root = makeRoot()
    const parked = await Effect.runPromise(
      Effect.gen(function*() {
        const id = yield* launch
        const approval = yield* askPayload(id)
        yield* awaitParkEvent(id, "waiting-approval")
        return { runId: id, approval }
      }).pipe(Effect.provide(host(root, hostOwner)), Effect.scoped, Effect.orDie)
    )

    // A second process over the same two files: it approves and drives.
    const settled = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const runtime = yield* ControlRuntime.ControlRuntime
        yield* control.approve(parked.approval)
        // The bound is `Ownership.heartbeatStaleAfter` (30 s) plus one
        // delegation poll: a composition that did not park the run may only
        // adopt a delegation that has stood unanswered that long
        // (`AgentSession.hostsPark`). 90 s of headroom, so a slow machine is
        // not read as a wedge.
        yield* awaitStatus(runtime, parked.runId, "completed", 9_000)
        return yield* runtime.getRun(parked.runId)
      }).pipe(
        Effect.provide(host(root, secondOwner, "engine-park-second")),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(settled.status).toBe("completed")
    expect(notes).toContain("engine-park-second:decision=true")
  }, 180_000)
})

describe("a run parked on an in-run ask that a fresh host re-enters unasked", () => {
  /**
   * An unrequested round re-parks the run, and the park must keep the wait's
   * token and question. The engine clears the waiting columns when it
   * activates the round, so a host that did not take the park has only the
   * durable approval facts to re-declare it from. Before this, the re-park in
   * a second composition wrote `approval` with a null token and question: the
   * inbox kept a gate it could no longer name or answer.
   */
  it("re-parks on the same approval token and question, still suspended", async () => {
    frame = askFrame
    const root = makeRoot()
    const runId = await Effect.runPromise(
      Effect.gen(function*() {
        const id = yield* launch
        yield* awaitParkEvent(id, "waiting-approval")
        return id
      }).pipe(Effect.provide(host(root, hostOwner)), Effect.scoped, Effect.orDie)
    )
    const parked = await settledEngineRow(root, runId)
    expect(parked?.status).toBe("suspended")
    expect(parked?.waiting_reason).toBe("approval")
    expect(parked?.waiting_token).toMatch(/^ask\//)
    expect(JSON.parse(parked?.waiting_request ?? "null")).toEqual({ question: "park here?" })

    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const engine = yield* FlowRuntime.FlowRuntime
        const runtime = yield* ControlRuntime.ControlRuntime
        expect((yield* runtime.pendingResumes).filter((entry) => entry.runId === runId)).toEqual([])
        const before = countEngineEvents(root, runId)
        yield* engine.resume(AgentSession.agentFlow, runId)
        // The round's activation and its re-park each commit with their own
        // engine journal records, so a suspended row with more records than
        // before is the re-park, never the first host's row.
        let row = readEngineRun(root, runId)
        for (let attempt = 0; attempt < 1_500; attempt++) {
          row = readEngineRun(root, runId)
          if (countEngineEvents(root, runId) > before && row?.status === "suspended" && row.owner_host_id === null) {
            break
          }
          yield* Effect.sleep("20 millis")
        }
        expect(countEngineEvents(root, runId)).toBeGreaterThan(before)
        return { row, run: yield* runtime.getRun(runId) }
      }).pipe(
        Effect.provide(host(root, secondOwner, "engine-park-second")),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(observed.row?.status).toBe("suspended")
    expect(observed.row?.waiting_reason).toBe("approval")
    expect(observed.row?.waiting_token).toBe(parked?.waiting_token)
    expect(observed.row?.waiting_request).toBe(parked?.waiting_request)
    expect(observed.run.status).toBe("waiting-approval")
    expect(notes).toEqual([])
  }, 120_000)
})

/**
 * Reads the engine row until it settles, or gives up.
 *
 * A cancel against a parked run is durable on the engine row the moment the
 * control mutation commits; the row itself is finalized by the engine's own
 * parked-run sweep, which every composition holding `engine.db` ticks once per
 * `Ownership.heartbeatInterval`. So the bound is one tick of whatever engine is
 * alive, not an unbounded wait, and this reads for thirty of them.
 */
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

describe("a run parked on a durable clock that fell due while its process was down", () => {
  /**
   * The wake nobody asks for: a timer fires, and the only thing that knows
   * the run is runnable again is the engine.
   *
   * A restart is what makes it the whole story. The parking process is gone,
   * so no in-memory wake survives; a second composition arms the deadline it
   * finds on disk, the fire completes the durable wait, and the round the
   * engine schedules next is the one the executor's park guard sees. Without
   * the engine recording that request the guard reads it as its own heartbeat
   * sweep, refuses it, and the run sleeps forever — which is every
   * `flows/repository` job, because `AwaitReply` sleeps its remaining budget
   * on the durable clock while it waits for an author.
   *
   * The deadline is moved to the past between the two processes rather than
   * waited out, so nothing here is timing.
   */
  it("wakes and completes under a second process", async () => {
    frame = timerFrame
    const root = makeRoot()
    const runId = await Effect.runPromise(
      Effect.gen(function*() {
        const id = yield* launch
        yield* awaitParkEvent(id, "parked")
        return id
      }).pipe(Effect.provide(host(root, hostOwner)), Effect.scoped, Effect.orDie)
    )

    expect(readEngineRun(root, runId)?.waiting_reason).toBe("timer")
    expect(readPendingClocks(root, runId)).toHaveLength(1)
    expireClocks(root, runId)

    const settled = await Effect.runPromise(
      Effect.gen(function*() {
        const runtime = yield* ControlRuntime.ControlRuntime
        yield* awaitStatus(runtime, runId, "completed", 3_000)
        return yield* runtime.getRun(runId)
      }).pipe(
        Effect.provide(host(root, secondOwner, "engine-park-second", { adoptsAtOnce: true })),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(settled.status).toBe("completed")
    expect(notes).toContain("engine-park-second:woke")
  }, 120_000)
})

describe("a run parked on an in-run ask that a later process cancels", () => {
  it("settles both rows and answers the ask with the run's terminal status", async () => {
    frame = askFrame
    const root = makeRoot()
    // One process's worth of lifetime: launch, park on the ask, exit.
    const parked = await Effect.runPromise(
      Effect.gen(function*() {
        const id = yield* launch
        const approval = yield* askPayload(id)
        yield* awaitParkEvent(id, "waiting-approval")
        return { runId: id, approval }
      }).pipe(Effect.provide(host(root, hostOwner)), Effect.scoped, Effect.orDie)
    )

    // A second process over the same two files, which is what `smithers
    // cancel` and `smithers approve` are to the run they name.
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const runtime = yield* ControlRuntime.ControlRuntime
        const cancelled = yield* control.cancel({
          runId: parked.runId,
          idempotencyKey: `cli:cancel:${parked.runId}`
        })
        // Read at once, not polled: the cancelling process drives the park it
        // just recorded a cancellation for, so both rows are settled by the
        // time the call returns. The smoke's engine row was still `suspended`
        // fifteen seconds and six commands later, which is what let `gc` skip
        // the run in `engine.db` while collecting it in `control.db`.
        const engineRow = readEngineRun(root, parked.runId)
        // The operator answers the ask afterwards, which is the release
        // smoke's own sequence. It hung for 120 s and printed nothing.
        const decided = yield* control.approve(parked.approval).pipe(Effect.timeout("15 seconds"))
        const events = yield* Stream.runCollect(control.watch({ runId: parked.runId, follow: false }))
        return {
          cancelled,
          decided,
          engineRow,
          summary: yield* runtime.getRun(parked.runId),
          kinds: events.map((event) => event.kind)
        }
      }).pipe(
        Effect.provide(host(root, secondOwner, "engine-park-canceller")),
        Effect.scoped,
        Effect.orDie
      )
    )

    // release policy 5.1: a cancel reaches a terminal state, and both
    // `flows_runs` tables agree about which one.
    expect(observed.cancelled).toEqual({ _tag: "Terminal", runId: parked.runId, status: "cancelled" })
    expect(observed.summary.status).toBe("cancelled")
    expect(observed.engineRow?.status).toBe("cancelled")
    expect(observed.engineRow?.cancel_requested_at_ms).not.toBeNull()
    // The event `smithers run` waits on, and the one `gc` needs to collect the
    // run: without it the smoke left two permanently non-terminal rows.
    expect(observed.kinds.filter(settledKind)).toContain("control.run.cancelled")
    // And the decision answers the run instead of blocking on it.
    expect(observed.decided).toEqual({ _tag: "Terminal", runId: parked.runId, status: "cancelled" })
  }, 180_000)
})
