/** C-SEC-02 guest runner. Bundle with the production coding-host bundler. */
import { NodeServices } from "@effect/platform-node"
import { Flow, Graph } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Executable from "@smthrs/registry/Executable"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, Schema } from "effect"
import assert from "node:assert/strict"
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { share } from "../../coding/host-modules.ts"
import { systemFlowsFromEnv } from "../../coding/host.ts"
import { bindRepositoryRegistry, repositoryCatalog } from "../../repository/registry.ts"

assert.equal(process.getuid?.(), 1000, "canary requires the unprivileged image user")
assert.equal(process.getgid?.(), 1000, "canary requires the unprivileged image group")

const systemFlows = systemFlowsFromEnv(process.env)
share()
const source = resolve(process.argv[2] ?? ".")
const root = await mkdtemp(join(tmpdir(), "flw-canary-repository-"))
await cp(source, root, { recursive: true })
const packagedRoot = await mkdtemp(join(tmpdir(), "flw-canary-packaged-"))
try {
  await mkdir(join(packagedRoot, "merge"))
  await writeFile(join(packagedRoot, "merge", "flow.ts"), `
import { Flow } from "@smthrs/flow"
import { Schema } from "effect"
export default Flow.make("merge", {
  description: "Packaged merge fixture.", capabilities: [],
  payload: {}, success: Schema.String
})
`)
  const result = await Effect.runPromise(Effect.gen(function*() {
    const registryAt = (directory: string, source: string) => Registry.make({
      sources: [{ root: directory, source, naming: "path" }]
    }).pipe(Effect.provide(Discovery.layer))
    const project = yield* registryAt(join(root, "flows"), "project")
    const packaged = yield* registryAt(packagedRoot, "repository-host")
    const registry = bindRepositoryRegistry(project, packaged, "a".repeat(64), systemFlows)
    const catalog = yield* repositoryCatalog({ delegates: [] }, () => Effect.succeed({
      default: Flow.make("merge", {
        payload: {},
        success: Schema.String,
        body: () => Node.succeed("packaged-merge")
      })
    })).pipe(Effect.provideService(Registry.Registry, registry))
    assert.deepEqual(catalog.refused.map(({ flow, code }) => ({ flow, code })), [
      { flow: "merge", code: "reserved_name" },
      { flow: "todo", code: "missing_service" }
    ])
    assert.equal(catalog.executables.find((entry) => entry.descriptor.name === "merge")?.descriptor.provenance.source,
      "repository-host")
    // Generic TODO dispatch remains fenced until pinned-attempt activation.
    // This canary qualifies imports in the guest, not the TODO lifecycle.
    // Load only TODO through the guest's project loader; never expose merge
    // to this discovery catalog or bypass its system-name refusal.
    const todoCatalog = yield* Executable.catalog({ delegates: [] }).pipe(
      Effect.provideService(Registry.Registry, {
        ...project,
        list: () => project.list().pipe(Effect.map((entries) => entries.filter((entry) => entry.name === "todo")))
      })
    )
    assert.deepEqual(todoCatalog.refused, [])
    const planned = ["todo", "canary"].map((name) => {
      const entry = (name === "todo" ? todoCatalog : catalog).executables.find((entry) => entry.descriptor.name === name)
      assert.ok(entry, `${name} must be admitted in the guest`)
      assert.equal(entry.descriptor.provenance.source, "project")
      const graph = Graph.build(entry.flow, { input: {} })
      Graph.drafts(graph)
      const values = graph.nodes.filter((node) => node.kind === "Succeed").map((node) => node.payload)
      assert.ok(values.length > 0, `${name} must produce a success node`)
      return { name, values }
    })
    return {
      receipt: "flow-isolation-canary",
      home: process.env.HOME,
      uid: process.getuid?.(),
      gid: process.getgid?.(),
      planned,
      refused: catalog.refused.map(({ flow, code }) => ({ flow, code }))
    }
  }).pipe(Effect.provide(NodeServices.layer)))
  process.stdout.write(`${JSON.stringify(result)}\n`)
} finally {
  await rm(packagedRoot, { recursive: true, force: true })
  await rm(root, { recursive: true, force: true })
}
