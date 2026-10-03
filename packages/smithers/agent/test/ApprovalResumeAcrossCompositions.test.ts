import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * An approval decided by a composition that does not host the run.
 *
 * release policy 5.1 promises that `Approve` on a `Node` target resumes the run
 * server-side, so a gateway client does not have to call `Resume` afterwards.
 * `ControlLive.decide` kept that promise by claiming the control row and
 * journaling `control.run.resumed` — and the only consumer of that entry was a
 * `journal.changes` subscription, an in-process `PubSub` that no other journal
 * instance can publish into (`SqlJournal.ts`, the `changes` hub). A decision
 * taken anywhere but inside the process hosting the executor therefore wrote a
 * wake nothing read, and `scope: "launched"` did not stop it: that scope is a
 * `control_runs` lookup, a durable table every process over one
 * `.flows/control.db` shares, so the deciding process TOOK the row from the
 * host that could still drive it (triage B-15).
 *
 * Three compositions over one control database prove all of it. `A` is the
 * host: the real control plane, the production `AgentSession` executor, and
 * the durable engine over its own `engine.db`, exactly as `NodeControl`
 * composes them. `B` is a second control plane over the same file under its
 * own owner identity, with no executor at all — a gateway that runs nothing.
 * `C` is what the shipped CLI actually is: a second control plane that ALSO
 * composes an executor over the SAME `engine.db`, so its engine can see and
 * resume `A`'s parked execution. `B` and `C` decide; `A` has to wake, and the
 * frame has to run on `A`'s engine — the note each composition writes is
 * tagged with the engine that wrote it, so the settled run says which process
 * drove it rather than merely that some process did.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Control, ControlLive, ControlRuntime, ControlSchema, SqlControlRuntime } from "@smthrs/control"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
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
import { Effect, Layer, Option, Schema, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
  name: "agents/notes",
  description: "The notes agent.",
  body: new Descriptor.BodyRefMarkdown({
    path: "/flows/agents/notes/flow.md",
    baseDirectory: "/flows/agents/notes",
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
  path: "/flows/agents/notes",
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
        new Descriptor.FlowBodyPrompt({ text: "Keep the note log tidy.", baseDirectory: "/flows/agents/notes" })
      )
  })
)

const controlFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = [
  {
    flowId: "agents/notes",
    executionDigest: Descriptor.executionDigest(agentDescriptor),
    description: "The notes agent.",
    deployClass: false,
    envelope
  }
]

const noteFlow = {
  capabilities: [],
  name: "note/save",
  description: "Save one line to the run's note log.",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ saved: Schema.Number }),
  effects: { reads: [], writes: ["/notes/**"], mode: "expected", onConflict: "serialize", tier: "irreversible" }
} as const

/**
 * One frame: ask, then write the decision down.
 *
 * The note is the observation that matters. A run that merely leaves
 * `waiting-approval` proves a status write; a note reading `decision=false`
 * proves the resumed frame read the answer the operator actually gave.
 */
const askFrame = `const decision = await ctx.call("ask", { question: "publish the log?", options: ["yes", "no"] })
await ctx.call("note/save", { text: "decision=" + decision.approved })
ctx.done("settled")`

