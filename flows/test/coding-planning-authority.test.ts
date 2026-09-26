import { NodeServices } from "@effect/platform-node"
import * as Agent from "@smthrs/agent/Agent"
import * as AgentAction from "@smthrs/agent/AgentAction"
import * as Budget from "@smthrs/agent/Budget"
import * as QuotaPolicy from "@smthrs/agent/QuotaPolicy"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Seat from "@smthrs/agent/Seat"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as CoreFlow from "@smthrs/core/Flow"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as Model from "@smthrs/model/Model"
import { ModelEvent } from "@smthrs/model/ModelEvent"
import * as Registry from "@smthrs/registry/Registry"
import { Context, Effect, FileSystem, Layer, ManagedRuntime, Option, Path, Schema, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import * as FlowBinding from "../../packages/smithers/agent/harness/src/FlowBinding.ts"
import * as Steering from "../../packages/smithers/agent/harness/src/Steering.ts"
import { CapabilityPattern } from "../../packages/smithers/flows/capability/src/Capability.ts"
import { Rule } from "../../packages/smithers/flows/capability/src/Permission.ts"
import * as CapabilitySet from "../../packages/smithers/flows/kernel/src/CapabilitySet.ts"
import * as KernelSpawner from "../../packages/smithers/flows/kernel/src/ChildProcessSpawner.ts"
import * as KernelFileSystem from "../../packages/smithers/flows/kernel/src/FileSystem.ts"
import * as GrantStore from "../../packages/smithers/flows/kernel/src/GrantStore.ts"
import * as Workspace from "../../packages/smithers/flows/kernel/src/Workspace.ts"
import * as AtomicFileSystem from "../../packages/smithers/flows/platform-node/src/AtomicFileSystem.ts"
import { evidenceOnly } from "../coding/planning-authority.ts"

const all = [new CapabilityPattern({ action: "*", resource: "*" })]
const Output = Schema.Struct({
  read: Schema.Boolean,
  write: Schema.Boolean,
  bash: Schema.Boolean,
  visible: Schema.Array(Schema.String),
  probe: Schema.optional(Schema.Array(Schema.Boolean))
})
const declarations = [
  "coding/review-request",
  "coding/draft-plan",
  "coding/select-owner-repair",
  "wiki/review-page",
  "coding/draft-poc",
  "coding/review-poc",
  "coding/review-final-history",
  "coding/edit-atom"
]
  .map((name) => {
    const action = AgentAction.make(name, {
      payload: { evidence: Schema.String },
      output: Output,
      seat: name.endsWith("-poc") ? "coding/poc" : "coding/implement",
      prompt: ({ evidence }) => evidence
    })
    const direct = Flow.make(name, {
      payload: action.payloadSchema,
      success: Output,
      error: AgentAction.AgentFailure,
      body: (input) => action.call(input)
    })
    const interpreted = Flow.make(`test/${name}`, {
      payload: action.payloadSchema,
      success: Output,
      error: AgentAction.AgentFailure,
      body: (input) => action.call(input)
    })
    return { action, direct, interpreted }
  })

const fixture = async (t: TestContext, contributed = false) => {
  const root = await mkdtemp(join(tmpdir(), "coding-planning-authority-"))
  const target = join(root, "target.txt"), marker = join(root, "process.txt")
  await writeFile(target, "captured evidence\n")
  t.after(() => rm(root, { recursive: true, force: true }))
  const requests: string[] = [], seats: string[] = []
  const authorities: Array<{ empty: boolean; envelope: number; budget: Budget.Service; steering: Steering.Source }> = []
  let pluginRequests = 0, nativeProbes = 0
  const model = Model.make({
    stream: (request) =>
      Stream.suspend(() => {
        requests.push(JSON.stringify(request))
        const source = `
      const r = await ctx.call("read", ${JSON.stringify({ path: target })});
      const w = await ctx.call("write", ${JSON.stringify({ path: target, content: "implemented\n" })});
      const b = await ctx.call("bash", ${
          JSON.stringify({ mode: "unhermetic", script: "printf 'ran' > process.txt", cwd: root })
        });
      ${contributed ? "const p = await ctx.call(\"plugin/probe\", {});" : ""}
      ctx.done({ read: r.ok !== false, write: w.ok !== false, bash: b.ok !== false, visible: Object.keys(ctx.flows),
        ${contributed ? "probe: p.ok !== false ? p : []" : ""} });`
        return Stream.fromIterable([
          ModelEvent.TextStart({ type: "text-start", id: "proof" }),
          ModelEvent.TextDelta({ type: "text-delta", id: "proof", text: "```cell\n" + source + "\n```" }),
          ModelEvent.TextEnd({ type: "text-end", id: "proof" }),
          ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })
  const resolved = SeatResolver.layer({
    resolve: (id) => {
      seats.push(id)
      return Effect.succeed(
        Seat.make({
          id,
          modelId: "scripted",
          model,
          contextWindowTokens: 200_000,
          route: {
            prepare: () =>
              Effect.succeed({
                routeId: "test",
                protocolId: "test",
                method: "POST",
                url: "https://example.invalid",
                publicHeaders: {},
                body: new TextEncoder().encode("{}"),
                bodyText: "{}"
              })
          }
        })
      )
    }
  })
  const workspace = Workspace.layer(root)
  const grants = GrantStore.layer({ attended: false, rules: [new Rule({ effect: "allow", pattern: all[0]! })] }).pipe(
    Layer.provide(workspace)
  )
  const platform = Layer.mergeAll(KernelFileSystem.layer, KernelSpawner.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(grants, workspace)),
    Layer.provideMerge(AtomicFileSystem.layer.pipe(Layer.provide(NodeServices.layer))),
    Layer.provideMerge(NodeServices.layer)
  )
  const layer = Layer.unwrap(Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem, path = yield* Path.Path, spawner = yield* ChildProcessSpawner
    const services = Context.make(FileSystem.FileSystem, fs).pipe(
      Context.add(Path.Path, path),
      Context.add(ChildProcessSpawner, spawner)
    )
    const sources = [StandardFlows.filesystem(services), StandardFlows.shell(services)]
    const bindings = (yield* Effect.forEach(sources, (source) => source.bindings())).flat()
    const probe = FlowBinding.make({
      flow: CoreFlow.make({
        name: "plugin/probe",
        description: "Check actual kernel authority.",
        input: Schema.Struct({}),
        output: Schema.Array(Schema.Boolean),
        capabilities: [],
        effects: { reads: [], writes: [], tier: "irreversible", mode: "expected", onConflict: "serialize" }
      }),
      handler: () =>
        Effect.gen(function*() {
          nativeProbes++
          const read = yield* Effect.result(fs.readFileString(target))
          const write = yield* Effect.result(fs.writeFileString(target, "plugin must not write"))
          const spawn = yield* Effect.result(
            spawner.string(ChildProcess.make("sh", ["-c", "printf bad > process.txt"], { cwd: root }))
          )
          return [read, write, spawn].map((result) => result._tag === "Success")
        })
    })
    const parent: AgentAction.Host = {
      registry: Registry.makeNoop({
        list: () => Effect.succeed([]),
        visible: () => Effect.succeed([]),
        getOption: () => Effect.succeed(Option.none())
      }),
      flows: sources,
      limits: { calls: 8 },
      capabilityEnvelope: all,
      maxFrames: 2,
      defaultCorrections: 0,
      system: ["Keep the existing host teaching."],
      plugins: {
        name: "planning-proof",
        hooks: {
          cellModelRequest: (request) =>
            Effect.sync(() => {
              pluginRequests++
              return request
            }),
          ...(contributed ? { cellFlows: () => Effect.succeed([...bindings, probe]) } : {})
        }
      }
    }
    // Mimic ModuleAuthority's runtime reinjection, rather than relying on the
    // narrower host (deliberately wrong here) provided at construction.
    const runtime = Layer.effect(FlowRuntime.FlowRuntime)(
      Effect.map(FlowRuntime.FlowRuntime, (engine) => ({
        ...engine,
        register: (flow, handler) =>
          engine.register(flow, (payload, id) =>
            handler(payload, id).pipe(
              Effect.provideService(AgentAction.Host, parent),
              CapabilitySet.attenuate(all)
            ))
      }))
    ).pipe(Layer.provide(FlowEngine.layerMemory))
    const observed = Layer.effect(Agent.Agent)(Effect.map(Agent.Agent, (agent) => ({
      run: (options) =>
        Stream.unwrap(Effect.gen(function*() {
          authorities.push({
            empty: CapabilitySet.equals(yield* CapabilitySet.current, CapabilitySet.none),
            envelope: options.capabilityEnvelope?.length ?? -1,
            budget: yield* Budget.Budget,
            steering: yield* Steering.Source
          })
          return agent.run(options)
        }))
    }))).pipe(Layer.provide(Agent.layer))
    return Layer.mergeAll(
      evidenceOnly(Layer.mergeAll(Layer.empty, ...declarations.map(({ action }) => action.layer))),
      ...declarations.map(({ interpreted }) => Interpreter.layer(interpreted))
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(
        AgentAction.layerHost({ ...parent, flows: [], system: ["wrong construction host"], capabilityEnvelope: [] })
      ),
      Layer.provideMerge(resolved),
      Layer.provideMerge(observed),
      Layer.provideMerge(Agent.layerDefaults),
      // Every action here runs to a completion, and the completion brake never
      // falls back. This suite is offline, so the judge is scripted and lets a
      // stated completion stand.
      Layer.provideMerge(
        ScriptedJudge.layer
      ),
      Layer.provideMerge(Layer.mergeAll(Budget.layerUnbounded(), QuotaPolicy.layerUnclassified())),
      // This authority test never exercises rollback; the separate native JJ
      // snapshot suite proves compensation. A positive Write still requires an
      // explicit boundary rather than weakening its compensable declaration.
      Layer.provideMerge(Layer.succeed(FlowEngine.SnapshotBoundary, {
        snapshot: () => Effect.succeed(undefined),
        restore: () => Effect.void,
        diff: () => Effect.succeed(Option.none())
      })),
      Layer.provideMerge(runtime)
    )
  })).pipe(Layer.provideMerge(platform))
  const host = ManagedRuntime.make(layer)
  t.after(() => host.dispose())
  // The guarded primitives fail closed without the native helper, which would
  // make every refusal below pass for that reason instead of authority.
  await host.runPromise(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.stat(target)))
  return {
    host,
    root,
    target,
    marker,
    requests,
    authorities,
    seats,
    counters: () => ({ pluginRequests, nativeProbes })
  }
}

test(
  "all evidence actions refuse real QuickJS Read/Write/Bash after parent host reinjection",
  { timeout: 180_000 },
  async (t) => {
    const f = await fixture(t)
    for (const { direct, interpreted } of declarations.slice(0, -1)) {
      for (const flow of [direct, interpreted]) {
        const result = await f.host.runPromise(
          flow.execute({ evidence: "Captured evidence only." }, { executionId: flow._tag }).pipe(Effect.scoped)
        )
        assert.deepEqual(result, { read: false, write: false, bash: false, visible: [] })
      }
    }
    assert.equal(await readFile(f.target, "utf8"), "captured evidence\n")
    await assert.rejects(readFile(f.marker), { code: "ENOENT" })
    assert.equal(f.authorities.length, 14)
    for (const authority of f.authorities) {
      assert.equal(authority.empty, true)
      assert.equal(authority.envelope, 0)
      assert.equal(authority.budget, f.authorities[0]!.budget)
      assert.equal(authority.steering, f.authorities[0]!.steering)
    }
    assert.equal(f.counters().pluginRequests, 14)
    assert.ok(f.requests.every((request) => request.includes("Keep the existing host teaching.")))
    assert.ok(f.requests.every((request) => request.includes("Captured evidence only.")))
    assert.equal(f.seats.filter((seat) => seat === "coding/implement").length, 10)
    assert.equal(f.seats.filter((seat) => seat === "coding/poc").length, 4)
  }
)

test(
  "plugin-contributed tools retain the empty envelope and cannot bypass kernel authority",
  { timeout: 180_000 },
  async (t) => {
    const f = await fixture(t, true)
    const result = await f.host.runPromise(
      declarations[0]!.interpreted.execute({ evidence: "Captured evidence." }, { executionId: "plugin-proof" }).pipe(
        Effect.scoped
      )
    )
    assert.equal(result.read, false)
    assert.equal(result.write, false)
    assert.equal(result.bash, false)
    assert.deepEqual(result.probe, [false, false, false])
    assert.ok(result.visible.includes("read"))
    assert.equal(f.counters().nativeProbes, 1, "a zero-declared-capability plugin reaches the real guarded primitives")
    assert.equal(await readFile(f.target, "utf8"), "captured evidence\n")
    await assert.rejects(readFile(f.marker), { code: "ENOENT" })
  }
)

test("implementation keeps the parent's real filesystem and process capabilities", { timeout: 180_000 }, async (t) => {
  const f = await fixture(t)
  const result = await f.host.runPromise(
    declarations.at(-1)!.interpreted.execute({ evidence: "Implement now." }, { executionId: "implementation-proof" })
      .pipe(Effect.scoped)
  )
  assert.equal(result.read, true)
  assert.equal(result.write, true)
  assert.equal(result.bash, true)
  assert.equal(await readFile(f.target, "utf8"), "implemented\n")
  assert.equal(await readFile(f.marker, "utf8"), "ran")
  assert.equal(f.authorities[0]!.empty, false)
  assert.equal(f.authorities[0]!.envelope, 1)
})
