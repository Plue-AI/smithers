import * as DatabaseMigrations from "@smthrs/database/Migrations"
/**
 * What a failed agent run leaves on disk for the next process to find.
 *
 * release validation ran the rc.0 CLI against a provider seat with no
 * credits. Every failure logged `engine-store: coordinated drain failed for
 * run-1 SchemaError: Expected JSON value at ["exit"]["cause"][0]["error"]`,
 * because `agent/run` declares both result channels `Schema.Unknown` and the
 * exit cause carried a `HarnessError` — a class instance, which
 * `Schema.Json` rejects. The drain died before the terminal transition, so
 * `.flows/control.db` `flows_runs` said `failed` while `.flows/engine.db`
 * `flows_runs` said `running` under a pid that had exited. Eighty-six seconds
 * later the next CLI process's stale-running sweep stole `run-1`, journaled
 * `stolen-and-activated`, `discipline-armed` and `turn-opened` for it, and
 * called the OpenAI seat again for a run the control plane had closed.
 *
 * The release policy allows one terminal write per run, and the release
 * promises a settled run is never re-executed. This is that pin: two
 * compositions over one pair of real SQLite files, the first composition's
 * scope CLOSING between them, a seat that counts every call, and a failure
 * whose cause is exactly the shape the codec rejects.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { Control, ControlLive, ControlRuntime, type ControlSchema, SqlControlRuntime } from "@smthrs/control"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Jj from "@smthrs/jj"
import { Migrations, SqlJournal } from "@smthrs/journal"
import * as Model from "@smthrs/model/Model"
import * as ModelError from "@smthrs/model/ModelError"
import type * as Route from "@smthrs/model/Route"
import { NotificationQueue } from "@smthrs/notifications"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Registry from "@smthrs/registry/Registry"
import { Migrations as RunStoreMigrations, type Ownership, RunStore } from "@smthrs/run-store"
import { Effect, Layer, Option, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import * as AgentSession from "../src/AgentSession.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Seat from "../src/Seat.ts"
import * as SeatResolver from "../src/SeatResolver.ts"
import * as Safety from "./Safety.ts"

const prepared: Route.PreparedRequest = {
  routeId: "route-a",
  protocolId: "test-protocol",
  method: "POST",
  url: "https://example.invalid/v1/responses",
  publicHeaders: { "content-type": "application/json" },
  body: new TextEncoder().encode("{}"),
  bodyText: "{}"
}

const route: FlowEngineLike.RouteResolver = { prepare: () => Effect.succeed(prepared) }

const envelope: ControlSchema.Envelope = { capabilities: [], flows: [], budget: {} }

const agentDescriptor = new Descriptor.FlowDescriptor({
  name: "agents/broke",
  description: "The agent whose seat has no credits.",
  body: new Descriptor.BodyRefMarkdown({
    path: "/flows/agents/broke/flow.md",
    baseDirectory: "/flows/agents/broke",
    contentDigest: "a".repeat(64)
  }),
  input: new Descriptor.SchemaRefNone(),
  output: new Descriptor.SchemaRefNone(),
  model: Option.some("openai:test-model"),
  flows: [],
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
  placement: Option.none(),
  modelInvocable: false,
  path: "/flows/agents/broke",
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
        new Descriptor.FlowBodyPrompt({ text: "Spend money you do not have.", baseDirectory: "/flows/agents/broke" })
      )
  })
)

const controlFlows: ReadonlyArray<ControlRuntime.MemoryFlow> = [
  {
    flowId: "agents/broke",
    executionDigest: Descriptor.executionDigest(agentDescriptor),
    description: "The agent whose seat has no credits.",
    deployClass: false,
    envelope
  }
]

/** Every model call any composition in this file makes, in order. */
const calls: Array<string> = []

/**
 * A provider seat that rejects the request. The
 * failure travels up as a `HarnessError` wrapping this `ModelError`, which is
 * the class instance `Schema.Json` refuses to encode.
 */
