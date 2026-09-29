/**
 * The regression gate for memory and the prompt cache.
 *
 * `memory` enters a run as an ordinary call result, in the append-only tail.
 * If it ever reached the system prompt or rewrote an earlier message, every
 * later request would miss the provider's prompt cache. These cases run the
 * production agent loop (real durable engine, real QuickJS sandbox, real
 * controller) with the memory plugin bound to a real repository, record every
 * model request, and compare their bytes frame by frame. A durable restart
 * then proves the recorded block is served again without asking Jev.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as CoreFlow from "@smthrs/core/Flow"
import { FlowEngine } from "@smthrs/engine"
import { Flow as EngineFlow, FlowRuntime } from "@smthrs/flow"
import type * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as ModelRequest from "@smthrs/model/ModelRequest"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Cause, Deferred, Effect, Exit, Layer, Option, Schema, Scope, Stream } from "effect"
import type * as Crypto from "effect/Crypto"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as Agent from "../src/Agent.ts"
import type * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as Memory from "../src/Memory.ts"
import { layer as scriptedCompletionJudge } from "../src/ScriptedJudge.ts"
import * as Seat from "../src/Seat.ts"
import * as Safety from "./Safety.ts"

// ---------------------------------------------------------------------------
// A real repository
// ---------------------------------------------------------------------------

const scratchDirs: Array<string> = []
let root = ""

beforeAll(() => {
  // The product spawns `jj` and `git` from PATH, as a user's host does.
  for (const name of ["CLAUDECODE", "CODEX_THREAD_ID", "OPENCODE"]) delete process.env[name]
  const config = realpathSync(mkdtempSync(join(tmpdir(), "memory-cache-config-")))
  scratchDirs.push(config)
  writeFileSync(join(config, "jj.toml"), "[user]\nname = \"Memory Test\"\nemail = \"memory@example.com\"\n")
  process.env.JJ_CONFIG = join(config, "jj.toml")
  root = realpathSync(mkdtempSync(join(tmpdir(), "memory-cache-")))
  scratchDirs.push(root)
  const files: Readonly<Record<string, string>> = {
    "README.md": "A small service.",
    "src/a.ts": "export const a = () => \"the answer lives here\"",
    "src/b.ts": "export const b = 2"
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  const jj = (...args: ReadonlyArray<string>) => execFileSync("jj", args, { cwd: root, stdio: "ignore" })
  jj("git", "init", "--colocate")
  jj("describe", "-m", "add the service")
  jj("new")
})

afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// The production run, with a recorded model
// ---------------------------------------------------------------------------

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

/** A recorded model that replies with one cell per frame and keeps every request it was sent. */
const recorded = (requests: Array<ModelRequest.ModelRequest>, cells: ReadonlyArray<string>): Model.Model => {
  let index = 0
  return Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(request)
        const source = cells[index++] ?? cells.at(-1)!
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `cell-${index}` }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: `cell-${index}`,
            text: "```cell\n" + source + "\n```"
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `cell-${index}` }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
}

type Outcome =
  | { readonly _tag: "completed"; readonly value: unknown }
  | { readonly _tag: "failed"; readonly error: unknown }
  | { readonly _tag: "suspended" }

const classify = (exit: Exit.Exit<unknown, unknown>): Outcome =>
  Exit.isSuccess(exit)
    ? { _tag: "completed", value: exit.value }
    : Cause.hasInterruptsOnly(exit.cause)
    ? { _tag: "suspended" }
    : { _tag: "failed", error: Cause.squash(exit.cause) }

const driveFlow = EngineFlow.make("agent/test/memory-prompt-cache", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

const awaitParked = (
  engine: FlowRuntime.FlowRuntime["Service"],
  attempts = 100
): Effect.Effect<void, FlowRuntime.FlowExecutionNotFound> =>
  Effect.gen(function*() {
    const polled = yield* engine.poll(driveFlow, "exec-1")
    if (Option.isSome(polled) && polled.value._tag === "Suspended") return
    if (attempts <= 0) throw new Error("the engine never published the parked execution")
    yield* Effect.yieldNow
    return yield* awaitParked(engine, attempts - 1)
  })

/** Runs one body as one real durable execution; with `resume`, resumes it once after it parks. */
const drive = <A, E>(
  body: Effect.Effect<A, E, Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance>,
  options: { readonly resume?: boolean; readonly parked?: () => void } = {}
): Promise<ReadonlyArray<Outcome>> =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    let settled = Deferred.makeUnsafe<Outcome>()
    yield* engine.register(driveFlow, () =>
      Effect.onExit(body, (exit) => Effect.asVoid(Deferred.succeed(settled, classify(exit))))).pipe(
        Scope.provide(scope)
      )
    yield* engine.execute(driveFlow, { executionId: "exec-1", payload: {}, discard: true })
    const first = yield* Deferred.await(settled)
    if (options.resume !== true || first._tag !== "suspended") {
      return [first]
    }
    yield* awaitParked(engine)
    options.parked?.()
    settled = Deferred.makeUnsafe<Outcome>()
    yield* engine.resume(driveFlow, "exec-1")
    return [first, yield* Deferred.await(settled)]
  }).pipe(
    Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer)),
    Effect.scoped,
    Effect.runPromise
  )

