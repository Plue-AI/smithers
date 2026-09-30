import { NodeServices } from "@effect/platform-node"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Effect } from "effect"
import { join } from "node:path"
import { bindRepositoryRegistry, provisionBuiltins } from "../../repository/registry.ts"

const root = process.argv[2]
if (root === undefined) throw new Error("Expected a fresh repository root")
const input = { args: JSON.stringify({ pullRequest: { number: 17 }, patch: "+return 17" }) }
const found = await Effect.runPromise(Effect.gen(function*() {
  const builtins = yield* provisionBuiltins(join(root, "state"), "a".repeat(64))
  const project = yield* Registry.make({
    sources: [{ root: join(root, "repository", "flows"), source: "project", naming: "path" }]
  }).pipe(Effect.provide(Discovery.layer))
  const registry = bindRepositoryRegistry(project, builtins.registry, "a".repeat(64))
  const descriptor = yield* registry.get("pr-triage")
  const body = yield* registry.loadBody("pr-triage")
  const prompt = yield* registry.runPrompt("pr-triage", input)
  return { descriptor, body, prompt }
}).pipe(Effect.provide(NodeServices.layer)))
process.stdout.write(JSON.stringify({
  name: found.descriptor.name,
  source: found.descriptor.provenance.source,
  capabilities: found.descriptor.capabilities,
  bodyKind: found.body._tag,
  model: found.descriptor.model,
  prompt: found.prompt
}))
