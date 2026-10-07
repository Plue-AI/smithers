import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import * as Registry from "@smthrs/registry/Registry"
import { layerRegistry } from "../../../packages/smithers/src/NodeControl.ts"
import { bindRepositoryRegistry, provisionBuiltins } from "../../repository/registry.ts"
// The coding host's own composition, so this bundle shares exactly what the
// packaged host shares and flow-load loads a repository's flows with it.
import "../../coding/host.ts"
import { loadRepositoryFlows } from "../../coding/flow-load.ts"
import { share } from "../../coding/host-modules.ts"
import { systemFlows } from "./system-flows.ts"

// Arguments: one repository root per load. Prints one `versions <json>` line
// per root (the catalog's own warnings share stdout).
share()
for (const repository of process.argv.slice(2)) {
  const versions = await loadRepositoryFlows(repository, systemFlows, { PATH: process.env.CODING_TEST_MANAGER_PATH ?? "/usr/bin:/bin" }).pipe(
    Effect.provide(NodeServices.layer),
    Effect.runPromise
  )
  for (const version of versions.filter((entry) => process.env.CODING_TEST_PIN_ADMISSION === "1" && entry.name === "todo" && entry.status === "loaded")) {
    await Effect.gen(function*() {
      // Enter the coding host's project registry and admitted-pin guard using
      // flow-load's output. It must accept the same execution identity.
      const project = yield* Registry.Registry
      const builtins = yield* provisionBuiltins(`${repository}/.host-state`, "a".repeat(64))
      const pinned = bindRepositoryRegistry(project, builtins.registry, "a".repeat(64), systemFlows, version.digest)
      yield* pinned.loadBody("todo", version.digest)
    }).pipe(Effect.provide(layerRegistry(repository)), Effect.provide(NodeServices.layer), Effect.runPromise)
  }
  process.stdout.write(`versions ${JSON.stringify(versions)}\n`)
}