/** A Jev for the memory flow that keeps src/a.ts and counts its requests. */
const jev = () => {
  let requests = 0
  const layer = Evaluator.layerScripted((request) => {
    requests++
    const items = (request.state as { readonly items: ReadonlyArray<{ readonly id?: string }> }).items
    return Object.fromEntries(
      Object.keys(request.questions).map((id) => {
        const at = id.lastIndexOf("_")
        const item = items[Number(id.slice(at + 1))]!
        return [id, { probability: id.startsWith("descend") || item.id === "src/a.ts" ? 0.9 : 0.05 }]
      })
    )
  })
  return { layer, count: () => requests }
}

/** A sealed no-op flow a cell calls to reach the permission gate. */
const gate = FlowBinding.make({
  flow: CoreFlow.make({
    name: "gate",
    description: "Passes once permission is granted.",
    input: Schema.Struct({}),
    output: Schema.String,
    effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" }
  }),
  handler: () => Effect.succeed("open")
})

const run = (options: {
  /** Made once per test: a resumed execution re-runs this body, and the replayed frames must not rewind the script. */
  readonly model: Model.Model
  readonly evaluator: Layer.Layer<Evaluator.Evaluator>
  readonly authorize?: ((call: Cell.Call) => Effect.Effect<void, HarnessError>) | undefined
}) =>
  Effect.gen(function*() {
    const collected: Array<AgentEvent.AgentEvent> = []
    const services = yield* Effect.provide(
      Effect.context<Memory.Requirements | Evaluator.Evaluator>(),
      Layer.merge(NodeServices.layer, options.evaluator)
    )
    const agent = yield* Agent.Agent
    yield* agent.run({
      session: "session-1",
      seat: Seat.make({
        id: "anthropic:test-model",
        modelId: "test-model",
        model: options.model,
        route,
        contextWindowTokens: 0
      }),
      prompt: "Fix the answer in src/a.ts",
      registry: Registry.makeNoop({}),
      capabilityEnvelope: [new Capability.CapabilityPattern({ action: "*", resource: "*" })],
      flows: [FlowBinding.source("gate", [gate])],
      plugins: [Memory.plugin(services, { root })],
      authorize: options.authorize,
      maxFrames: 4
    }).pipe(
      Stream.runForEach((event) => Effect.sync(() => collected.push(event))),
      Effect.provide(Layer.merge(Agent.layerDefaults, scriptedCompletionJudge))
    )
    return collected
  }).pipe(Effect.provide(Agent.layer), Effect.provide(Safety.layer))

/** Everything a request carries before its tail, as the bytes a provider caches. */
const systemBytes = (request: ModelRequest.ModelRequest): string => JSON.stringify(request.system)
const messageBytes = (message: ModelRequest.ModelRequest["messages"][number]): string => JSON.stringify(message.content)
const textOf = (request: ModelRequest.ModelRequest): string =>
  request.messages.flatMap((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []))
    .join("\n")

const memoryCell =
  "const m = await ctx.call(\"memory\", { task: \"Fix the answer in src/a.ts\" }); console.log(m.context)"

