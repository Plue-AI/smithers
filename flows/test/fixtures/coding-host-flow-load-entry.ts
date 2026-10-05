import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
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
  const versions = await loadRepositoryFlows(repository, systemFlows).pipe(
    Effect.provide(NodeServices.layer),
    Effect.runPromise
  )
  process.stdout.write(`versions ${JSON.stringify(versions)}\n`)
}
