/** Literal policy build gate; optional ids support negative build fixtures. */
import { assertCatalogPolicy, auditAppIds, auditRuntimeTags } from "./catalog-policy"

const args = process.argv.slice(2)
if (args[0] === "--app-id" && args.length > 1) {
  assertCatalogPolicy(auditAppIds(args.slice(1)))
} else if (args[0] === "--tag" && args.length === 3 && (args[1] === "install" || args[1] === "machine")) {
  assertCatalogPolicy(auditRuntimeTags([{ id: args[2]!, runtime: args[1] }]))
} else if (args.length === 0) {
  const [{ FLOW_NAMES }, { generateCatalog }, { httpProjections }] = await Promise.all([
    import("../apps/app/src/mainview/flows/FlowName"), import("./catalog-mvp"),
    import("../packages/smithers/ui/src/app-operations/http")
  ])
  // HTTP projections are operation bindings, not registered browser flow ids.
  const httpOnly = new Set(httpProjections.map(row => row.name))
  const appIds = [...new Set([...FLOW_NAMES, ...generateCatalog().filter(row => !httpOnly.has(row.name)).map(row => row.name)])]
  assertCatalogPolicy(auditAppIds(appIds))
} else {
  throw new Error("Usage: catalog-allowlist.ts [--app-id <id>... | --tag install|machine <tag>]")
}
