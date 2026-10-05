import { NodeServices } from "@effect/platform-node"
import { Flow, Graph } from "@smthrs/flow"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Effect } from "effect"
// The coding host's own composition, so this bundle shares exactly what the
// packaged host shares (build.mjs serves the modules the bundle runs).
import "../../coding/host.ts"
import { share } from "../../coding/host-modules.ts"
import Request from "../../coding/request/flow.ts"
import Vibe from "../../coding/vibe/flow.ts"

// A packaged host discovers a repository's `flows/todo/flow.ts`, measures its
// digest and loads it with its own loader, as flow-load will (spec §11.3.1).
// The registry the host binds keeps `todo` dark until pinned-source
// activation, so this reads the project registry directly. Arguments: the
// repository's flows root, a repository module re-exporting the step entry
// point, and the JSON payload to build the composition's graph with.
share()
const [flowsRoot, probe, payload] = process.argv.slice(2) as [string, string, string]
const { descriptor, built } = await Effect.gen(function*() {
  const registry = yield* Registry.make({ sources: [{ root: flowsRoot, source: "project", naming: "path" }] }).pipe(
    Effect.provide(Discovery.layer)
  )
  return {
    descriptor: yield* registry.get("todo"),
    built: yield* Executable.catalog({ delegates: [] }).pipe(Effect.provideService(Registry.Registry, registry))
  }
}).pipe(Effect.provide(NodeServices.layer), Effect.runPromise)
const copy: unknown = (await import(`${flowsRoot}/todo/flow.ts`)).default
if (!Flow.isFlow(copy)) throw new Error("The repository copy is not a Flow.make value")
const steps = (await import(probe)) as Record<string, unknown>
process.stdout.write(`${
  JSON.stringify({
    refused: built.refused.map(({ flow, code, message }) => `${flow} ${code}: ${message}`),
    loaded: built.executables.find((entry) => entry.descriptor.name === "todo")?.declaredTag,
    digest: Descriptor.executionDigest(descriptor),
    imports: descriptor.body._tag === "Module" ? descriptor.body.imports ?? [] : undefined,
    calls: Graph.build(copy, JSON.parse(payload)).nodes.map(({ ast }) =>
      ast._tag === "FlowCall" ? ast.flow : ast._tag === "ActionCall" ? ast.action : ast._tag
    ),
    exports: Object.keys(steps).sort(),
    hostSteps: steps.Request === Request && steps.Vibe === Vibe
  })
}\n`)
