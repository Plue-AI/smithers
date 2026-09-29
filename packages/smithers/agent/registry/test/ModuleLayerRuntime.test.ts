/** A discovered module keeps its implementations through real engine registration. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Context, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect"
import { createRequire } from "node:module"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"

class HostPrefix extends Context.Service<HostPrefix, string>()("test/module-runtime/HostPrefix") {}

it("keeps the module's action table when the real runtime receives an empty caller table", async () => {
  // The registry already depends on engine-store for integration tests;
  // resolve its real engine dependency without adding a source-path import.
  const require = createRequire(import.meta.url)
  const enginePath = require.resolve("@smthrs/engine", { paths: [require.resolve("@smthrs/engine-store")] })
  const { FlowEngine } = await vi.importActual<{
    readonly FlowEngine: { readonly layerMemory: Layer.Layer<FlowRuntime.FlowRuntime> }
  }>(enginePath)
  const calls: Array<string> = []
  const Write = Action.make("test/module-runtime/Write", {
    payload: { value: Schema.String },
    success: Schema.String
  })
  const flow = Flow.make("fixture", {
    description: "A module with its own implementation.",
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
    payload: { value: Schema.String },
    success: Schema.String,
    body: Node.capture({ action: Write.name }, Write.call)
  })
  const moduleLayer = Layer.unwrap(Effect.map(HostPrefix, (prefix) =>
    Write.toLayer(({ value }) =>
      Effect.sync(() => {
        calls.push(value)
        return `${prefix}:${value}`
      })
    )))

  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "registry-module-runtime-" })
      const directory = join(root, "flows", "fixture")
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.writeFileString(
        join(directory, "flow.ts"),
        `
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
const Write = Action.make("test/module-runtime/Write", {
  payload: { value: Schema.String }, success: Schema.String
})
export default Flow.make("fixture", {
  description: "A module with its own implementation.",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: { value: Schema.String }, success: Schema.String,
  body: Node.capture({ action: Write.name }, Write.call)
})
`
      )
      const discovery = yield* Discovery.Discovery
      const scanned = yield* discovery.scan({ source: "project", root: join(root, "flows"), naming: "path" })
      expect(scanned.entries).toHaveLength(1)
      // Only module evaluation is supplied here. Registration and interpretation
      // use the real engine; file import is covered by the native-host suites.
      const executable = yield* Executable.fromDescriptor(scanned.entries[0]!, {
        delegates: [],
        load: () => Effect.succeed({ default: flow, layer: moduleLayer })
      })
      yield* Layer.build(executable.layer)
      const callerTable = yield* Action.Implementations
      expect(Option.isNone(yield* callerTable.get(Write.name))).toBe(true)

      const runtime = yield* FlowRuntime.FlowRuntime
      const first = yield* runtime.execute(executable.flow, {
        payload: { input: { value: "first" } },
        executionId: "module-runtime-first"
      })
      const second = yield* runtime.execute(executable.flow, {
        payload: { input: { value: "second" } },
        executionId: "module-runtime-second"
      })
      expect(first).toBe("host:first")
      expect(second).toBe("host:second")
      expect(calls).toEqual(["first", "second"])
      // Pinning an interpreter's table must not replace or populate the caller's.
      expect(Option.isNone(yield* callerTable.get(Write.name))).toBe(true)
    }).pipe(
      Effect.provide(Discovery.layer),
      Effect.provide(Layer.mergeAll(
        FlowEngine.layerMemory,
        Action.layerImplementations,
        Layer.succeed(HostPrefix, "host"),
        NodeFileSystem.layer,
        NodePath.layer,
        NodeCrypto.layer
      )),
      Effect.scoped
    )
  )
})

it("preserves an interrupt cause from a module layer and releases its acquired resource", async () => {
  let acquired = 0
  const released: Array<Exit.Exit<unknown, unknown>> = []
  const interrupt = Cause.interrupt(987)
  const flow = Flow.make("fixture", {
    description: "An interrupted implementation layer.",
    payload: {},
    success: Schema.String,
    body: () => Node.succeed("unused")
  })
  const implementation = Layer.effectDiscard(Effect.gen(function*() {
    yield* Effect.acquireRelease(
      Effect.sync(() => ++acquired),
      (_resource, exit) => Effect.sync(() => void released.push(exit))
    )
    // A construction failure carrying an interrupt cause exercises recovery
    // without requesting cancellation of this test's fiber.
    return yield* Effect.failCause(interrupt)
  }))

  await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "registry-layer-interrupt-" })
      const directory = join(root, "flows", "fixture")
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.writeFileString(
        join(directory, "flow.ts"),
        `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("fixture", {
  description: "An interrupted implementation layer.",
  payload: {}, success: Schema.String, body: () => Node.succeed("unused")
})
`
      )
      const discovery = yield* Discovery.Discovery
      const scanned = yield* discovery.scan({ source: "project", root: join(root, "flows"), naming: "path" })
      expect(scanned.entries).toHaveLength(1)
      const exit = yield* Effect.exit(
        Executable.fromDescriptor(scanned.entries[0]!, {
          delegates: [],
          load: () => Effect.succeed({ default: flow, layer: implementation })
        }).pipe(Effect.uninterruptible)
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(exit.cause.reasons).toEqual(interrupt.reasons)
      }
      expect(acquired).toBe(1)
      // Cleanup is complete before the surrounding host scope closes.
      expect(released).toHaveLength(1)
      const cleanup = released[0]!
      expect(Exit.isFailure(cleanup)).toBe(true)
      if (Exit.isFailure(cleanup)) expect(cleanup.cause.reasons).toEqual(interrupt.reasons)
    }).pipe(
      Effect.provide(Discovery.layer),
      Effect.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)),
      Effect.scoped
    )
  )
  expect(released).toHaveLength(1)
})