const scripted = (host: string): Model.Model =>
  Model.make({
    stream: () =>
      Stream.unwrap(Effect.sync(() => {
        calls.push(host)
        return Stream.fail(
          new ModelError.ModelError({ code: "quota_exceeded", message: "You have no credits remaining" })
        )
      }))
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
  snapshot: () => Effect.succeed({ commitId: "failed-persist", changeId: "failed-persist" }),
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
 * One process's worth of composition over one `.flows` directory, exactly as
 * `NodeControl` composes them. `isAlive: () => false` is what a re-boot sees
 * of a pid that has exited.
 */
const host = (root: string, owner: Ownership.OwnerId, engineHost: string) => {
  const registration = AgentSession.layer({
    quotaPolicy: Safety.quotaPolicy,
    budget: Safety.budget,
    flows: [],
    limits: { memoryBytes: 64 * 1024 * 1024, steps: 5_000_000 },
    maxFrames: 4
  }).pipe(
    Layer.provide(
      Layer.merge(Agent.layer, SeatResolver.layer({ resolve: seatFor(engineHost) })).pipe(
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
  calls.length = 0
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

const makeRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "flows-failed-persist-"))
  roots.add(root)
  return root
}

interface RunRow {
  readonly status: string
  readonly finished_at_ms: number | null
  readonly owner_pid: number | null
  readonly state_json: string
}

const readRun = (root: string, database: string, runId: string): RunRow | undefined => {
  const handle = new DatabaseSync(join(root, database), { readOnly: true })
  try {
    return handle.prepare(
      "SELECT status, finished_at_ms, owner_pid, state_json FROM flows_runs WHERE run_id = ?"
    ).get(runId) as unknown as RunRow | undefined
  } finally {
    handle.close()
  }
}

/** Every run decision the engine journal holds for a run, in order. */
const readDecisions = (root: string, runId: string): ReadonlyArray<string> => {
  const handle = new DatabaseSync(join(root, "engine.db"), { readOnly: true })
  try {
    const rows = handle.prepare(
      "SELECT payload_json FROM flows_journal_events WHERE run_id = ? AND event_type = 'flows.engine.run-decision' ORDER BY seq"
    ).all(runId) as unknown as ReadonlyArray<{ readonly payload_json: string }>
    return rows.map((row) => String((JSON.parse(row.payload_json) as { decision?: unknown }).decision))
  } finally {
    handle.close()
  }
}

/** How many times the control journal recorded a turn opening for a run. */
const countTurns = (root: string, runId: string): number => {
  const handle = new DatabaseSync(join(root, "control.db"), { readOnly: true })
  try {
    const row = handle.prepare(
      "SELECT COUNT(*) AS turns FROM flows_journal_events WHERE run_id = ? AND event_type = 'control.agent.turn-opened'"
    ).get(runId) as unknown as { readonly turns: number }
    return row.turns
  } finally {
    handle.close()
  }
}

/**
 * Ages every engine heartbeat past `Ownership.heartbeatStaleAfter`.
 *
 * The second process must see the first owner's heartbeat as stale enough to
 * steal. This writes that fact directly, so the pin costs one sweep tick instead
 * of half a minute of wall clock.
 */
const ageHeartbeats = (root: string): void => {
  const handle = new DatabaseSync(join(root, "engine.db"))
  try {
    handle.prepare("UPDATE flows_runs SET heartbeat_at_ms = ? WHERE status = 'running'").run(Date.now() - 120_000)
  } finally {
    handle.close()
  }
}

const firstOwner: Ownership.OwnerId = { hostId: "failed-persist-first", pid: 1, nonce: "first" }

const secondOwner: Ownership.OwnerId = { hostId: "failed-persist-second", pid: 2, nonce: "second" }

const launch = Effect.gen(function*() {
  const control = yield* Control.Control
  const card = yield* control.plan({ flowId: "agents/broke", input: {} })
  yield* control.approve(card.approval)
  const receipt = yield* control.run({
    _tag: "Plan",
    planId: card.planId,
    digest: card.digest,
    envelope: card.envelope,
    idempotencyKey: "run:broke"
  })
  if (receipt._tag !== "Accepted" || receipt.runId === undefined) {
    return yield* Effect.die("expected an accepted run")
  }
  return receipt.runId
})

/**
 * Waits, inside the still-open first composition, for the engine row to reach
 * a terminal status.
 *
 * The control settlement and the engine's terminal transition are two writes,
 * and the CLI returns on the first of them. A drain that dies on the encode
 * never reaches the second, so this bounded read is what separates "the engine
 * settled the run" from "the engine abandoned it `running`".
 */
const awaitEngineTerminal = (root: string, runId: string, ticks = 100) =>
  Effect.gen(function*() {
    for (let tick = 0; tick < ticks; tick++) {
      const status = readRun(root, "engine.db", runId)?.status
      if (status === "failed" || status === "completed" || status === "cancelled") return
      yield* Effect.sleep("100 millis")
    }
  })

/** The settlement event `packages/smithers/src/Command.ts` waits on. */
const awaitFailure = (runId: string) =>
  Effect.gen(function*() {
    const control = yield* Control.Control
    yield* control.watch({ runId }).pipe(
      Stream.filter((event) => event.kind === "control.run.failed" || event.kind === "control.run.cancelled"),
      Stream.take(1),
      Stream.runCollect
    )
  })

/**
 * Holds a second composition open over the same files for long enough that its
 * stale-running sweep — which ticks once per `Ownership.heartbeatInterval` —
 * has every chance to steal the run, and stops early the moment it does.
 */
const watchForTheft = (root: string, runId: string, ticks = 80) =>
  Effect.gen(function*() {
    for (let tick = 0; tick < ticks; tick++) {
      if (readDecisions(root, runId).includes("stolen-and-activated")) return
      yield* Effect.sleep("100 millis")
    }
  })

describe("an agent run whose seat rejects the call", () => {
  /**
   * Restated in the cli-boot-hygiene lane. It used to assert the settlement
   * arrived as `flows/engine-store/UnencodableResult`, the projection
   * `engine-store` degrades a settlement into when the flow's own codec
   * rejects it — and announces in a second WARN stack beside the run's own
   * `An agent run failed` (release validation observation N1). `agent/run` now
   * renders its failure to a plain JSON object before the engine persists it,
   * so the settlement encodes, the row carries the tagged refusal instead of a
   * projection or a stack string, and one refusal prints one warning. The
   * assertion this test exists for is unchanged: the reason the run failed is
   * on the row rather than lost with the drain.
   */
  it("is recorded failed in the engine store, with the refusal itself on the row", async () => {
    const root = makeRoot()

    const runId = await Effect.runPromise(
      Effect.gen(function*() {
        const id = yield* launch
        yield* awaitFailure(id)
        yield* awaitEngineTerminal(root, id)
        return id
      }).pipe(Effect.provide(host(root, firstOwner, "failed-persist-first")), Effect.scoped, Effect.orDie)
    )

    const engineRow = readRun(root, "engine.db", runId)
    const controlRow = readRun(root, "control.db", runId)

    // The whole finding: both stores agree, and the engine row is terminal.
    expect(engineRow?.status).toBe("failed")
    expect(engineRow?.finished_at_ms).not.toBeNull()
    expect(engineRow?.owner_pid).toBeNull()
    expect(controlRow?.status).toBe("failed")
    // And the reason is on the row rather than lost with the drain.
    const state = JSON.parse(engineRow?.state_json ?? "{}") as {
      result?: { exit?: { cause?: ReadonlyArray<Record<string, unknown>> } }
    }
    const failure = state.result?.exit?.cause?.[0]
    expect(failure?.["_tag"]).toBe("Fail")
    expect(failure?.["error"]).toMatchObject({ _tag: "/harness/HarnessError" })
    expect(JSON.stringify(failure?.["error"])).toContain("You have no credits remaining")
    // The projection is gone, and so is the second warning that announced it.
    expect(JSON.stringify(state)).not.toContain("flows/engine-store/UnencodableResult")
  }, 120_000)

  it("is never stolen, re-opened, or re-billed by the next process over the same `.flows`", async () => {
    const root = makeRoot()

    const runId = await Effect.runPromise(
      Effect.gen(function*() {
        const id = yield* launch
        yield* awaitFailure(id)
        yield* awaitEngineTerminal(root, id)
        return id
      }).pipe(Effect.provide(host(root, firstOwner, "failed-persist-first")), Effect.scoped, Effect.orDie)
    )

    expect(calls).toEqual(["failed-persist-first"])
    const turnsAfterFirst = countTurns(root, runId)
    ageHeartbeats(root)

    // A second process over the same two files, which is what the next
    // `smithers up` — or Plue's next `agent-host/turn.ts` — is to this run.
    await Effect.runPromise(
      watchForTheft(root, runId).pipe(
        Effect.provide(host(root, secondOwner, "failed-persist-second")),
        Effect.scoped,
        Effect.orDie
      )
    )

    expect(readDecisions(root, runId)).not.toContain("stolen-and-activated")
    expect(countTurns(root, runId)).toBe(turnsAfterFirst)
    expect(calls).toEqual(["failed-persist-first"])
    expect(readRun(root, "engine.db", runId)?.status).toBe("failed")
  }, 120_000)
})
