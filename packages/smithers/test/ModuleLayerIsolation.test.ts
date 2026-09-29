/** Module-local action tables survive callers and refresh on a real engine. */
import { NodeCrypto, NodeFileSystem, NodePath } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Context, Effect, Layer } from "effect"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

class HostPrefix extends Context.Service<HostPrefix, string>()("test/module/HostPrefix") {}
const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)
const host = Layer.mergeAll(platform, FlowEngine.layerMemory, Action.layerImplementations)
const nodeModules = fileURLToPath(new URL("../node_modules", import.meta.url))
const source = (name: string, version: string, prefix = false) => `
import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Effect, Layer, Schema } from "effect"
class HostPrefix extends Context.Service()("test/module/HostPrefix") {}
const Work = Action.make("fixture/Shared", { payload: { value: Schema.String }, success: Schema.String })
export const layer = ${
  prefix
    ? `Layer.unwrap(Effect.map(HostPrefix, prefix => Work.toLayer(({ value }) => Effect.succeed(prefix + ":${version}:" + value))))`
    : `Work.toLayer(({ value }) => Effect.succeed("${version}:" + value))`
}
export default Flow.make("${name}", {
  description: "A module-local action.", payload: { value: Schema.String }, success: Schema.String,
  capabilities: [], effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  body: Node.capture({ action: Work.name }, ({ value }) => Work.call({ value }))
})
`

const project = async (flows: Readonly<Record<string, string>>) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-module-isolation-"))
  await symlink(nodeModules, join(root, "node_modules"), "dir")
  for (const [name, text] of Object.entries(flows)) {
    await mkdir(join(root, "flows", name), { recursive: true })
    await writeFile(join(root, "flows", name, "flow.ts"), text)
  }
  return root
}

describe("module action isolation", () => {
  it("keeps two module .call implementations with the same action tag distinct", async () => {
    const root = await project({ first: source("first", "first"), second: source("second", "second") })
    try {
      const results = await Effect.runPromise(
        Effect.gen(function*() {
          const registry = yield* Registry.Registry
          const first = yield* Executable.fromDescriptor(yield* registry.get("first"), { delegates: [] })
          const second = yield* Executable.fromDescriptor(yield* registry.get("second"), { delegates: [] })
          return yield* Effect.gen(function*() {
            const runtime = yield* FlowRuntime.FlowRuntime
            return [
              yield* runtime.execute(first.flow, { payload: { input: { value: "input" } }, executionId: "first" }),
              yield* runtime.execute(second.flow, { payload: { input: { value: "input" } }, executionId: "second" }),
              yield* runtime.execute(first.flow, { payload: { input: { value: "again" } }, executionId: "first-again" })
            ]
          }).pipe(Effect.provide(Layer.merge(first.layer, second.layer)))
        }).pipe(Effect.provide(Registry.layerProject({ root })), Effect.provide(host), Effect.scoped)
      )
      expect(results).toEqual(["first:input", "second:input", "first:again"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("refreshes with registration host services and keeps implementations alive after a scoped caller closes", async () => {
    const root = await project({ refreshed: source("refreshed", "first", true) })
    try {
      const registration = Executable.layer({ delegates: [] }).pipe(
        Layer.provideMerge(Registry.layerProject({ root })),
        Layer.provide(Layer.succeed(HostPrefix, "host"))
      )
      const result = await Effect.runPromise(
        Effect.gen(function*() {
          const refresh = yield* Executable.Refresh
          const catalog = yield* Executable.Catalog
          yield* Effect.promise(() =>
            writeFile(join(root, "flows", "refreshed", "flow.ts"), source("refreshed", "second", true))
          )
          const refreshed = yield* refresh.flow("refreshed").pipe(
            Effect.provideService(HostPrefix, "caller"),
            Effect.scoped
          )
          expect(refreshed._tag).toBe("Registered")
          const runtime = yield* FlowRuntime.FlowRuntime
          return yield* runtime.execute(catalog.executables[0]!.flow, {
            payload: { input: { value: "after-caller-close" } },
            executionId: "refreshed"
          })
        }).pipe(Effect.provide(registration), Effect.provide(host), Effect.scoped)
      )
      expect(result).toBe("host:second:after-caller-close")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
