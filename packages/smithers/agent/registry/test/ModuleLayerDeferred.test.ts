/**
 * A module action asking for an unsupplied service only inside its handler is
 * refused by name on its first call (#2923); every other failure is untouched.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Context, Effect, Exit, FileSystem, Layer, Schema } from "effect"
import { createRequire } from "node:module"
import { join } from "node:path"
import { expect, it, vi } from "vitest"
import * as Discovery from "../src/Discovery.ts"
import * as Executable from "../src/Executable.ts"

class Unsupplied extends Context.Service<Unsupplied, string>()("test/module-deferred/Unsupplied") {}
class Refused extends Schema.TaggedError<Refused>()("test/module-deferred/Refused", {}) {}

const run = async (handler: (value: string) => Effect.Effect<string, Refused, never>) => {
  const require = createRequire(import.meta.url)
  const enginePath = require.resolve("@smthrs/engine", { paths: [require.resolve("@smthrs/engine-store")] })
  const { FlowEngine } = await vi.importActual<{
    readonly FlowEngine: { readonly layerMemory: Layer.Layer<FlowRuntime.FlowRuntime> }
  }>(enginePath)
  const Write = Action.make("test/module-deferred/Write", {
    payload: { value: Schema.String },
    success: Schema.String,
    error: Refused
  })
  const flow = Flow.make("fixture", {
    description: "A module whose handler needs a service no host supplies.",
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
    payload: { value: Schema.String },
    success: Schema.String,
    error: Refused,
    body: Node.capture({ action: Write.name }, Write.call)
  })
  const moduleLayer = Write.toLayer(({ value }) => handler(value))
  return await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "registry-module-deferred-" })
      const directory = join(root, "flows", "fixture")
      yield* fs.makeDirectory(directory, { recursive: true })
      yield* fs.writeFileString(
        join(directory, "flow.ts"),
        `
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"
export default Flow.make("fixture", {
  description: "A module whose handler needs a service no host supplies.",
  payload: {}, success: Schema.String, body: () => Node.succeed("unused")
})
`
      )
      const discovery = yield* Discovery.Discovery
      const scanned = yield* discovery.scan({ source: "project", root: join(root, "flows"), naming: "path" })
      // Loading succeeds: no construction-time lookup reveals the requirement.
      const executable = yield* Executable.fromDescriptor(scanned.entries[0]!, {
        delegates: [],
        load: () => Effect.succeed({ default: flow, layer: moduleLayer })
      })
      yield* Layer.build(executable.layer)
      const runtime = yield* FlowRuntime.FlowRuntime
      return yield* Effect.exit(runtime.execute(executable.flow, {
        payload: { input: { value: "first" } },
        executionId: "module-deferred-first"
      }))
    }).pipe(
      Effect.provide(Discovery.layer),
      Effect.provide(Layer.mergeAll(
        FlowEngine.layerMemory,
        Action.layerImplementations,
        NodeFileSystem.layer,
        NodePath.layer,
        NodeCrypto.layer
      )),
      Effect.scoped
    )
  )
}

it("refuses a handler-only unsupplied service as missing_service naming the flow and service", async () => {
  // A loaded module's types are erased: the requirement is invisible at load.
  const exit = await run((value) =>
    Effect.map(Unsupplied, (prefix: string) => `${prefix}:${value}`) as Effect.Effect<string, never, never>
  )
  expect(Exit.isFailure(exit)).toBe(true)
  if (Exit.isFailure(exit)) {
    const defects = exit.cause.reasons.flatMap((reason) => reason._tag === "Die" ? [reason.defect] : [])
    expect(defects).toEqual([expect.objectContaining({
      _tag: "flows/registry/ExecutableError",
      code: "missing_service",
      flow: "fixture",
      service: "test/module-deferred/Unsupplied",
      message:
        `flow "fixture" requires host service "test/module-deferred/Unsupplied" to run action "test/module-deferred/Write"`
    })])
  }
})

it("leaves a handler's own failure and a supplied service untouched", async () => {
  const failed = await run(() => Effect.fail(new Refused()))
  expect(Exit.isFailure(failed)).toBe(true)
  if (Exit.isFailure(failed)) {
    expect(failed.cause.reasons.map((reason) => reason._tag)).toEqual(["Fail"])
    expect(Cause.squash(failed.cause)).toBeInstanceOf(Refused)
  }
  const done = await run((value) => Effect.succeed(`ok:${value}`))
  expect(done).toEqual(Exit.succeed("ok:first"))
})
