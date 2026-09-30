/**
 * The supervisor's memory as the native host composes it: the store and the
 * recall binding `NativeControl` hands every agent session, over a real
 * SQLite file, with the options the host derives from its environment.
 *
 * Nothing here is a hand-bound memory double. The two runs go through
 * `Agent.run` against the layer `SupervisorMemory.layer` builds, which is the
 * layer the executor registration provides, so a recall that is a no-op in
 * production is a no-op here too.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Agent from "@smthrs/agent/Agent"
import * as Budget from "@smthrs/agent/Budget"
import * as FlowEngineLike from "@smthrs/agent/FlowEngineLike"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as Seat from "@smthrs/agent/Seat"
import { FlowEngine } from "@smthrs/engine"
import { Flow, FlowRuntime } from "@smthrs/flow"
import type * as Relevance from "@smthrs/harness/Relevance"
import * as Supervisor from "@smthrs/harness/Supervisor"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as Source from "@smthrs/memory/Source"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import type * as Route from "@smthrs/model/Route"
import { Node } from "@smthrs/plan"
import * as Registry from "@smthrs/registry/Registry"
import { Deferred, Effect, Layer, Logger, Metric, Option, Schema, Scope, Stream } from "effect"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import { platform } from "../src/internal/NodeControlHost.ts"
import * as SupervisorMemory from "../src/internal/SupervisorMemory.ts"

const roots: Array<string> = []
const scratch = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-supervisor-memory-")))
  roots.push(root)
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

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

/** A model that answers each frame with the next cell, the first one prefixed by `prose`. */
const cells = (prose: string, sources: ReadonlyArray<string>, held: Deferred.Deferred<void>): Model.Model => {
  let index = 0
  return Model.make({
    stream: () =>
      Stream.suspend(() => {
        const first = index === 0
        const source = sources[index++] ?? sources.at(-1)!
        const response = Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: `cell-${index}` }),
          ModelEvent.ModelEvent.TextDelta({
            type: "text-delta",
            id: `cell-${index}`,
            text: `${first ? `${prose}\n\n` : ""}\`\`\`cell\n${source}\n\`\`\``
          }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: `cell-${index}` }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
        // Every frame after the first waits for frame 0's reading, so the
        // reading, and the write it decides, happen inside the run.
        return first ? response : Stream.unwrap(Deferred.await(held).pipe(Effect.as(response)))
      })
  })
}

/**
 * A judge that finishes every completion, accepts every sentence the run-end
 * miner offers and keeps every recalled row, recording the rows relevance was
 * asked about and the sentences mined.
 */
const judge = (snapshots: Array<Supervisor.Snapshot>, recalled: Array<Relevance.Item>, mined: Array<string>) =>
  Evaluator.layerScripted((request) => {
    if (Object.hasOwn(request.questions, "unnecessary_0")) {
      const items = (request.state as { readonly items: ReadonlyArray<Relevance.Item> }).items
      recalled.push(...items)
      return Object.fromEntries(items.map((_, index) => [`unnecessary_${index}`, { probability: 0.01 }]))
    }
    if (Object.hasOwn(request.questions, "durable_0")) {
      const items = (request.state as { readonly items: ReadonlyArray<{ readonly text: string }> }).items
      mined.push(...items.map((item) => item.text))
      return Object.fromEntries(
        items.flatMap((
          _,
          index
        ) => [[`durable_${index}`, { probability: 0.99 }], [`issue_${index}`, { probability: 0.01 }]])
      )
    }
    if (!Object.hasOwn(request.questions, "thrashing")) {
      return {
        complete: { probability: 0.99 },
        overclaims: { probability: 0.01 },
        invented: { probability: 0.01 },
        requiresWorkspaceChange: { probability: 0.5 },
        reportsLimitation: { probability: 0 }
      }
    }
    snapshots.push(Schema.decodeUnknownSync(Supervisor.Snapshot)(request.state))
    return Object.fromEntries(
      Object.keys(request.questions).map((key) => [
        key,
        key === "needs_help"
          ? { choice: "none" }
          : ["frustrated", "anxious", "scared", "confused", "confident"].includes(key)
          ? { score: 0 }
          : { probability: key === "on_target" ? 0.99 : 0.01 }
      ])
    )
  })