const scripted: Model.Model = Model.make({
  stream: () =>
    Stream.fromIterable([
      ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell-0" }),
      ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell-0", text: "```cell\n" + askFrame + "\n```" }),
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
  snapshot: () => Effect.succeed({ commitId: "approval-resume", changeId: "approval-resume" }),
  restore: () => Effect.void,
  diff: () => Effect.succeed("")
})

/** The control plane's own database: one file, opened once per composition. */
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
 * A composition that hosts executions: control plane, production executor,
 * real engine. `engineHost` names the engine's owner AND tags every note its
 * handler writes, so a note identifies the composition that ran the frame.
 */
const host = (root: string, owner: Ownership.OwnerId, engineHost = "approval-resume-host") => {
  const registration = AgentSession.layer({
    quotaPolicy: Safety.quotaPolicy,
    budget: Safety.budget,
    flows: [
      FlowBinding.source("test/notes", [
        FlowBinding.make({
          flow: noteFlow,
          handler: (input) => Effect.sync(() => (notes.push(`${engineHost}:${input.text}`), { saved: notes.length }))
        })
      ])
    ],
    limits: { memoryBytes: 64 * 1024 * 1024, steps: 5_000_000 },
    maxFrames: 4
  }).pipe(
    Layer.provide(
      Layer.mergeAll(Agent.layer, SeatResolver.layer({ resolve: seat }), scriptedCompletionJudge).pipe(
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

/** Composition B: a second control plane over the same file, hosting nothing. */
const decider = (root: string, owner: Ownership.OwnerId) =>
  ControlLive.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        SqlControlRuntime.layer({ owner, flows: controlFlows }).pipe(Layer.orDie),
        NotificationQueue.layer,
        registryLayer
      )
    ),
    Layer.provideMerge(Layer.merge(controlStores(join(root, "control.db")), NodeCrypto.layer))
  )

const notes: Array<string> = []
const roots = new Set<string>()

afterEach(async () => {
  notes.length = 0
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

/** Polls the control row until it reaches `status`, on a real clock. */
const awaitStatus = (
  runtime: ControlRuntime.Service,
  runId: string,
  status: ControlSchema.RunStatus,
  attempts = 1_500
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    const run = yield* runtime.getRun(runId)
    if (run.status === status) return
    if (attempts <= 0) return yield* Effect.die(`run ${runId} never reached ${status} (still ${run.status})`)
    yield* Effect.sleep("10 millis")
    return yield* awaitStatus(runtime, runId, status, attempts - 1)
  })

const hostOwner: Ownership.OwnerId = { hostId: "approval-resume-host", pid: 1, nonce: "host" }
const deciderOwner: Ownership.OwnerId = { hostId: "approval-resume-decider", pid: 2, nonce: "decider" }

/**
 * Runs one approval decision from `peer`, a composition that is not the host.
 *
 * `peer` is the whole variable: composition B hosts nothing, composition C
 * hosts an executor over the same `engine.db` and can therefore see, claim,
 * and drive `A`'s parked execution — which is exactly what every local
 * `smithers` process can do, since `NodeControl` composes an executor unless
 * `--remote` is passed.
 */
const decide = (
  decision: "approve" | "deny",
  peer: (root: string, owner: Ownership.OwnerId) => Layer.Layer<Control.Control, unknown> = decider
) =>
  Effect.gen(function*() {
    const root = mkdtempSync(join(tmpdir(), "flows-approval-resume-"))
    roots.add(root)
    return yield* Effect.provide(
      Effect.gen(function*() {
        const control = yield* Control.Control
        const runtime = yield* ControlRuntime.ControlRuntime
        const card = yield* control.plan({ flowId: "agents/notes", input: {} })
        yield* control.approve(card.approval)
        const receipt = yield* control.run({
          _tag: "Plan",
          planId: card.planId,
          digest: card.digest,
          envelope: card.envelope,
          idempotencyKey: "run:notes"
        })
        if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
          return yield* Effect.die("expected an accepted run")
        }
        const runId = receipt.runId
        const requested = yield* control.watch({ runId }).pipe(
          Stream.filter((event) => event.kind === "control.approval.requested"),
          Stream.take(1),
          Stream.runCollect
        )
        yield* awaitStatus(runtime, runId, "waiting-approval")
        const parked = yield* runtime.getRun(runId)
        const payload = (requested[0]?.payload as { readonly payload: unknown }).payload
        const approval = Schema.decodeUnknownSync(ControlSchema.ApprovalPayload)(payload)

        // The decision is taken by a composition that hosts no executor: it
        // can record and journal, and it can drive nothing.
        //
        // It runs in its own `runPromise`, not under `Effect.provide` inside
        // this one. Effect carries a layer memo map through the environment,
        // and `ControlLive.layer` is one layer VALUE: provided in place, the
        // decider would have been handed the host's own `Control` instance and
        // the case would have proved nothing. A separate runtime is also what
        // a second process actually is.
        yield* Effect.promise(() =>
          Effect.runPromise(
            Effect.gen(function*() {
              const remote = yield* Control.Control
              return yield* decision === "approve" ? remote.approve(approval) : remote.deny(approval)
            }).pipe(Effect.provide(peer(root, deciderOwner)), Effect.scoped, Effect.orDie)
          )
        )
        const afterDecision = yield* runtime.getRun(runId)

        yield* awaitStatus(runtime, runId, "completed")
        return { runId, parked, afterDecision, settled: yield* runtime.getRun(runId) }
      }),
      host(root, hostOwner)
    )
  }).pipe(Effect.scoped)

interface Observed {
  readonly runId: string
  readonly parked: ControlSchema.RunSummary
  readonly afterDecision: ControlSchema.RunSummary
  readonly settled: ControlSchema.RunSummary
}

describe("an approval decided by a composition that hosts no executor", () => {
  it("wakes the host, which settles the run with the answer that was given", async () => {
    const observed = await Effect.runPromise(decide("approve") as Effect.Effect<Observed>)

    expect(observed.parked.status).toBe("waiting-approval")
    // The decider never took the row. Had it claimed, the host could not have
    // written its own terminal status: `claimFence` requires `ownedByUs`.
    expect(observed.afterDecision.ownerId ?? "").not.toContain("approval-resume-decider")
    expect(observed.settled.status).toBe("completed")
    expect(notes).toEqual(["approval-resume-host:decision=true"])
  }, 60_000)

  it("delivers a denial the same way, and the resumed frame reads it", async () => {
    const observed = await Effect.runPromise(decide("deny") as Effect.Effect<Observed>)

    expect(observed.settled.status).toBe("completed")
    expect(notes).toEqual(["approval-resume-host:decision=false"])
  }, 60_000)
})

describe("an approval decided by a second composition that HOSTS an executor", () => {
  it("leaves the run to the composition that parked it, which drives the frame", async () => {
    const observed = await Effect.runPromise(
      decide("approve", (root, owner) => host(root, owner, "approval-resume-decider")) as Effect.Effect<Observed>
    )

    // The decider's engine can poll the parked execution and resume it —
    // engine visibility is a shared FILE, not a hosting claim — so this is the
    // assertion the claimant design fails: the note carries the engine that
    // ran the resumed frame, and it has to be the one that parked it.
    expect(notes).toEqual(["approval-resume-host:decision=true"])
    // The park names its host durably, so a second executor over the same
    // engine.db can tell that the execution is not its own to take up.
    expect(observed.parked.parkedBy ?? "").toContain("approval-resume-host")
    // The delegation is still standing when the decider's call returns: the
    // host clears it on its own next tick, up to a second later.
    expect(observed.afterDecision.pendingResume).toBeDefined()
    expect(observed.afterDecision.ownerId ?? "").not.toContain("approval-resume-decider")
    expect(observed.settled.status).toBe("completed")
  }, 60_000)

  it("delivers a denial the same way, without ever driving the run itself", async () => {
    const observed = await Effect.runPromise(
      decide("deny", (root, owner) => host(root, owner, "approval-resume-decider")) as Effect.Effect<Observed>
    )

    expect(observed.settled.status).toBe("completed")
    expect(notes).toEqual(["approval-resume-host:decision=false"])
  }, 60_000)
})
