/** Retiring one local execution joins its callbacks and keeps other work alive. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Deferred, Effect, Exit, Fiber, FileSystem, Layer, Schema } from "effect"
import { createRequire } from "node:module"
import { describe, expect, it, vi } from "vitest"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"

const platform = Layer.mergeAll(NodeCrypto.layer, NodeFileSystem.layer, NodePath.layer)

describe("module callback quiescence", () => {
  it.each([true, false])(
    "joins selected callbacks and preserves unrelated work (exported layer: %s)",
    async (exported) => {
      const require = createRequire(import.meta.url)
      const enginePath = require.resolve("@smthrs/engine", { paths: [require.resolve("@smthrs/engine-store")] })
      const { FlowEngine } = await vi.importActual<{
        readonly FlowEngine: { readonly layerMemory: Layer.Layer<FlowRuntime.FlowRuntime> }
      }>(enginePath)
      const callbacks = new Map<string, (payload: unknown, executionId: string) => Effect.Effect<unknown, unknown>>()
      const observedRuntime = Layer.effect(
        FlowRuntime.FlowRuntime,
        Effect.map(FlowRuntime.FlowRuntime, (runtime) =>
          FlowRuntime.FlowRuntime.of({
            ...runtime,
            register: (declaration, handler) => {
              callbacks.set(declaration._tag, handler as never)
              return runtime.register(declaration, handler)
            }
          }))
      ).pipe(Layer.provideMerge(FlowEngine.layerMemory))
      const calls: Array<string> = []
      const finalized: Array<string> = []
      const Probe = Action.make("quiesce/Probe", { payload: { label: Schema.String }, success: Schema.String })
      const flow = Flow.make("fixture", {
        description: "Callback quiescence",
        payload: { label: Schema.String },
        success: Schema.String,
        body: Node.capture({}, Probe.call)
      })
      await Effect.runPromise(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "registry-quiesce-" })
          yield* fs.makeDirectory(`${root}/flows/fixture`, { recursive: true })
          yield* fs.writeFileString(
            `${root}/flows/fixture/flow.ts`,
            `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("fixture", { description: "Callback quiescence", payload: { label: Schema.String }, success: Schema.String,
body: Node.capture({}, ({ label }) => Node.succeed(label)) })`
          )
          const scanned = yield* (yield* Discovery.Discovery).scan({
            source: "project",
            root: `${root}/flows`,
            naming: "path"
          })
          const selected = yield* Deferred.make<void>()
          const unrelated = yield* Deferred.make<void>()
          const releaseUnrelated = yield* Deferred.make<void>()
          const implementation = Probe.toLayer(({ label }) =>
            Effect.gen(function*() {
              calls.push(label)
              if (label === "selected") {
                yield* Deferred.succeed(selected, undefined)
                yield* Effect.never
              }
              if (label === "unrelated") {
                yield* Deferred.succeed(unrelated, undefined)
                yield* Deferred.await(releaseUnrelated)
              }
              return label
            }).pipe(Effect.ensuring(Effect.sync(() => {
              finalized.push(label)
            })))
          )
          if (!exported) yield* Layer.build(implementation)
          const executable = yield* Executable.fromDescriptor(scanned.entries[0]!, {
            delegates: [],
            load: () => Effect.succeed({ default: flow, ...(exported ? { layer: implementation } : {}) })
          })
          yield* Layer.build(executable.layer)
          const runtime = yield* FlowRuntime.FlowRuntime
          const first = yield* runtime.execute(executable.flow, {
            payload: { input: { label: "selected" } },
            executionId: "selected-id"
          }).pipe(Effect.forkChild)
          const other = yield* runtime.execute(executable.flow, {
            payload: { input: { label: "unrelated" } },
            executionId: "unrelated-id"
          }).pipe(Effect.forkChild)
          yield* Deferred.await(selected)
          yield* Deferred.await(unrelated)
          yield* executable.quiesce!(["selected-id"])
          expect(finalized).toEqual(["selected"])
          expect(Exit.isFailure(yield* Fiber.await(first))).toBe(true)
          expect(calls).toEqual(["selected", "unrelated"])
          yield* Deferred.succeed(releaseUnrelated, undefined)
          expect(yield* Fiber.join(other)).toBe("unrelated")
          // Invoke the actual registered callback directly: engine result replay
          // must not be what prevents a retired callback entering its old table.
          const retired = yield* callbacks.get(executable.flow._tag)!({ input: { label: "retired" } }, "selected-id")
            .pipe(Effect.exit)
          expect(Exit.isFailure(retired)).toBe(true)
          expect(calls).not.toContain("retired")
          const newImplementation = Probe.toLayer(({ label }) => Effect.succeed(`new:${label}`))
          const refreshedFlow = exported ? flow : Flow.make("fixture", {
            description: "Callback quiescence",
            payload: { label: Schema.String },
            success: Schema.String,
            body: Node.capture({}, ({ label }) => Probe.call({ label: `new:${label}` }))
          })
          const refreshed = yield* Executable.fromDescriptor(scanned.entries[0]!, {
            delegates: [],
            load: () => Effect.succeed({ default: refreshedFlow, ...(exported ? { layer: newImplementation } : {}) })
          })
          yield* Layer.build(refreshed.layer)
          expect(
            yield* runtime.execute(refreshed.flow, { payload: { input: { label: "fresh" } }, executionId: "fresh-id" })
          ).toBe("new:fresh")
        }).pipe(
          Effect.provide(Discovery.layer),
          Effect.provide(Layer.mergeAll(observedRuntime, Action.layerImplementations)),
          Effect.provide(platform),
          Effect.scoped,
          Effect.timeout("20 seconds")
        )
      )
    },
    30_000
  )
})