const runFlow = Flow.make("smithers/test/supervisor-memory", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

/** One agent run, driven as one durable flow execution, over the host's memory. */
const agentRun = (input: {
  readonly session: string
  readonly prose: string
  readonly memory: Layer.Layer<MemoryStore.MemoryStore | import("@smthrs/memory/Recall").Recall>
  readonly supervisor: Agent.Options["supervisor"]
  readonly snapshots: Array<Supervisor.Snapshot>
  readonly recalled?: Array<Relevance.Item>
  readonly mined?: Array<string>
}) =>
  Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const done = yield* Deferred.make<void>()
    const held = yield* Deferred.make<void>()
    const body = Effect.gen(function*() {
      const agent = yield* Agent.Agent
      yield* agent.run({
        session: input.session,
        seat: Seat.make({
          id: "anthropic:test-model",
          modelId: "test-model",
          model: cells(input.prose, ["console.log('observed')", "ctx.done('done')"], held),
          route,
          contextWindowTokens: 0
        }),
        prompt: "make the tox suite pass",
        registry: Registry.makeNoop({
          list: () => Effect.succeed([]),
          visible: () => Effect.succeed([]),
          getOption: () => Effect.succeed(Option.none())
        }),
        supervisor: input.supervisor,
        maxFrames: 3
      }).pipe(
        Stream.runForEach((event) =>
          event._tag === "supervisor-settled" && event.frame === 0
            ? Deferred.succeed(held, undefined)
            : Effect.void
        ),
        Effect.provide(
          Layer.merge(Agent.layerDefaults, judge(input.snapshots, input.recalled ?? [], input.mined ?? []))
        )
      )
    }).pipe(
      Effect.provide(Agent.layer),
      Effect.provide(Layer.merge(Budget.layerUnbounded(), QuotaPolicy.layerUnclassified())),
      Effect.provide(input.memory)
    )
    yield* engine.register(runFlow, () => Effect.ensuring(body, Deferred.succeed(done, undefined))).pipe(
      Scope.provide(scope)
    )
    yield* engine.execute(runFlow, { executionId: `exec-${input.session}`, payload: {}, discard: true })
    yield* Deferred.await(done)
  }).pipe(
    Effect.provide(Layer.mergeAll(FlowEngine.layerMemory, NodeCrypto.layer)),
    Effect.provideService(Metric.MetricRegistry, new Map()),
    Effect.scoped,
    Effect.runPromise
  )

