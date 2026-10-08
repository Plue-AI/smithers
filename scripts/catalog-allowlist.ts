/** Literal policy build gate; optional ids support negative build fixtures. */
import { assertCatalogPolicy, auditAppIds, auditCliPaths, auditRuntimeTags, type RuntimeTag } from "./catalog-policy"
import { execFileSync } from "node:child_process"

const productionTags = (): RuntimeTag[] => {
  const script = new URL("./catalog-runtime.ts", import.meta.url).pathname
  const inventories: Array<{ readonly tags: RuntimeTag[] }> = JSON.parse(execFileSync("node", ["--no-warnings", script, "--inventory"], { encoding: "utf8", timeout: 60_000 }))
  return inventories.flatMap(inventory => inventory.tags)
}
const args = process.argv.slice(2)
if (args[0] === "--app-id" && args.length > 1) {
  assertCatalogPolicy(auditAppIds(args.slice(1)))
} else if (args[0] === "--cli-path" && args.length > 1) {
  assertCatalogPolicy(auditCliPaths(args.slice(1)))
} else if (args[0] === "--tag" && args.length === 3 && (args[1] === "install" || args[1] === "machine")) {
  assertCatalogPolicy(auditRuntimeTags([{ id: args[2]!, runtime: args[1] }]))
} else if (args[0] === "--runtime" && args.length === 1) {
  assertCatalogPolicy(auditRuntimeTags(productionTags()))
} else if (args.length === 0 || (args[0] === "--app-cli" && args.length === 1)) {
  const [{ FLOW_NAMES }, { generateCatalog }, { httpProjections }] = await Promise.all([
    import("../apps/app/src/mainview/flows/FlowName"), import("./catalog-mvp"),
    import("../packages/smithers/ui/src/app-operations/http")
  ])
  // HTTP projections are operation bindings, not registered browser flow ids.
  const httpOnly = new Set(httpProjections.map(row => row.name))
  const appIds = [...new Set([...FLOW_NAMES, ...generateCatalog().filter(row => !httpOnly.has(row.name)).map(row => row.name)])]
  // The source CLI requires Node's module hooks, which Bun does not implement.
  // Construct its discovery under the shipped CLI runtime; execute no command.
  const cliModule = new URL("../packages/smithers/src/Cli.ts", import.meta.url).href
  const discoveryModule = new URL("../packages/smithers/src/internal/backend/InstallDiscovery.ts", import.meta.url).href
  const paths: string[] = JSON.parse(execFileSync("node", ["--no-warnings", "--input-type=module", "--eval",
    `import { makeCli } from ${JSON.stringify(cliModule)}; import { installCommandPaths } from ${JSON.stringify(discoveryModule)}; process.stdout.write(JSON.stringify(installCommandPaths(makeCli())));`
  ], { encoding: "utf8", timeout: 60_000 }))
  assertCatalogPolicy([...auditAppIds(appIds), ...auditCliPaths(paths), ...(args.length === 0 ? auditRuntimeTags(productionTags()) : [])])
} else {
  throw new Error("Usage: catalog-allowlist.ts [--app-cli | --runtime | --app-id <id>... | --cli-path <path>... | --tag install|machine <tag>]")
}
