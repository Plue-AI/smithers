/** Module layers compose with host actions and retain their loading-host lifetime. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  type Path,
  Scheduler,
  Schema,
  Scope
} from "effect"
import { createRequire } from "node:module"
import { basename, dirname, join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as Executable from "../src/Executable.ts"
import * as Registry from "../src/Registry.ts"

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)
const host = async () => {
  const require = createRequire(import.meta.url)
  const enginePath = require.resolve("@smthrs/engine", { paths: [require.resolve("@smthrs/engine-store")] })
  const { FlowEngine } = await vi.importActual<{
    readonly FlowEngine: { readonly layerMemory: Layer.Layer<FlowRuntime.FlowRuntime> }
  }>(enginePath)
  return Layer.merge(platform, FlowEngine.layerMemory)
}
const definition = (name: string, body: Node.Node<unknown, unknown, any>) =>
  Flow.make(name, {
    description: "Compose module and host actions.",
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
    payload: { value: Schema.String },
    success: Schema.Unknown,
    error: Schema.Unknown,
    body: Node.capture({ name }, () => body)
  })
const project = (names: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "registry-layer-composition-" })
    for (const name of names) {
      const directory = join(root, "flows", name)
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.writeFileString(
        join(directory, "flow.ts"),
        `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("${name}", {
  description: "Compose module and host actions.",
  capabilities: [], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: { value: Schema.String }, success: Schema.Unknown, error: Schema.Unknown,
  body: Node.capture({}, () => Node.succeed("fixture"))
})
`
      )
    }
    return root
  })
class Missing extends Context.Service<Missing, string>()("test/composition/Missing") {}
const Shared = Action.make("test/composition/Shared", {
  payload: { value: Schema.String },
  success: Schema.String,
  error: Schema.Unknown
})
const HostOnly = Action.make("test/composition/HostOnly", { payload: { value: Schema.String }, success: Schema.String })

describe("module layer composition", () => {
  it("refuses an exported replacement implementation table and releases its acquired resources", async () => {
    let acquired = 0
    let released = 0
    const module = definition("fixture", Shared.call({ value: "own" }))
    const hostFlow = definition("host-table-survives", Shared.call({ value: "host" }))
    const hostActions = Layer.merge(
      Shared.toLayer(({ value }) => Effect.succeed(`host:${value}`)),
      Interpreter.layer(hostFlow)
    ).pipe(Layer.provideMerge(Action.layerImplementations))
    await Effect.runPromise(
      Effect.gen(function*() {
        const root = yield* project(["fixture"])
        yield* Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const result = yield* Effect.result(Executable.fromDescriptor(yield* registry.get("fixture"), {
            delegates: [],
            load: () =>
              Effect.succeed({
                default: module,
                layer: Layer.merge(
                  Shared.toLayer(({ value }) => Effect.succeed(`module:${value}`)),
                  Layer.effectDiscard(Effect.acquireRelease(
                    Effect.sync(() => {
                      acquired++
                    }),
                    () =>
                      Effect.sync(() => {
                        released++
                      })
                  ))
                ).pipe(Layer.provideMerge(Action.layerImplementations))
              })
          }))
          expect(result._tag).toBe("Failure")
          if (result._tag === "Failure") {
            expect(result.failure).toBeInstanceOf(Executable.ExecutableError)
            expect(result.failure).toMatchObject({
              code: "invalid_layer",
              flow: "fixture",
              service: Action.Implementations.key
            })
          }
          expect(acquired).toBe(1)
          expect(released).toBe(1)
          const runtime = yield* FlowRuntime.FlowRuntime
          expect(
            yield* runtime.execute(hostFlow, {
              payload: { value: "unused" },
              executionId: "composition-refused-table-host"
            })
          ).toBe("host:host")
        }).pipe(Effect.provide(Registry.layerProject({ root })))
      }).pipe(Effect.provide(hostActions), Effect.provide(await host()), Effect.scoped)
    )
  })

  it("accepts re-exporting the same host-owned module implementation table", async () => {
    const module = definition("fixture", Shared.call({ value: "same-table" }))
    await Effect.runPromise(
      Effect.gen(function*() {
        const root = yield* project(["fixture"])
        yield* Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const executable = yield* Executable.fromDescriptor(yield* registry.get("fixture"), {
            delegates: [],
            load: () =>
              Effect.succeed({
                default: module,
                layer: Layer.unwrap(Effect.map(Action.Implementations, (table) =>
                  Layer.merge(
                    Shared.toLayer(({ value }) => Effect.succeed(`module:${value}`)),
                    Layer.succeed(Action.Implementations, table)
                  )))
              })
          })
          const runtime = yield* FlowRuntime.FlowRuntime
          expect(
            yield* runtime.execute(executable.flow, {
              payload: { input: { value: "unused" } },
              executionId: "composition-same-table"
            }).pipe(Effect.provide(executable.layer))
          ).toBe("module:same-table")
        }).pipe(Effect.provide(Registry.layerProject({ root })))
      }).pipe(Effect.provide(Action.layerImplementations), Effect.provide(await host()), Effect.scoped)
    )
  })
  it("resolves module actions first and host-only actions from both the body and an implementation", async () => {
    let capturedTable: Action.Implementations["Service"] | undefined
    const module = definition(
      "fixture",
      Node.all({
        own: Shared.call({ value: "own" }),
        host: HostOnly.call({ value: "body" })
      })
    )
    const hostActions = Layer.merge(
      Shared.toLayer(({ value }) => Effect.succeed(`host-shared:${value}`)),
      HostOnly.toLayer(({ value }) => Effect.succeed(`host:${value}`))
    ).pipe(Layer.provideMerge(Action.layerImplementations))
    await Effect.runPromise(
      Effect.gen(function*() {
        const root = yield* project(["fixture"])
        yield* Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const executable = yield* Executable.fromDescriptor(yield* registry.get("fixture"), {
            delegates: [],
            load: () =>
              Effect.succeed({
                default: module,
                layer: Shared.toLayer(({ value }) =>
                  Effect.gen(function*() {
                    const table = yield* Action.Implementations
                    capturedTable = table
                    const implementation = yield* table.get(HostOnly.name)
                    if (Option.isNone(implementation)) {
                      return yield* Effect.die("host action missing from module handler")
                    }
                    const nested = yield* implementation.value.action({ value: "handler" })
                    return `module:${value}:${nested}`
                  })
                )
              })
          })
          const runtime = yield* FlowRuntime.FlowRuntime
          const result = yield* runtime.execute(executable.flow, {
            payload: { input: { value: "unused" } },
            executionId: "composition-host-fallback"
          }).pipe(Effect.provide(executable.layer))
          expect(result).toEqual({ own: "module:own:host:handler", host: "host:body" })
          // A retained lookup service also works outside a running flow, where
          // no FlowInstance exists. Querying the table does not execute actions.
          expect(Option.isNone(yield* Effect.serviceOption(FlowRuntime.FlowInstance))).toBe(true)
          expect(capturedTable).toBeDefined()
          expect(Option.isSome(yield* capturedTable!.get(Shared.name))).toBe(true)
          expect(Option.isSome(yield* capturedTable!.get(HostOnly.name))).toBe(true)
          expect(Option.isNone(yield* capturedTable!.get("test/composition/absent"))).toBe(true)
        }).pipe(Effect.provide(Registry.layerProject({ root })))
      }).pipe(Effect.provide(hostActions), Effect.provide(await host()), Effect.scoped)
    )
  })

  it("lets an independently executed host child resolve its own same-tag implementation", async () => {
    const child = definition("host-child", Shared.call({ value: "child" }))
    const module = definition(
      "fixture",
      Node.all({
        own: Shared.call({ value: "parent" }),
        child: child.child({ value: "unused" })
      })
    )
    const hostActions = Layer.merge(
      Shared.toLayer(({ value }) => Effect.succeed(`host:${value}`)),
      Interpreter.layer(child)
    ).pipe(Layer.provideMerge(Action.layerImplementations))
    await Effect.runPromise(
      Effect.gen(function*() {
        const root = yield* project(["fixture"])
        yield* Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const executable = yield* Executable.fromDescriptor(yield* registry.get("fixture"), {
            delegates: [],
            load: () =>
              Effect.succeed({
                default: module,
                layer: Shared.toLayer(({ value }) => Effect.succeed(`module:${value}`))
              })
          })
          const runtime = yield* FlowRuntime.FlowRuntime
          const result = yield* runtime.execute(executable.flow, {
            payload: { input: { value: "unused" } },
            executionId: "composition-independent-child"
          }).pipe(Effect.provide(executable.layer))
          expect(result).toEqual({ own: "module:parent", child: "host:child" })
        }).pipe(Effect.provide(Registry.layerProject({ root })))
      }).pipe(Effect.provide(hostActions), Effect.provide(await host()), Effect.scoped)
    )
  })

  it("keeps a private child registered by the exported module layer on the module's same-tag implementation", async () => {
    const child = definition("module-private-child", Shared.call({ value: "child" }))
    const module = definition(
      "fixture",
      Node.all({
        own: Shared.call({ value: "parent" }),
        child: child.child({ value: "unused" })
      })
    )
    const hostActions = Shared.toLayer(({ value }) => Effect.succeed(`host:${value}`)).pipe(
      Layer.provideMerge(Action.layerImplementations)
    )
    await Effect.runPromise(
      Effect.gen(function*() {
        const root = yield* project(["fixture"])
        yield* Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const executable = yield* Executable.fromDescriptor(yield* registry.get("fixture"), {
            delegates: [],
            load: () =>
              Effect.succeed({
                default: module,
                layer: Layer.merge(
                  Shared.toLayer(({ value }) => Effect.succeed(`module:${value}`)),
                  Interpreter.layer(child)
                )
              })
          })
          const runtime = yield* FlowRuntime.FlowRuntime
          const result = yield* runtime.execute(executable.flow, {
            payload: { input: { value: "unused" } },
            executionId: "composition-module-private-child"
          }).pipe(Effect.provide(executable.layer))
          expect(result).toEqual({ own: "module:parent", child: "module:child" })
        }).pipe(Effect.provide(Registry.layerProject({ root })))
      }).pipe(Effect.provide(hostActions), Effect.provide(await host()), Effect.scoped)
    )
  })

  it("supports a module loaded without an ambient host table and returns None for unknown actions", async () => {
    const module = definition("fixture", Shared.call({ value: "local" }))
    await Effect.runPromise(
      Effect.gen(function*() {
        const root = yield* project(["fixture"])
        yield* Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const executable = yield* Executable.fromDescriptor(yield* registry.get("fixture"), {
            delegates: [],
            load: () =>
              Effect.succeed({
                default: module,
                layer: Shared.toLayer(({ value }) =>
                  Effect.gen(function*() {
                    const table = yield* Action.Implementations
                    expect(Option.isNone(yield* table.get("test/composition/absent"))).toBe(true)
                    return `local:${value}`
                  })
                )
              })
          }).pipe(
            Effect.updateContext((context: Context.Context<FileSystem.FileSystem | Path.Path>) =>
              context.pipe(Context.omit(Action.Implementations))
            )
          )
          const runtime = yield* FlowRuntime.FlowRuntime
          const result = yield* runtime.execute(executable.flow, {
            payload: { input: { value: "unused" } },
            executionId: "composition-without-host-table"
          }).pipe(Effect.provide(executable.layer))
          expect(result).toBe("local:local")
        }).pipe(Effect.provide(Registry.layerProject({ root })))
      }).pipe(Effect.provide(Action.layerImplementations), Effect.provide(await host()), Effect.scoped)
    )
  })

  it("keeps acquired resources alive across sequential registration consumers until the loading host closes", async () => {
    let acquired = 0
    let released = 0
    const module = definition("fixture", Shared.call({ value: "resource" }))
    const implementation = Layer.unwrap(Effect.map(
      Effect.acquireRelease(
        Effect.sync(() => {
          acquired++
          return { open: true }
        }),
        (resource) =>
          Effect.sync(() => {
            resource.open = false
            released++
          })
      ),
      (resource) =>
        Shared.toLayer(({ value }) => resource.open ? Effect.succeed(`open:${value}`) : Effect.die("closed resource"))
    ))
    await Effect.runPromise(
      Effect.gen(function*() {
        const root = yield* project(["fixture"])
        yield* Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const executable = yield* Executable.fromDescriptor(yield* registry.get("fixture"), {
            delegates: [],
            load: () => Effect.succeed({ default: module, layer: implementation })
          })
          const runtime = yield* FlowRuntime.FlowRuntime
          for (const id of ["first", "second"]) {
            const result = yield* runtime.execute(executable.flow, {
              payload: { input: { value: "unused" } },
              executionId: `composition-resource-${id}`
            }).pipe(Effect.provide(executable.layer), Effect.scoped)
            expect(result).toBe("open:resource")
            expect(acquired).toBe(1)
            expect(released).toBe(0)
          }
        }).pipe(Effect.provide(Registry.layerProject({ root })))
      }).pipe(Effect.provide(Action.layerImplementations), Effect.provide(await host()), Effect.scoped)
    )
    expect(released).toBe(1)
  })

  it("releases the original and subsequent module resources on refresh while the new entry still runs", async () => {
    let acquired = 0
    let released = 0
    const module = definition("fixture", Shared.call({ value: "resource" }))
    await Effect.runPromise(
      Effect.gen(function*() {
        const root = yield* project(["fixture"])
        const registrations = Executable.layer({
          delegates: [],
          load: () =>
            Effect.succeed({
              default: module,
              layer: Layer.unwrap(Effect.map(
                Effect.acquireRelease(
                  Effect.sync(() => ({ open: true, version: ++acquired })),
                  (resource) =>
                    Effect.sync(() => {
                      resource.open = false
                      released++
                    })
                ),
                (resource) =>
                  Shared.toLayer(({ value }) =>
                    resource.open
                      ? Effect.succeed(`open:${resource.version}:${value}`)
                      : Effect.die("refreshed resource closed")
                  )
              ))
            })
        }).pipe(Layer.provideMerge(Registry.layerProject({ root })))
        yield* Effect.gen(function*() {
          const catalog = yield* Executable.Catalog
          const refresh = yield* Executable.Refresh
          const runtime = yield* FlowRuntime.FlowRuntime
          const fs = yield* FileSystem.FileSystem
          expect(acquired).toBe(1)
          expect(released).toBe(0)
          for (const version of [2, 3]) {
            const retired = catalog.executables[0]!
            const path = join(root, "flows", "fixture", "flow.ts")
            yield* fs.writeFileString(path, `${yield* fs.readFileString(path)}\n// refresh ${version}\n`)
            const refreshed = yield* refresh.flow("fixture").pipe(Effect.scoped)
            expect(refreshed._tag).toBe("Registered")
            expect(acquired).toBe(version)
            expect(released).toBe(acquired - 1)
            const old = yield* Effect.exit(runtime.execute(retired.flow, {
              payload: { input: { value: "unused" } },
              executionId: `composition-retired-${version}`
            }))
            expect(Exit.isFailure(old)).toBe(true)
            if (Exit.isFailure(old)) {
              expect(Cause.pretty(old.cause)).toContain(`Flow ${retired.flow._tag} is not registered`)
            }
            const result = yield* runtime.execute(catalog.executables[0]!.flow, {
              payload: { input: { value: "unused" } },
              executionId: `composition-refresh-resource-${version}`
            })
            expect(result).toBe(`open:${version}:resource`)
            expect(
              yield* runtime.execute(module, {
                payload: { value: "unused" },
                executionId: `composition-refresh-default-${version}`
              })
            ).toBe(`open:${version}:resource`)
          }
          const removed = catalog.executables[0]!
          yield* fs.remove(join(root, "flows", "fixture"), { recursive: true })
          expect((yield* refresh.flow("fixture"))._tag).toBe("Removed")
          expect(released).toBe(acquired)
          const adapterExit = yield* Effect.exit(runtime.execute(removed.flow, {
            payload: { input: { value: "unused" } },
            executionId: "composition-removed-adapter"
          }))
          const defaultExit = yield* Effect.exit(runtime.execute(module, {
            payload: { value: "unused" },
            executionId: "composition-removed-default"
          }))
          for (const [flow, exit] of [[removed.flow, adapterExit], [module, defaultExit]] as const) {
            expect(Exit.isFailure(exit)).toBe(true)
            if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain(`Flow ${flow._tag} is not registered`)
          }
        }).pipe(Effect.provide(registrations))
      }).pipe(Effect.provide(Action.layerImplementations), Effect.provide(await host()), Effect.scoped)
    )
    expect(released).toBe(acquired)
  })

  it("cleans up interrupted initial loads after private-child registration while the host remains alive", async () => {
    let acquired = 0
    let released = 0
    let target: number | undefined
    let registered = false
    let operations = 0
    let interruptAt = 0
    let interrupted = 0
    let completed = 0
    const mixed = new Scheduler.MixedScheduler()
    const scheduler: Scheduler.Scheduler = {
      executionMode: mixed.executionMode,
      makeDispatcher: () => mixed.makeDispatcher(),
      shouldYield: (fiber) => {
        if (fiber.id !== target) return mixed.shouldYield(fiber)
        if (registered && ++operations === interruptAt) {
          interrupted++
          fiber.interruptUnsafe()
          return true
        }
        return false
      }
    }
    const child = definition("module-initial-load-child", Shared.call({ value: "child" }))
    const module = definition("fixture", Shared.call({ value: "default" }))
    await Effect.runPromise(
      Effect.gen(function*() {
        const root = yield* project(["fixture"])
        const runtime = yield* FlowRuntime.FlowRuntime
        const observed = FlowRuntime.FlowRuntime.of({
          ...runtime,
          register: (flow, execute) =>
            runtime.register(flow, execute).pipe(Effect.tap(() =>
              Effect.sync(() => {
                if (target !== undefined && flow._tag === child._tag) registered = true
              })
            ))
        })
        yield* Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const descriptor = yield* registry.get("fixture")
          const hostScope = yield* Effect.scope
          // Offsets 1..13 cover construction through the confirmed post-build
          // failure gap. Later interruption of a successful constructor's
          // finalizer/return follows ownership transfer, like a committed
          // refresh; it does not require rolling back host-owned resources.
          // Offset 0 is an uninterrupted return and loading-host release control.
          for (const offset of [...Array.from({ length: 13 }, (_, index) => index + 1), 0]) {
            let returned: Executable.Executable | undefined
            const loadingScope = yield* Scope.fork(hostScope)
            registered = false
            operations = 0
            interruptAt = offset
            const fiber = yield* Effect.withFiber((fiber) => {
              target = fiber.id
              return Executable.fromDescriptor(descriptor, {
                delegates: [],
                load: () =>
                  Effect.succeed({
                    default: module,
                    layer: Layer.unwrap(Effect.map(
                      Effect.acquireRelease(
                        Effect.sync(() => ({ open: true, version: ++acquired })),
                        (resource) =>
                          Effect.sync(() => {
                            resource.open = false
                            released++
                          })
                      ),
                      (resource) =>
                        Layer.merge(
                          Shared.toLayer(({ value }) =>
                            resource.open
                              ? Effect.succeed(`open:${resource.version}:${value}`)
                              : Effect.die("initial-load resource closed")
                          ),
                          Interpreter.layer(child)
                        )
                    ))
                  })
              }).pipe(
                Effect.tap((executable) => {
                  // Observe the constructor's return before the surrounding
                  // caller restores its provided services or finishes its fiber.
                  returned = executable
                  target = undefined
                  return Effect.void
                }),
                Effect.provideService(Scope.Scope, loadingScope)
              )
            }).pipe(Effect.forkChild)
            const callerExit = yield* Fiber.await(fiber)
            target = undefined
            if (Exit.isFailure(callerExit)) expect(Cause.hasInterruptsOnly(callerExit.cause)).toBe(true)
            if (returned === undefined) {
              expect(Exit.isFailure(callerExit)).toBe(true)
              // Do not close the loading scope yet: a timed-out catalog keeps
              // its host alive, so failed acquisition must clean itself up.
              expect(released, `initial-load resources at scheduler offset ${offset}`).toBe(acquired)
              const childExit = yield* Effect.exit(runtime.execute(child, {
                payload: { value: "unused" },
                executionId: `composition-initial-refused-child-${offset}`
              }))
              expect(Exit.isFailure(childExit)).toBe(true)
              if (Exit.isFailure(childExit)) {
                expect(Cause.pretty(childExit.cause)).toContain(`Flow ${child._tag} is not registered`)
              }
            } else {
              completed++
              expect(released).toBe(acquired - 1)
              expect(
                yield* runtime.execute(child, {
                  payload: { value: "unused" },
                  executionId: `composition-initial-child-${offset}`
                })
              ).toBe(`open:${acquired}:child`)
              expect(
                yield* runtime.execute(returned.flow, {
                  payload: { input: { value: "unused" } },
                  executionId: `composition-initial-default-${offset}`
                }).pipe(Effect.provide(returned.layer))
              ).toBe(`open:${acquired}:default`)
            }
            yield* Scope.close(loadingScope, Exit.void)
            expect(released).toBe(acquired)
          }
          expect(interrupted).toBeGreaterThan(0)
          expect(completed).toBeGreaterThan(0)
        }).pipe(
          Effect.provide(Registry.layerProject({ root })),
          Effect.provideService(FlowRuntime.FlowRuntime, observed)
        )
      }).pipe(
        Effect.provide(Action.layerImplementations),
        Effect.provide(await host()),
        Effect.provideService(Scheduler.Scheduler, scheduler),
        Effect.scoped
      )
    )
    expect(released).toBe(acquired)
  })

  it("retires resources and every registration when removal is interrupted after catalog publication", async () => {
    let acquired = 0
    let released = 0
    let target: number | undefined
    let catalog: Executable.Catalog | undefined
    let operations = 0
    let interruptAt = 0
    let interrupted = 0
    const mixed = new Scheduler.MixedScheduler()
    const scheduler: Scheduler.Scheduler = {
      executionMode: mixed.executionMode,
      makeDispatcher: () => mixed.makeDispatcher(),
      shouldYield: (fiber) => {
        if (fiber.id !== target) return mixed.shouldYield(fiber)
        if (catalog?.executables.length === 0 && ++operations === interruptAt) {
          interrupted++
          fiber.interruptUnsafe()
          return true
        }
        return false
      }
    }
    const child = definition("module-removed-private-child", Shared.call({ value: "child" }))
    const module = definition("fixture", Shared.call({ value: "default" }))
    await Effect.runPromise(
      Effect.gen(function*() {
        const root = yield* project(["fixture"])
        const fs = yield* FileSystem.FileSystem
        const path = join(root, "flows", "fixture", "flow.ts")
        const original = yield* fs.readFileString(path)
        const registrations = Executable.layer({
          delegates: [],
          load: () =>
            Effect.succeed({
              default: module,
              layer: Layer.unwrap(Effect.map(
                Effect.acquireRelease(
                  Effect.sync(() => ({ open: true, version: ++acquired })),
                  (resource) =>
                    Effect.sync(() => {
                      resource.open = false
                      released++
                    })
                ),
                (resource) =>
                  Layer.merge(
                    Shared.toLayer(({ value }) =>
                      resource.open
                        ? Effect.succeed(`open:${resource.version}:${value}`)
                        : Effect.die("removed resource closed")
                    ),
                    Interpreter.layer(child)
                  )
              ))
            })
        }).pipe(Layer.provideMerge(Registry.layerProject({ root })))
        yield* Effect.gen(function*() {
          catalog = yield* Executable.Catalog
          const refresh = yield* Executable.Refresh
          const runtime = yield* FlowRuntime.FlowRuntime
          for (const offset of Array.from({ length: 50 }, (_, index) => index + 1)) {
            const removed = catalog.executables[0]!
            yield* fs.remove(path)
            operations = 0
            interruptAt = offset
            const fiber = yield* Effect.withFiber((fiber) => {
              target = fiber.id
              return refresh.flow("fixture")
            }).pipe(Effect.forkChild)
            const exit = yield* Fiber.await(fiber)
            target = undefined
            if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
            expect(catalog.executables).toHaveLength(0)
            expect(released, `removed resources at scheduler offset ${offset}`).toBe(acquired)
            const adapterExit = yield* Effect.exit(runtime.execute(removed.flow, {
              payload: { input: { value: "unused" } },
              executionId: `composition-removal-adapter-${offset}`
            }))
            const defaultExit = yield* Effect.exit(runtime.execute(module, {
              payload: { value: "unused" },
              executionId: `composition-removal-default-${offset}`
            }))
            const childExit = yield* Effect.exit(runtime.execute(child, {
              payload: { value: "unused" },
              executionId: `composition-removal-child-${offset}`
            }))
            for (
              const [flow, result] of [[removed.flow, adapterExit], [module, defaultExit], [child, childExit]] as const
            ) {
              expect(Exit.isFailure(result)).toBe(true)
              if (Exit.isFailure(result)) {
                expect(Cause.pretty(result.cause)).toContain(`Flow ${flow._tag} is not registered`)
              }
            }
            if (offset < 50) {
              yield* fs.writeFileString(path, original)
              expect((yield* refresh.flow("fixture"))._tag).toBe("Registered")
              expect(released).toBe(acquired - 1)
              expect(
                yield* runtime.execute(module, {
                  payload: { value: "unused" },
                  executionId: `composition-removal-recovery-${offset}`
                })
              ).toBe(`open:${acquired}:default`)
            }
          }
          expect(interrupted).toBeGreaterThan(0)
        }).pipe(Effect.provide(registrations))
      }).pipe(
        Effect.provide(Action.layerImplementations),
        Effect.provide(await host()),
        Effect.provideService(Scheduler.Scheduler, scheduler),
        Effect.scoped
      )
    )
    expect(released).toBe(acquired)
  })

  it("cleans up interrupted refreshes across registration-to-commit scheduler boundaries", async () => {
    let acquired = 0
    let released = 0
    let target: number | undefined
    let registered = 0
    let operations = 0
    let interruptAt = 0
    let interrupted = 0
    const mixed = new Scheduler.MixedScheduler()
    const scheduler: Scheduler.Scheduler = {
      executionMode: mixed.executionMode,
      makeDispatcher: () => mixed.makeDispatcher(),
      shouldYield: (fiber) => {
        if (fiber.id !== target) return mixed.shouldYield(fiber)
        if (registered === 2 && ++operations === interruptAt) {
          interrupted++
          fiber.interruptUnsafe()
          return true
        }
        return false
      }
    }
    const module = definition("fixture", Shared.call({ value: "resource" }))
    await Effect.runPromise(
      Effect.gen(function*() {
        const root = yield* project(["fixture"])
        const runtime = yield* FlowRuntime.FlowRuntime
        const observed = FlowRuntime.FlowRuntime.of({
          ...runtime,
          register: (flow, execute) =>
            runtime.register(flow, execute).pipe(Effect.tap(() =>
              Effect.sync(() => {
                if (target !== undefined && (flow._tag === "fixture" || flow._tag.startsWith("registry/entry/"))) {
                  registered++
                }
              })
            ))
        })
        const registrations = Executable.layer({
          delegates: [],
          load: () =>
            Effect.succeed({
              default: module,
              layer: Layer.unwrap(Effect.map(
                Effect.acquireRelease(
                  Effect.sync(() => ({ open: true, version: ++acquired })),
                  (resource) =>
                    Effect.sync(() => {
                      resource.open = false
                      released++
                    })
                ),
                (resource) =>
                  Shared.toLayer(({ value }) =>
                    resource.open
                      ? Effect.succeed(`open:${resource.version}:${value}`)
                      : Effect.die("interrupted refresh resource closed")
                  )
              ))
            })
        }).pipe(Layer.provideMerge(Registry.layerProject({ root })))
        yield* Effect.gen(function*() {
          const catalog = yield* Executable.Catalog
          const refresh = yield* Executable.Refresh
          const fs = yield* FileSystem.FileSystem
          const path = join(root, "flows", "fixture", "flow.ts")
          let liveVersion = acquired
          let retained = 0
          let committed = 0
          // Interrupt at successive primitive boundaries after both real
          // registrations finish, covering build completion and the commit.
          for (const offset of Array.from({ length: 100 }, (_, index) => index + 1)) {
            yield* fs.writeFileString(path, `${yield* fs.readFileString(path)}\n// interrupt ${offset}\n`)
            const previous = catalog.executables[0]
            registered = 0
            operations = 0
            interruptAt = offset
            const fiber = yield* Effect.withFiber((fiber) => {
              target = fiber.id
              return refresh.flow("fixture")
            }).pipe(Effect.forkChild)
            yield* Fiber.await(fiber)
            target = undefined
            if (catalog.executables[0] !== previous) {
              liveVersion = acquired
              committed++
            } else retained++
            expect(released, `resources after scheduler offset ${offset}`).toBe(acquired - 1)
            expect(
              yield* runtime.execute(module, {
                payload: { value: "unused" },
                executionId: `composition-interrupt-default-${offset}`
              })
            ).toBe(`open:${liveVersion}:resource`)
            expect(
              yield* runtime.execute(catalog.executables[0]!.flow, {
                payload: { input: { value: "unused" } },
                executionId: `composition-interrupt-adapter-${offset}`
              })
            ).toBe(`open:${liveVersion}:resource`)
          }
          expect(interrupted).toBeGreaterThan(0)
          expect(retained).toBeGreaterThan(0)
          expect(committed).toBeGreaterThan(0)
        }).pipe(Effect.provide(registrations), Effect.provideService(FlowRuntime.FlowRuntime, observed))
      }).pipe(
        Effect.provide(Action.layerImplementations),
        Effect.provide(await host()),
        Effect.provideService(Scheduler.Scheduler, scheduler),
        Effect.scoped
      )
    )
    expect(released).toBe(acquired)
  })

  it("runs a valid module while retaining a named refusal for another module even under Layer.orDie", async () => {
    const good = definition("good", Shared.call({ value: "valid" }))
    const bad = definition("bad", Shared.call({ value: "invalid" }))
    await Effect.runPromise(
      Effect.gen(function*() {
        const root = yield* project(["good", "bad"])
        const registrations = Executable.layer({
          delegates: [],
          load: (path) =>
            Effect.succeed(
              basename(dirname(path)) === "good"
                ? { default: good, layer: Shared.toLayer(({ value }) => Effect.succeed(`good:${value}`)) }
                : { default: bad, layer: Layer.unwrap(Effect.map(Missing, () => Layer.empty)) }
            )
        }).pipe(Layer.orDie, Layer.provideMerge(Registry.layerProject({ root })))
        yield* Effect.gen(function*() {
          const catalog = yield* Executable.Catalog
          expect(catalog.executables.map((entry) => entry.descriptor.name)).toEqual(["good"])
          expect(catalog.refused).toHaveLength(1)
          expect(catalog.refused[0]).toBeInstanceOf(Executable.ExecutableError)
          expect(catalog.refused[0]).toMatchObject({ code: "missing_service", flow: "bad", service: Missing.key })
          const runtime = yield* FlowRuntime.FlowRuntime
          const result = yield* runtime.execute(catalog.executables[0]!.flow, {
            payload: { input: { value: "unused" } },
            executionId: "composition-mixed-catalog"
          })
          expect(result).toBe("good:valid")
        }).pipe(Effect.provide(registrations))
      }).pipe(Effect.provide(Action.layerImplementations), Effect.provide(await host()), Effect.scoped)
    )
  })
})