describe("SupervisorMemory", () => {
  it("opening memory selects over the workspace, reads only exact granted banks, and stays within 16 KiB", async () => {
    const root = scratch()
    const requests: Array<Recall.Input> = []
    let judged = 0
    const read = (capabilities: ReadonlyArray<string>) =>
      SupervisorMemory.opening({
        runId: "opening",
        prompt: "release plan",
        history: ["last thread message"],
        capabilities
      }, { root, sealed: false }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, MemoryStore.makeNoop()),
        Effect.provideService(Recall.Recall, {
          recall: (input) =>
            Effect.sync(() => {
              requests.push(input)
              return input.banks.map((bank) => ({ bank, key: bank, score: 1, text: "release plan ".repeat(2000) }))
            })
        }),
        // Every recalled row is needed: nothing is withheld.
        Effect.provide(Evaluator.layerScripted((request) => {
          judged += 1
          return Object.fromEntries(Object.keys(request.questions).map((id) => [id, { probability: 0.05 }]))
        })),
        Effect.provide(NodeServices.layer),
        Effect.runPromise
      )
    const team = await read(["memory:read:global-team", "memory:write:user-will"])
    expect(requests[0]?.banks).toEqual(["global-team"])
    expect(requests[0]?.query).toContain("last thread message")
    expect(team.rows.map((row) => row.key)).toEqual(["fact/global-team/global-team"])
    expect(new TextEncoder().encode(Source.render(team.rows)).length).toBeLessThanOrEqual(16 * 1024)
    expect(judged).toBe(1)
    await read(["memory:*:user-will", "memory:read:global-team"])
    expect(requests[1]?.banks).toEqual(["user-will", "global-team"])
    // A wildcard names no bank, so no facts are read; an empty workspace has no other memory.
    expect((await read(["fs:read:**", "memory:read:*"])).rows).toEqual([])
    expect(requests).toHaveLength(2)
  })

  it("reads the workspace only for a launch that may read it on an unsealed host; otherwise facts alone", async () => {
    const root = scratch()
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "secret.ts"), "export const token = 'workspace secret'\n")
    const read = (capabilities: ReadonlyArray<string>, sealed: boolean) =>
      SupervisorMemory.opening({
        runId: "opening",
        prompt: "fix src/secret.ts",
        history: [],
        capabilities
      }, { root, sealed }).pipe(
        Effect.provideService(MemoryStore.MemoryStore, MemoryStore.makeNoop()),
        Effect.provideService(Recall.Recall, {
          recall: (input) => Effect.succeed(input.banks.map((bank) => ({ bank, key: bank, score: 1, text: "a fact" })))
        }),
        Effect.provide(Evaluator.layerScripted((request) =>
          Object.fromEntries(Object.keys(request.questions).map((id) => [id, { probability: 0.05 }]))
        )),
        Effect.provide(NodeServices.layer),
        Effect.runPromise
      )
    const keys = (declared: Source.Declared) => declared.rows.map((row) => row.key)
    // The prompt names the file, so a launch that may read the workspace opens with it.
    expect(keys(await read(["fs:read:**", "memory:read:global-team"], false))).toEqual([
      "file/src/secret.ts",
      "fact/global-team/global-team"
    ])
    // No fs:read: the granted facts, and not a byte of the named file.
    const unread = await read(["memory:read:global-team"], false)
    expect(keys(unread)).toEqual(["fact/global-team/global-team"])
    expect(Source.render(unread.rows)).not.toContain("workspace secret")
    // fs:read of another tree does not cover this workspace, and neither does
    // one of the workspace alone: the opening holds the grant `memory` itself
    // requires, so it never reads what a later call would be refused.
    for (const tree of ["/elsewhere/**", `${root}/**`]) {
      expect(keys(await read([`fs:read:${tree}`, "memory:read:global-team"], false))).toEqual([
        "fact/global-team/global-team"
      ])
    }
    // A sealed host never opens with its own files, whatever the launch holds.
    expect(keys(await read(["fs:read:**", "memory:read:global-team"], true))).toEqual([
      "fact/global-team/global-team"
    ])
  })

  it("opens with the granted facts and logs the unjudged reading while Jev is unreachable", async () => {
    const root = scratch()
    writeFileSync(join(root, "plan.ts"), "export const plan = 1\n")
    const logs: Array<unknown> = []
    const declared = await SupervisorMemory.opening({
      runId: "opening",
      prompt: "fix plan.ts",
      history: [],
      capabilities: ["fs:read:**", "memory:read:global-team"]
    }, { root, sealed: false }).pipe(
      Effect.provideService(MemoryStore.MemoryStore, MemoryStore.makeNoop()),
      Effect.provideService(Recall.Recall, {
        recall: (input) => Effect.succeed(input.banks.map((bank) => ({ bank, key: bank, score: 1, text: "a fact" })))
      }),
      Effect.provide(
        Evaluator.layerScripted(() =>
          Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "down" }))
        )
      ),
      Effect.provide(NodeServices.layer),
      Effect.provide(
        Logger.layer([Logger.make((entry) => void logs.push(entry.message))], { mergeWithExisting: false })
      ),
      Effect.runPromise
    )
    expect(declared.rows.map((row) => row.key)).toEqual(["file/plan.ts", "fact/global-team/global-team"])
    expect(logs).toEqual([[
      "memory opening unjudged",
      { runId: "opening", reason: "unreachable", detail: Evaluator.unreachableMessage }
    ]])
  })

  it("fails a malformed Jev answer as plain JSON the session can seal, never a schema defect", async () => {
    const root = scratch()
    const failure = await SupervisorMemory.opening({
      runId: "opening",
      prompt: "release plan",
      history: [],
      capabilities: ["memory:read:global-team"]
    }, { root, sealed: false }).pipe(
      Effect.flip,
      Effect.provideService(MemoryStore.MemoryStore, MemoryStore.makeNoop()),
      Effect.provideService(Recall.Recall, {
        recall: (input) => Effect.succeed(input.banks.map((bank) => ({ bank, key: bank, score: 1, text: "plan" })))
      }),
      Effect.provide(Evaluator.layerScripted(() => ({ complete: { probability: 0.99 } }))),
      Effect.provide(NodeServices.layer),
      Effect.runPromise
    )
    expect(failure).toMatchObject({ _tag: "@smthrs/agent/Memory/MemoryFailed", code: "judge_failed" })
    expect(failure).not.toBeInstanceOf(Error)
    expect(JSON.parse(JSON.stringify(failure))).toEqual(failure)
  })

  it("recalls a note run 1 remembered into run 2's snapshot, through the host's memory composition", async () => {
    const root = scratch()
    const environment = { SMITHERS_MEMORY_DB: join(root, "memory", "django.db") }
    // Two workspaces of one repository, the way a wave runs two instances.
    const first = SupervisorMemory.options(environment, join(root, "work-1"))
    const second = SupervisorMemory.options(environment, join(root, "work-2"))
    expect(first).toEqual(second)
    const memory = () =>
      SupervisorMemory.layer({
        environment,
        database: platform.database,
        crypto: platform.crypto
      })
    const sentence = "The repository runs its suite through tox, never pytest directly."
    const mined: Array<string> = []
    await agentRun({ session: "run-1", prose: sentence, memory: memory(), supervisor: first, snapshots: [], mined })
    // Run 1's transcript is mined once, at its end.
    expect(mined).toEqual([sentence])

    const recalled: Array<Relevance.Item> = []
    await agentRun({
      session: "run-2",
      prose: "Looking around first.",
      memory: memory(),
      supervisor: second,
      snapshots: [],
      recalled
    })
    expect(recalled.filter((item) => item.kind === "memory").map((item) => item.text)).toContain(sentence)
  })

  it("names memory per repository, never one global bank, and writes only when the host opted in", () => {
    const root = scratch()
    const one = SupervisorMemory.options({}, join(root, "a"))
    const other = SupervisorMemory.options({}, join(root, "b"))
    expect(one.banks[0]).not.toEqual(other.banks[0])
    expect(one.banks[0]).not.toBe("supervisor")
    expect(one.banks[0]).toMatch(/^project-[0-9a-f]{16}$/)
    expect(one).toEqual({ remember: false, banks: one.banks, stance: "careful" })
    const opted = SupervisorMemory.options({ SMITHERS_MEMORY_DB: join(root, "m.db") }, join(root, "a"))
    expect(opted.remember).toBe(true)
  })

  it("selects the static stance from SMITHERS_SUPERVISOR_STANCE, careful when unset, and refuses any other", () => {
    const root = join(tmpdir(), "stance")
    expect(SupervisorMemory.options({ SMITHERS_SUPERVISOR_STANCE: "paranoid" }, root).stance).toBe("paranoid")
    expect(SupervisorMemory.options({}, root).stance).toBe("careful")
    let refused: unknown
    try {
      SupervisorMemory.options({ SMITHERS_SUPERVISOR_STANCE: "foo" }, root)
    } catch (error) {
      refused = error
    }
    expect(refused).toBeInstanceOf(CliError.UsageError)
    expect(refused).toMatchObject({
      _tag: "/cli/UsageError",
      message: "SMITHERS_SUPERVISOR_STANCE must be careful or paranoid, not \"foo\""
    })
  })

  it("persists every write when two processes write one memory database at once", async () => {
    const root = scratch()
    const file = join(root, "memory", "shared.db")
    const writer = fileURLToPath(new URL("./fixtures/supervisor-memory-writer.ts", import.meta.url))
    const count = 100
    const spawnWriter = (label: string) =>
      new Promise<{ readonly code: number | null; readonly stderr: string }>((resolve) => {
        const child = spawn(process.execPath, ["--no-warnings", writer, file, label, String(count)], {
          stdio: ["ignore", "ignore", "pipe"]
        })
        let stderr = ""
        child.stderr.on("data", (chunk) => stderr += String(chunk))
        child.on("exit", (code) => resolve({ code, stderr }))
      })
    const results = await Promise.all([spawnWriter("left"), spawnWriter("right")])
    expect(results.map((result) => result.stderr)).toEqual(["", ""])
    expect(results.map((result) => result.code)).toEqual([0, 0])
    const rows = await Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      return yield* store.searchRows({
        namespace: { kind: "agent", id: "shared" },
        status: "accepted",
        limit: 1_000
      })
    }).pipe(
      Effect.provide(
        SupervisorMemory.layer({
          environment: { SMITHERS_MEMORY_DB: file },
          database: platform.database,
          crypto: platform.crypto
        })
      ),
      Effect.scoped,
      Effect.runPromise
    )
    expect(rows.map((row) => row.key).sort()).toEqual(
      ["left", "right"].flatMap((label) => Array.from({ length: count }, (_, index) => `${label}-${index}`)).sort()
    )
  }, 60_000)
})
