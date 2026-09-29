import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import { describe, expect, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, DurableDeferred, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as CacheEnvironment from "@smthrs/flow/CacheEnvironment"
import { Capability, CapabilitySet, Jj, Permission } from "@smthrs/kernel"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Node } from "@smthrs/plan"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import { RunStore } from "@smthrs/run-store"
import { Effect, Exit, FileSystem, Layer, Option, Schema } from "effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as EngineStore from "../src/EngineStore.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as TestStores from "../src/test/TestStores.ts"

const host = (root: string) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(AtomicFileSystem.layer),
    Layer.provide(NodePath.layer),
    Layer.provide(Workspace.layer(root)),
    Layer.provide(
      GrantStore.layer({
        attended: false,
        rules: [
          new Permission.Rule({
            effect: "allow",
            pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: `${root}/**` })
          }),
          new Permission.Rule({
            effect: "allow",
            pattern: new Capability.CapabilityPattern({ action: "fs:write", resource: `${root}/**` })
          })
        ]
      }).pipe(Layer.provide(Workspace.layer(root)))
    )
  )

const run = async (
  mode: "direct" | "inline" | "child" | "handoff",
  parentCapabilities?: ReadonlyArray<string>,
  innerCapabilities?: ReadonlyArray<string>,
  outerCeiling?: ReadonlyArray<Capability.CapabilityPattern>,
  actionCapabilities: ReadonlyArray<string> = ["fs:write:**"]
) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-capability-ceiling-"))
  try {
    const Write = Action.make("capability-ceiling/write", {
      payload: { name: Schema.String },
      success: Schema.Boolean,
      capabilities: actionCapabilities
    })
    const Inner = Flow.make(`capability-ceiling/${mode}/inner`, {
      payload: { name: Schema.String },
      success: Schema.Boolean,
      ...(innerCapabilities === undefined ? {} : { capabilities: innerCapabilities }),
      body: ({ name }) => Write.call({ name })
    })
    const Parent = Flow.make(`capability-ceiling/${mode}/parent`, {
      payload: { name: Schema.String },
      success: Schema.Boolean,
      ...(parentCapabilities === undefined ? {} : { capabilities: parentCapabilities }),
      body: ({ name }) =>
        mode === "direct" ?
          Write.call({ name }) :
          mode === "inline" ?
          Inner.call({ name }) :
          mode === "child"
          ? Inner.child({ name })
          : Inner.to({ name })
    })
    const implementations = Layer.mergeAll(
      Write.toLayer(({ name }) =>
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const result = yield* Effect.result(fs.writeFileString(join(root, name), "written"))
          return result._tag === "Success"
        })
      ),
      Interpreter.layer(Parent),
      Interpreter.layer(Inner)
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(host(root))
    )
    const name = `${mode}.txt`
    const execution = Parent.execute({ name }, { executionId: `ceiling-${mode}` })
    const wrote = await Effect.runPromise((outerCeiling === undefined
      ? execution
      : CapabilitySet.attenuate(outerCeiling)(execution)).pipe(
        Effect.provide(implementations),
        Effect.provide(NodeCrypto.layer)
      ))
    return { wrote, fileExists: existsSync(join(root, name)) }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe("declared capability ceilings at the guarded host boundary", () => {
  for (const mode of ["direct", "inline", "child", "handoff"] as const) {
    it(`blocks a real filesystem write through ${mode} when the caller declares an empty ceiling`, async () => {
      expect(await run(mode, [])).toEqual({ wrote: false, fileExists: false })
    })
    it(`inherits an omitted caller ceiling through ${mode}`, async () => {
      expect(await run(mode)).toEqual({ wrote: true, fileExists: true })
    })
    it(`accepts a broad declared caller through ${mode}`, async () => {
      expect(await run(mode, ["*"])).toEqual({ wrote: true, fileExists: true })
    })
  }

  for (const mode of ["inline", "child", "handoff"] as const) {
    it(`honors an explicit empty inner ceiling through ${mode}`, async () => {
      expect(await run(mode, ["*"], [])).toEqual({ wrote: false, fileExists: false })
    })
  }

  it("keeps an inherited outer ceiling when a declaration allows writing", async () => {
    const readOnly = [new Capability.CapabilityPattern({ action: "fs:read", resource: "**" })]
    expect(await run("direct", ["*"], undefined, readOnly)).toEqual({ wrote: false, fileExists: false })
  })

  it("honors an action's own explicit empty ceiling", async () => {
    expect(await run("direct", ["*"], undefined, undefined, [])).toEqual({
      wrote: false,
      fileExists: false
    })
  })

  it("enforces a direct engine action dispatch's empty ceiling", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-capability-dispatch-"))
    try {
      const action = Action.make({
        name: "capability-ceiling/direct-dispatch",
        success: Schema.Boolean,
        execute: Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return (yield* Effect.result(fs.writeFileString(join(root, "direct-dispatch.txt"), "written")))._tag ===
            "Success"
        })
      }).annotate(Flow.Capabilities, [])
      const flow = Flow.make("capability-ceiling/direct-dispatch-host", {
        payload: {},
        success: Schema.Boolean,
        body: () => Node.succeed(false)
      })
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const engine = yield* FlowRuntime.FlowRuntime
          return yield* engine.actionExecute(action, 1).pipe(
            Effect.provideService(FlowRuntime.FlowInstance, FlowEngine.makeInstance(flow, "direct-dispatch"))
          )
        }).pipe(
          Effect.provide(FlowEngine.layerMemory),
          Effect.provide(host(root)),
          Effect.provide(NodeCrypto.layer)
        )
      )
      expect(result._tag).toBe("Complete")
      expect(result._tag === "Complete" && Exit.isSuccess(result.exit) && result.exit.value).toBe(false)
      expect(existsSync(join(root, "direct-dispatch.txt"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  for (const keyForm of ["string", "object"] as const) {
    it(
      `does not serve a privileged sealed read result under a narrower caller ceiling (${keyForm} key)`,
      async () => {
        const root = await mkdtemp(join(tmpdir(), "smithers-capability-cache-"))
        try {
          await writeFile(join(root, "secret.txt"), "secret")
          const calls: Array<string> = []
          const Read = CacheEnvironment.withCache(
            Action.make({
              name: "capability-ceiling/cached-read",
              success: Schema.String,
              tier: "sealed",
              idempotencyKey: keyForm === "string" ? "same-input" : { operation: "read", input: "same-input" },
              metadata: {
                readSet: [{ path: "secret.txt", digest: "same-input" }],
                writeSet: [],
                boundaryMode: "hard"
              },
              execute: Effect.gen(function*() {
                calls.push("read")
                const fs = yield* FileSystem.FileSystem
                const result = yield* Effect.result(fs.readFileString(join(root, "secret.txt")))
                return result._tag === "Success" ? result.success : "denied"
              })
            }),
            { scope: "shared" }
          )
          const Dispatch = Action.make("capability-ceiling/cache-dispatch", {
            payload: {},
            success: Schema.String
          })
          const Base = Flow.make("capability-ceiling/cache-parent", {
            payload: {},
            success: Schema.String,
            capabilities: ["*"],
            body: () => Dispatch.call({})
          })
          const Denied = Base.annotate(Flow.Capabilities, [])
          // Hold VCS identity and boundary proof fixed to isolate authority-dependent
          // cache keys; SQLite, the cache store, and guarded native file reads are real.
          const jj = Layer.succeed(
            Jj.Jj,
            Jj.make({
              snapshot: () => Effect.succeed({ commitId: "cache" as never, changeId: "cache" as never }),
              restore: () => Effect.void,
              diff: () => Effect.succeed(""),
              workspaceAdd: () => Effect.void,
              workspaceForget: () => Effect.void,
              status: () => Effect.succeed("")
            })
          )
          const run = (flow: typeof Base, executionId: string) =>
            Effect.scoped(Effect.gen(function*() {
              const engine = yield* EngineStore.make({
                owner: { hostId: executionId },
                journalSource: "capability-ceiling-cache",
                isAlive: () => Effect.succeed(false)
              })
              const layer = Layer.mergeAll(
                Dispatch.toLayer(() => Read),
                Interpreter.layer(flow)
              ).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine)),
                Layer.provideMerge(Action.layerCacheEnvironment({ layers: [], capabilities: {} })),
                Layer.provideMerge(host(root))
              )
              return yield* flow.execute({}, { executionId }).pipe(Effect.provide(layer))
            })).pipe(
              Effect.provide(jj),
              Effect.provide(StepBoundary.layerTest()),
              Effect.provide(TestStores.layerAt(join(root, "state.sqlite"))),
              Effect.provide(NodeCrypto.layer)
            )
          expect(await Effect.runPromise(run(Base, "cache-allowed"))).toBe("secret")
          expect(calls).toEqual(["read"])
          expect(await Effect.runPromise(run(Base, "cache-allowed"))).toBe("secret")
          expect(calls).toEqual(["read"])
          expect(await Effect.runPromise(run(Base, "cache-allowed-new-run"))).toBe("secret")
          expect(calls).toEqual(["read"])
          expect(await Effect.runPromise(run(Denied, "cache-denied"))).toBe("denied")
          expect(calls).toEqual(["read", "read"])
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    )
  }

  it("keeps an empty inline sibling ceiling out of an allowed sibling", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-capability-siblings-"))
    try {
      const Write = Action.make("capability-ceiling/sibling-write", {
        payload: { name: Schema.String },
        success: Schema.Boolean,
        capabilities: ["fs:write:**"]
      })
      const Blocked = Flow.make("capability-ceiling/blocked-sibling", {
        payload: {},
        success: Schema.Boolean,
        capabilities: [],
        body: () => Write.call({ name: "blocked.txt" })
      })
      const Allowed = Flow.make("capability-ceiling/allowed-sibling", {
        payload: {},
        success: Schema.Boolean,
        body: () => Write.call({ name: "allowed.txt" })
      })
      const Parent = Flow.make("capability-ceiling/sibling-parent", {
        payload: {},
        success: Schema.Struct({ blocked: Schema.Boolean, allowed: Schema.Boolean }),
        capabilities: ["*"],
        body: () => Node.all({ blocked: Blocked.call({}), allowed: Allowed.call({}) })
      })
      const layer = Layer.mergeAll(
        Write.toLayer(({ name }) =>
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return (yield* Effect.result(fs.writeFileString(join(root, name), "written")))._tag === "Success"
          })
        ),
        Interpreter.layer(Parent)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(host(root))
      )
      const result = await Effect.runPromise(
        Parent.execute({}, { executionId: "ceiling-siblings" }).pipe(
          Effect.provide(layer),
          Effect.provide(NodeCrypto.layer)
        )
      )
      expect(result).toEqual({ blocked: false, allowed: true })
      expect(existsSync(join(root, "blocked.txt"))).toBe(false)
      expect(existsSync(join(root, "allowed.txt"))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("retains the caller ceiling after a deferred memory-engine resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-capability-resume-"))
    try {
      const gate = DurableDeferred.make("capability-ceiling/resume-gate", { success: Schema.String })
      const Wait = Action.make("capability-ceiling/wait", { payload: {}, success: Schema.String })
      const Write = Action.make("capability-ceiling/resumed-write", {
        payload: { name: Schema.String },
        success: Schema.Boolean,
        capabilities: ["fs:write:**"]
      })
      const Parent = Flow.make("capability-ceiling/resume-parent", {
        payload: { name: Schema.String },
        success: Schema.Boolean,
        capabilities: [],
        body: ({ name }) => Wait.call({}).pipe(Node.bindPlanned(() => Write.call({ name })))
      })
      const layer = Layer.mergeAll(
        Wait.toLayer(() => DurableDeferred.await(gate)),
        Write.toLayer(({ name }) =>
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            return (yield* Effect.result(fs.writeFileString(join(root, name), "written")))._tag === "Success"
          })
        ),
        Interpreter.layer(Parent)
      ).pipe(
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(host(root))
      )
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const executionId = "capability-resume"
          yield* Parent.execute({ name: "resumed.txt" }, { executionId, discard: true })
          let suspended = false
          for (let turn = 0; turn < 1000; turn++) {
            const poll = yield* Parent.poll(executionId)
            if (Option.isSome(poll) && poll.value._tag === "Suspended") {
              suspended = true
              break
            }
            yield* Effect.yieldNow
          }
          expect(suspended).toBe(true)
          const token = DurableDeferred.tokenFromExecutionId(gate, { flow: Parent, executionId })
          yield* DurableDeferred.succeed(gate, { token, value: "ready" })
          return yield* Parent.execute({ name: "resumed.txt" }, { executionId })
        }).pipe(Effect.provide(layer), Effect.provide(NodeCrypto.layer))
      )
      expect(result).toBe(false)
      expect(existsSync(join(root, "resumed.txt"))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  for (const legacy of [false, true]) {
    it(
      legacy
        ? "fails closed when a reopened legacy SQLite row lacks capabilityCeilings"
        : "retains the admitted ceiling after SQLite restart and wider re-registration",
      async () => {
        const root = await mkdtemp(join(tmpdir(), "smithers-capability-restart-"))
        try {
          const gate = DurableDeferred.make("capability-ceiling/restart-gate", { success: Schema.String })
          const Wait = Action.make("capability-ceiling/restart-wait", { payload: {}, success: Schema.String })
          const Write = Action.make("capability-ceiling/restart-write", {
            payload: { name: Schema.String },
            success: Schema.Boolean,
            capabilities: ["fs:write:**"]
          })
          const Parent = Flow.make("capability-ceiling/restart-parent", {
            payload: { name: Schema.String },
            success: Schema.Boolean,
            capabilities: [],
            body: ({ name }) => Wait.call({}).pipe(Node.bindPlanned(() => Write.call({ name })))
          })
          const Widened = Parent.annotate(Flow.Capabilities, ["*"])
          const executionId = "capability-restart"
          let dispatches = 0
          const jj = Layer.succeed(
            Jj.Jj,
            Jj.make({
              snapshot: () => Effect.succeed({ commitId: "ceiling" as never, changeId: "ceiling" as never }),
              restore: () => Effect.void,
              diff: () => Effect.succeed(""),
              workspaceAdd: () => Effect.void,
              workspaceForget: () => Effect.void,
              status: () => Effect.succeed("")
            })
          )
          const phase = (name: string, resume: boolean) =>
            Effect.scoped(Effect.gen(function*() {
              const declaration = resume ? Widened : Parent
              const engine = yield* EngineStore.make({
                owner: { hostId: name },
                journalSource: "capability-ceiling-restart",
                isAlive: () => Effect.succeed(false)
              })
              const layer = Layer.mergeAll(
                Wait.toLayer(() =>
                  Effect.suspend(() => {
                    dispatches++
                    return DurableDeferred.await(gate)
                  })
                ),
                Write.toLayer(({ name }) =>
                  Effect.gen(function*() {
                    dispatches++
                    const fs = yield* FileSystem.FileSystem
                    return (yield* Effect.result(fs.writeFileString(join(root, name), "written")))._tag === "Success"
                  })
                ),
                Interpreter.layer(declaration)
              ).pipe(
                Layer.provideMerge(Action.layerImplementations),
                Layer.provideMerge(Layer.succeed(FlowRuntime.FlowRuntime, engine)),
                Layer.provideMerge(host(root))
              )
              return yield* Effect.gen(function*() {
                if (resume) {
                  yield* engine.deferredDone(gate, {
                    flowName: Parent._tag,
                    executionId,
                    deferredName: gate.name,
                    exit: Exit.succeed("ready")
                  })
                  return yield* declaration.execute({ name: "restarted.txt" }, { executionId })
                }
                yield* declaration.execute({ name: "restarted.txt" }, { executionId, discard: true })
                const runs = yield* RunStore.RunStore
                for (let turn = 0; turn < 200; turn++) {
                  const status = (yield* runs.get(executionId)).status
                  if (status === "suspended") return false
                  yield* Effect.sleep("5 millis")
                }
                return yield* Effect.die("run did not suspend")
              }).pipe(Effect.provide(layer))
            })).pipe(
              Effect.provide(jj),
              Effect.provide(StepBoundary.layerTest()),
              Effect.provide(TestStores.layerAt(join(root, "state.sqlite"))),
              Effect.provide(NodeCrypto.layer)
            )
          expect(await Effect.runPromise(phase("ceiling-before-restart", false))).toBe(false)
          expect(existsSync(join(root, "restarted.txt"))).toBe(false)
          if (legacy) {
            await Effect.runPromise(
              Effect.gen(function*() {
                const sql = yield* SqlClient.SqlClient
                const rows = yield* sql<
                  { state_json: string }
                >`SELECT state_json FROM flows_runs WHERE run_id = ${executionId}`
                expect(rows).toHaveLength(1)
                const state = JSON.parse(rows[0]!.state_json) as Record<string, unknown>
                expect(Object.hasOwn(state, "capabilityCeilings")).toBe(true)
                delete state["capabilityCeilings"]
                yield* sql`UPDATE flows_runs SET state_json = ${JSON.stringify(state)} WHERE run_id = ${executionId}`
                const stored = yield* sql<
                  { state_json: string }
                >`SELECT state_json FROM flows_runs WHERE run_id = ${executionId}`
                expect(Object.hasOwn(JSON.parse(stored[0]!.state_json), "capabilityCeilings")).toBe(false)
              }).pipe(
                Effect.scoped,
                Effect.provide(TestStores.layerAt(join(root, "state.sqlite"))),
                Effect.provide(NodeCrypto.layer)
              )
            )
          }
          const beforeResume = dispatches
          expect(beforeResume).toBeGreaterThan(0)
          if (legacy) {
            const exit = await Effect.runPromiseExit(phase("ceiling-after-restart", true))
            expect(Exit.isFailure(exit)).toBe(true)
            expect(String(exit)).toContain("Missing persisted capabilityCeilings")
            expect(dispatches).toBe(beforeResume)
            const status = await Effect.runPromise(
              Effect.flatMap(RunStore.RunStore, (runs) => runs.get(executionId)).pipe(
                Effect.map((row) => row.status),
                Effect.scoped,
                Effect.provide(TestStores.layerAt(join(root, "state.sqlite"))),
                Effect.provide(NodeCrypto.layer)
              )
            )
            expect(status).toBe("failed")
          } else {
            expect(await Effect.runPromise(phase("ceiling-after-restart", true))).toBe(false)
            expect(dispatches).toBeGreaterThan(beforeResume)
          }
          expect(existsSync(join(root, "restarted.txt"))).toBe(false)
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    )
  }
})