describe("memory and the prompt cache", () => {
  it("only appends: one cache key, a byte-stable system and prefix, the block in the tail", async () => {
    const withMemory: Array<ModelRequest.ModelRequest> = []
    const judge = jev()
    const [outcome] = await drive(run({
      model: recorded(withMemory, [memoryCell, "console.log(\"next\")", "ctx.done(\"done\")"]),
      evaluator: judge.layer
    }))
    expect(outcome?._tag).toBe("completed")
    expect(withMemory).toHaveLength(3)
    expect(judge.count()).toBeGreaterThan(0)

    // One prompt cache for the whole run.
    const keys = withMemory.map((request) => request.cacheKey)
    expect(keys[0]).toMatch(/\S/)
    expect(new Set(keys).size).toBe(1)

    // The block reached the model only as a call result in the tail.
    // The print buffer is untrusted data, so the fence arrives entity-escaped.
    expect(textOf(withMemory[0]!)).not.toContain("smithers_memory")
    expect(textOf(withMemory[1]!)).toContain("&lt;smithers_memory&gt;\nEvidence for this task")
    expect(textOf(withMemory[1]!)).toContain("@@ file src/a.ts @@\nexport const a = () =&gt; \"the answer lives here\"")
    expect(textOf(withMemory[1]!)).not.toContain("src/b.ts @@")
    for (const request of withMemory) expect(systemBytes(request)).not.toContain("smithers_memory")

    // Each request starts with the exact bytes of the one before it.
    for (let frame = 0; frame + 1 < withMemory.length; frame++) {
      const current = withMemory[frame]!
      const next = withMemory[frame + 1]!
      expect(systemBytes(next)).toBe(systemBytes(current))
      expect(next.messages.length).toBeGreaterThan(current.messages.length)
      expect(next.messages.slice(0, current.messages.length).map(messageBytes)).toEqual(
        current.messages.map(messageBytes)
      )
    }

    // The same run without the memory call opens on the same bytes.
    const without: Array<ModelRequest.ModelRequest> = []
    const [plain] = await drive(run({
      model: recorded(without, ["console.log(\"no memory\")", "console.log(\"next\")", "ctx.done(\"done\")"]),
      evaluator: jev().layer
    }))
    expect(plain?._tag).toBe("completed")
    expect(without).toHaveLength(3)
    expect(new Set(without.map((request) => request.cacheKey)).size).toBe(1)
    for (let frame = 0; frame < 3; frame++) {
      expect(systemBytes(without[frame]!)).toBe(systemBytes(withMemory[frame]!))
    }
    expect(without[0]!.messages.map(messageBytes)).toEqual(withMemory[0]!.messages.map(messageBytes))
  })

  it("serves the recorded block on a durable restart without asking Jev again", async () => {
    const requests: Array<ModelRequest.ModelRequest> = []
    const judge = jev()
    let denied = false
    let askedBeforeResume = -1
    const outcomes = await drive(
      run({
        model: recorded(requests, [
          memoryCell,
          "const opened = await ctx.call(\"gate\", {}); console.log(opened)",
          "ctx.done(\"done\")"
        ]),
        evaluator: judge.layer,
        authorize: (call) =>
          Effect.suspend(() => {
            if (call.flowName !== "gate" || denied) return Effect.void
            denied = true
            return Effect.fail(
              new HarnessError({
                code: "engine_failed",
                message: "permission required",
                cause: Schema.encodeUnknownSync(Permission.PermissionRequired)(
                  new Permission.PermissionRequired({
                    requestId: "memory-restart",
                    capability: Capability.make("fs:write", "**"),
                    tier: "irreversible",
                    meta: {}
                  })
                )
              })
            )
          })
      }),
      { resume: true, parked: () => void (askedBeforeResume = judge.count()) }
    )
    expect(outcomes.map((outcome) => outcome._tag)).toEqual(["suspended", "completed"])
    expect(denied).toBe(true)
    const asked = judge.count()
    expect(askedBeforeResume).toBeGreaterThan(0)
    // Every Jev request belongs to the first attempt: the resumed run replayed
    // frame 0's memory call from its record.
    expect(asked).toBe(askedBeforeResume)
    // The replayed frames asked the model nothing new: three frames, three requests.
    expect(requests).toHaveLength(3)
    const block = (text: string) =>
      text.slice(text.indexOf("&lt;smithers_memory&gt;"), text.indexOf("&lt;/smithers_memory&gt;"))
    expect(block(textOf(requests[2]!))).toBe(block(textOf(requests[1]!)))
    expect(block(textOf(requests[2]!))).toContain("the answer lives here")
    expect(new Set(requests.map((request) => request.cacheKey)).size).toBe(1)
    // The resumed execution served frame 0's memory call from its record, so
    // it journaled no new reading; its gate call ran once permission was granted.
    const events = outcomes[1]!._tag === "completed" ? outcomes[1]!.value as ReadonlyArray<AgentEvent.AgentEvent> : []
    expect(
      events.filter((event) => event._tag === "decision-settled" && event.classifier.startsWith("memory/"))
    ).toEqual([])
    expect(events.some((event) => event._tag === "decision-settled")).toBe(true)
    const settledCalls = events.flatMap((event) => event._tag === "cell-call-settled" ? [event.flowName] : [])
    expect(settledCalls).toEqual(["memory", "gate"])
  })
})
