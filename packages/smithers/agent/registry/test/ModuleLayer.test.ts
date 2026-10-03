/** Module implementation exports are composed at the registry load boundary. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Context, Deferred, Effect, Exit, Fiber, FileSystem, Layer, type Path, Schema, Scope } from "effect"
import { createRequire } from "node:module"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"
import * as Registry from "../src/Registry.ts"

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)
class HostPrefix extends Context.Service<HostPrefix, string>()("test/module/HostPrefix") {}
class Unsupported extends Context.Service<Unsupported, string>()("test/module/Unsupported") {}

const Write = Action.make("test/module/Write", { payload: { value: Schema.String }, success: Schema.String })
const flow = Flow.make("fixture", {
  description: "A module with its own implementation.",
  payload: { value: Schema.String },
  success: Schema.String,
  body: Node.capture({ action: Write.name }, Write.call)
})

const fixture = Effect.gen(function*() {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-module-layer-" })
  const directory = join(root, "flows", "fixture")
  yield* fs.makeDirectory(directory, { recursive: true })
  yield* fs.writeFileString(
    join(directory, "flow.ts"),
    `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("fixture", {
  description: "A module with its own implementation.",
  payload: { value: Schema.String }, success: Schema.String,
  body: Node.capture({}, ({ value }) => Node.succeed(value))
})
`
  )
  const discovery = yield* Discovery.Discovery
  const discovered = yield* discovery.scan({ source: "project", root: join(root, "flows"), naming: "path" })
  expect(discovered.entries).toHaveLength(1)
  return { root, descriptor: discovered.entries[0]! }
})

const memoryRuntime = async () => {
  const require = createRequire(import.meta.url)
  const enginePath = require.resolve("@smthrs/engine", { paths: [require.resolve("@smthrs/engine-store")] })
  const { FlowEngine } = await vi.importActual<{
    readonly FlowEngine: { readonly layerMemory: Layer.Layer<FlowRuntime.FlowRuntime> }
  }>(enginePath)
  return FlowEngine.layerMemory
}

// A unit seam records real Action.toLayer registrations. The CLI suite covers
// durable scheduling and storage with the real engine and an actual child.
const recordingRuntime = (handlers: Map<string, (payload: unknown) => Effect.Effect<unknown>>) =>
  Layer.succeed(FlowRuntime.FlowRuntime, {
    register: (registered: Flow.Any, handler: (payload: unknown) => Effect.Effect<unknown>) =>
      Effect.sync(() => void handlers.set(registered._tag, handler))
  } as never)

describe("module layer exports", () => {
  it("refuses a retained object-form Core module by name before evaluation", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const { root } = yield* fixture
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(
          join(root, "flows", "fixture", "flow.ts"),
          `
import { Flow } from "@smthrs/core"
import { Schema } from "effect"
export default Flow.make({ name: "fixture", description: "Retained fixture", input: Schema.Struct({ value: Schema.String }), output: Schema.String })
`
        )
        const discovery = yield* Discovery.Discovery
        const discovered = yield* discovery.scan({ source: "project", root: join(root, "flows"), naming: "path" })
        const result = yield* Effect.result(Executable.fromDescriptor(discovered.entries[0]!, { delegates: [] }))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({ code: "invalid_module", flow: "fixture" })
          expect(result.failure.message).toContain("Retained Core object-form module")
        }
      }).pipe(Effect.provide(Discovery.layer), Effect.provide(platform), Effect.scoped)
    )
  })

  it("registers the module action against existing host services", async () => {
    const runtimeLayer = await memoryRuntime()
    await Effect.runPromise(
      Effect.gen(function*() {
        const { descriptor } = yield* fixture
        const moduleLayer = Layer.unwrap(
          Effect.map(HostPrefix, (prefix) => Write.toLayer(({ value }) => Effect.succeed(`${prefix}:${value}`)))
        )
        const executable = yield* Executable.fromDescriptor(descriptor, {
          delegates: [],
          load: () => Effect.succeed({ default: flow, layer: moduleLayer })
        })
        yield* Layer.build(executable.layer)
        const runtime = yield* FlowRuntime.FlowRuntime
        expect(
          yield* runtime.execute(executable.flow, {
            payload: { input: { value: "input" } },
            executionId: "unit-module-host-services"
          })
        ).toBe("host:input")
      }).pipe(
        Effect.provide(Discovery.layer),
        Effect.provide(
          Layer.mergeAll(
            platform,
            runtimeLayer,
            Action.layerImplementations,
            Layer.succeed(HostPrefix, "host")
          )
        ),
        Effect.scoped
      )
    )
  })

  it("refuses a missing layer service by name before registering anything", async () => {
    const handlers = new Map<string, (payload: unknown) => Effect.Effect<unknown>>()
    await Effect.runPromise(
      Effect.gen(function*() {
        const { descriptor } = yield* fixture
        const moduleLayer = Layer.unwrap(
          Effect.map(Unsupported, () => Write.toLayer(({ value }) => Effect.succeed(value)))
        )
        const result = yield* Effect.result(Executable.fromDescriptor(descriptor, {
          delegates: [],
          load: () => Effect.succeed({ default: flow, layer: moduleLayer })
        }))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toBeInstanceOf(Executable.ExecutableError)
          expect(result.failure).toMatchObject({ code: "missing_service", flow: "fixture" })
          expect(result.failure.message).toContain("test/module/Unsupported")
          expect(result.failure.service).toContain("test/module/Unsupported")
        }
        expect(handlers.size).toBe(0)
      }).pipe(
        Effect.provide(Discovery.layer),
        Effect.provide(platform),
        Effect.provide(recordingRuntime(handlers)),
        Effect.scoped
      )
    )
  })

  for (const invalid of [null, {}, "implementation", Effect.void]) {
    it(`refuses an invalid layer export (${String(invalid)})`, async () => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const { descriptor } = yield* fixture
          const result = yield* Effect.result(Executable.fromDescriptor(descriptor, {
            delegates: [],
            load: () => Effect.succeed({ default: flow, layer: invalid })
          }))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(Executable.ExecutableError)
            expect(result.failure).toMatchObject({ code: "invalid_layer", flow: "fixture" })
            expect(result.failure.message).toContain("layer")
          }
        }).pipe(Effect.provide(Discovery.layer), Effect.provide(platform), Effect.scoped)
      )
    })
  }

  it("keeps flows without a layer export runnable", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const { descriptor } = yield* fixture
        const executable = yield* Executable.fromDescriptor(descriptor, {
          delegates: [],
          load: () => Effect.succeed({ default: flow })
        })
        expect(executable.declaredTag).toBe("fixture")
      }).pipe(Effect.provide(Discovery.layer), Effect.provide(platform), Effect.scoped)
    )
  })

  it("builds the implementation once and releases its resources with the host", async () => {
    let acquired = 0
    let released = 0
    const handlers = new Map<string, (payload: unknown) => Effect.Effect<unknown>>()
    await Effect.runPromise(
      Effect.gen(function*() {
        const { descriptor } = yield* fixture
        const implementation = Layer.effectDiscard(Effect.acquireRelease(
          Effect.sync(() => acquired++),
          () => Effect.sync(() => void released++)
        ))
        const executable = yield* Executable.fromDescriptor(descriptor, {
          delegates: [],
          load: () => Effect.succeed({ default: flow, layer: implementation })
        })
        expect(acquired).toBe(1)
        yield* Layer.build(executable.layer)
        yield* Layer.build(executable.layer)
        expect(acquired).toBe(1)
        expect(released).toBe(0)
      }).pipe(
        Effect.provide(Discovery.layer),
        Effect.provide(Layer.mergeAll(platform, recordingRuntime(handlers), Action.layerImplementations)),
        Effect.scoped
      )
    )
    expect(released).toBe(1)
  })

  for (const kind of ["failure", "defect"] as const) {
    it(`reports a layer construction ${kind} as a typed refusal and closes acquired resources`, async () => {
      let released = 0
      await Effect.runPromise(
        Effect.gen(function*() {
          const { descriptor } = yield* fixture
          const implementation = Layer.effectDiscard(Effect.gen(function*() {
            yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => void released++))
            return yield* kind === "failure" ? Effect.fail("construction refused") : Effect.die("construction defect")
          }))
          const result = yield* Effect.result(Executable.fromDescriptor(descriptor, {
            delegates: [],
            load: () => Effect.succeed({ default: flow, layer: implementation })
          }))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(Executable.ExecutableError)
            expect(result.failure).toMatchObject({ code: "layer_failed", flow: "fixture" })
          }
          expect(released).toBe(1)
        }).pipe(Effect.provide(Discovery.layer), Effect.provide(platform), Effect.scoped)
      )
    })
  }

  it("interrupts an unfinished layer build and releases resources without converting cancellation into a refusal", async () => {
    let released = 0
    await Effect.runPromise(
      Effect.gen(function*() {
        const { descriptor } = yield* fixture
        const acquired = yield* Deferred.make<void>()
        const implementation = Layer.effectDiscard(Effect.gen(function*() {
          yield* Effect.acquireRelease(Effect.void, () => Effect.sync(() => void released++))
          yield* Deferred.succeed(acquired, undefined)
          yield* Effect.never
        }))
        const fiber = yield* Executable.fromDescriptor(descriptor, {
          delegates: [],
          load: () => Effect.succeed({ default: flow, layer: implementation })
        }).pipe(Effect.forkScoped)
        yield* Deferred.await(acquired)
        yield* Fiber.interrupt(fiber)
        const exit = yield* Fiber.await(fiber)
        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(released).toBe(1)
      }).pipe(Effect.provide(Discovery.layer), Effect.provide(platform), Effect.scoped)
    )
  })

  it("names Scope when a layer is loaded outside a scoped host", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const live = yield* fixture
        const result = yield* Effect.result(
          Executable.fromDescriptor(live.descriptor, {
            delegates: [],
            load: () => Effect.succeed({ default: flow, layer: Layer.empty })
          }).pipe(
            Effect.updateContext((context: Context.Context<FileSystem.FileSystem | Path.Path>) =>
              context.pipe(Context.omit(Scope.Scope))
            )
          )
        )
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({ code: "missing_service", flow: live.descriptor.name })
          expect(result.failure.message).toContain("Scope")
          expect(result.failure.service).toBe(Scope.Scope.key)
        }
      }).pipe(Effect.provide(Discovery.layer), Effect.provide(platform), Effect.scoped)
    )
  })

  it("names a missing registration runtime and releases the already-built layer", async () => {
    let released = 0
    await Effect.runPromise(
      Effect.gen(function*() {
        const { descriptor } = yield* fixture
        const implementation = Layer.effectDiscard(Effect.acquireRelease(
          Effect.void,
          () => Effect.sync(() => void released++)
        ))
        const result = yield* Effect.result(Executable.fromDescriptor(descriptor, {
          delegates: [],
          load: () => Effect.succeed({ default: flow, layer: implementation })
        }))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            code: "missing_service",
            flow: "fixture",
            service: FlowRuntime.FlowRuntime.key
          })
        }
        expect(released).toBe(1)
      }).pipe(Effect.provide(Discovery.layer), Effect.provide(platform), Effect.scoped)
    )
  })

  it("refuses a layer export paired with a legacy core declaration", async () => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const { descriptor } = yield* fixture
        const legacy = {
          capabilities: [],
          effects: undefined,
          name: "fixture",
          description: "A legacy declaration.",
          input: Schema.Struct({ value: Schema.String }),
          output: Schema.String
        } as const
        const result = yield* Effect.result(Executable.fromDescriptor(descriptor, {
          delegates: [],
          load: () => Effect.succeed({ default: legacy, layer: Layer.empty })
        }))
        expect(result._tag).toBe("Failure")
        if (result._tag === "Failure") {
          expect(result.failure).toMatchObject({ code: "invalid_layer", flow: "fixture" })
          expect(result.failure.message).toContain("@smthrs/flow")
        }
      }).pipe(Effect.provide(Discovery.layer), Effect.provide(platform), Effect.scoped)
    )
  })

  it("refreshes implementations with the same action tag while retaining host services", async () => {
    const runtimeLayer = await memoryRuntime()
    const outputs: Array<string> = []
    let version = "first"
    await Effect.runPromise(
      Effect.gen(function*() {
        const { root } = yield* fixture
        const registration = Executable.layer({
          delegates: [],
          load: () => {
            const loadedVersion = version
            const implementation = Layer.unwrap(
              Effect.map(
                HostPrefix,
                (prefix) => Write.toLayer(({ value }) => Effect.succeed(`${prefix}:${loadedVersion}:${value}`))
              )
            )
            return Effect.succeed({ default: flow, layer: implementation })
          }
        }).pipe(Layer.provideMerge(Registry.layerProject({ root })))
        yield* Effect.gen(function*() {
          const catalog = yield* Executable.Catalog
          const refresh = yield* Executable.Refresh
          const fs = yield* FileSystem.FileSystem
          for (const next of ["second", "third"]) {
            version = next
            yield* fs.writeFileString(
              join(root, "flows", "fixture", "flow.ts"),
              `${yield* fs.readFileString(join(root, "flows", "fixture", "flow.ts"))}\n// ${next}\n`
            )
            const refreshed = yield* refresh.flow("fixture")
            if (refreshed._tag === "Refused") {
              throw new Error(
                `${refreshed.error.message}: ${Cause.pretty(refreshed.error.cause as Cause.Cause<unknown>)}`
              )
            }
            expect(refreshed._tag).toBe("Registered")
            expect(catalog.refused).toEqual([])
            expect(catalog.executables).toHaveLength(1)
            const runtime = yield* FlowRuntime.FlowRuntime
            outputs.push(
              Schema.decodeUnknownSync(Schema.String)(
                yield* runtime.execute(catalog.executables[0]!.flow, {
                  payload: { input: { value: "payload" } },
                  executionId: `unit-module-refreshed-${next}`
                })
              )
            )
          }
        }).pipe(Effect.provide(registration))
      }).pipe(
        Effect.provide(Discovery.layer),
        Effect.provide(
          Layer.mergeAll(
            platform,
            runtimeLayer,
            Action.layerImplementations,
            Layer.succeed(HostPrefix, "host")
          )
        ),
        Effect.scoped
      )
    )
    expect(outputs).toEqual(["host:second:payload", "host:third:payload"])
  })
})
