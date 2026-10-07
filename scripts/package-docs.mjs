// @ts-check
/**
 * The retired library docs sites and where their links go now (T-DOC-04, #3510).
 *
 * Until 2026-10 every row below was an Astro site on `<slug>.smithers.sh`. The
 * sites are gone; each package's colocated `docs/` folder on GitHub replaces
 * its site, and one Worker (`apps/server/src/docsRedirect.ts`) answers the old
 * hostnames with a 301 to that folder.
 *
 * The slugs are frozen. They are the hostnames that served a docs site, and the
 * only hostnames the redirect Worker may claim: a slug derived from today's
 * package list would also name hosts that were never docs sites
 * (`build.smithers.sh` is the build cache). Package directories are not frozen:
 * each slug's npm name is looked up in the workspace package list, so a moved
 * package moves its redirect target with it.
 *
 *   node scripts/package-docs.mjs           print the slug -> URL map
 *   node scripts/package-docs.mjs --write   regenerate apps/server/src/docsRedirectMap.ts
 *   node scripts/package-docs.mjs --check   fail if that module drifted
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isMain, repoRoot, workspacePackages } from "./workspace-packages.mjs"

/** The repository every redirect lands in. Targets are built from this and the map only. */
export const REPOSITORY_URL = "https://github.com/smithersai/smithers"

/** Where an unknown slug lands. */
export const README_URL = `${REPOSITORY_URL}/blob/main/README.md`

/** The zone every slug is a subdomain of. */
export const ZONE = "smithers.sh"

/**
 * [slug, npm name] for every retired docs site, from apps/docs/shared/manifest.mjs
 * as it stood when the sites were retired. `plan-store` was in the roster but
 * never deployed (no DNS record on 2026-10-06); its redirect works once a record exists.
 *
 * @type {ReadonlyArray<readonly [string, string]>}
 */
export const legacySites = [
  ["agent", "@smthrs/agent"],
  ["artifacts", "@smthrs/artifacts"],
  ["canonical", "@smthrs/canonical"],
  ["capability", "@smthrs/capability"],
  ["chain", "@smthrs/chain"],
  ["cli", "@smthrs/cli"],
  ["control", "@smthrs/control"],
  ["core", "@smthrs/core"],
  ["crypto", "@smthrs/crypto"],
  ["database", "@smthrs/database"],
  ["engine", "@smthrs/engine"],
  ["engine-store", "@smthrs/engine-store"],
  ["errors", "@smthrs/errors"],
  ["evals", "@smthrs/evals"],
  ["flow", "@smthrs/flow"],
  ["flows", "@smthrs/flows"],
  ["fs", "@smthrs/fs"],
  ["gateway", "@smthrs/gateway"],
  ["harness", "@smthrs/harness"],
  ["integrations", "@smthrs/integrations"],
  ["jj", "@smthrs/jj"],
  ["journal", "@smthrs/journal"],
  ["kernel", "@smthrs/kernel"],
  ["keys", "@smthrs/keys"],
  ["mcp", "@smthrs/mcp"],
  ["memory", "@smthrs/memory"],
  ["migrate", "@smthrs/migrate"],
  ["model", "@smthrs/model"],
  ["notifications", "@smthrs/notifications"],
  ["observability", "@smthrs/observability"],
  ["plan", "@smthrs/plan"],
  ["plan-store", "@smthrs/plan-store"],
  ["platform-browser", "@smthrs/platform-browser"],
  ["platform-bun", "@smthrs/platform-bun"],
  ["platform-node", "@smthrs/platform-node"],
  ["plugin", "@smthrs/plugin"],
  ["registry", "@smthrs/registry"],
  ["run-store", "@smthrs/run-store"],
  ["sandbox", "@smthrs/sandbox"],
  ["scorers", "@smthrs/scorers"],
  ["smithers-patterns", "@smthrs/patterns"],
  ["smithers-sync", "@smthrs/sync"],
  ["smthrs", "smthrs"],
  ["std", "@smthrs/std"],
  ["step-cache", "@smthrs/step-cache"],
  ["testing", "@smthrs/testing"],
  ["time-travel", "@smthrs/time-travel"],
  ["triggers", "@smthrs/triggers"]
]

/**
 * slug -> `https://github.com/smithersai/smithers/tree/main/<package-dir>/docs`,
 * resolved against the workspace package list. Throws when a slug's package is
 * gone or has no docs/ folder, so a broken target never ships.
 *
 * @param {string} [root]
 * @returns {Readonly<Record<string, string>>}
 */
export const buildRedirectMap = (root = repoRoot) => {
  const byName = new Map(workspacePackages(root).map((entry) => [entry.name, entry.dir]))
  /** @type {Record<string, string>} */
  const map = {}
  for (const [slug, name] of legacySites) {
    const dir = byName.get(name)
    if (dir === undefined) throw new Error(`${slug}.${ZONE}: no workspace package is named ${name}`)
    if (!existsSync(join(root, dir, "docs"))) throw new Error(`${slug}.${ZONE}: ${dir} has no docs/ folder`)
    map[slug] = `${REPOSITORY_URL}/tree/main/${dir}/docs`
  }
  return map
}

/**
 * The retired sites as the apps/site scripts read them (llms index, API docs
 * sync, reference ingest): one row per legacy slug whose package still exists,
 * in `legacySites` order.
 *
 * @type {ReadonlyArray<{ dir: string, name: string, slug: string, title: string, description: string, domain: string }>}
 */
export const sites = (() => {
  const byName = new Map(workspacePackages(repoRoot).map((entry) => [entry.name, entry]))
  return legacySites.flatMap(([slug, name]) => {
    const entry = byName.get(name)
    return entry === undefined ? [] : [{
      dir: entry.dir, name, slug, title: name,
      description: typeof entry.manifest.description === "string" ? entry.manifest.description : "",
      domain: `${slug}.${ZONE}`
    }]
  })
})()

/** @type {Readonly<Record<string, string>> | undefined} */
let checkoutMap
/**
 * The map over this checkout, built on first use so that importing this
 * module (for `sites`, say) never requires every package's docs/ folder.
 */
export const redirectMapOf = () => (checkoutMap ??= buildRedirectMap())

/**
 * The Location the deployed redirect answers for `url`: the slug's docs folder,
 * or the README for any other single-label smithers.sh host.
 *
 * @param {string} url
 */
export const redirectLocation = (url) => {
  const slug = new URL(url).hostname.slice(0, -`.${ZONE}`.length)
  const map = redirectMapOf()
  return Object.hasOwn(map, slug) ? map[slug] : README_URL
}

export const GENERATED_MODULE = join(repoRoot, "apps/server/src/docsRedirectMap.ts")

/**
 * The Worker's copy of the map, as TypeScript source.
 *
 * @param {Readonly<Record<string, string>>} map
 */
export const renderModule = (map) => [
  "// Generated by scripts/package-docs.mjs. Do not edit; run: node scripts/package-docs.mjs --write",
  "",
  "/** Retired docs-site slug -> its package's docs/ folder on GitHub (T-DOC-04, #3510). */",
  "export const DOCS_REDIRECTS: ReadonlyMap<string, string> = new Map([",
  ...Object.entries(map).map(([slug, url]) => `  [${JSON.stringify(slug)}, ${JSON.stringify(url)}],`),
  "])",
  "",
  `export const README_URL = ${JSON.stringify(README_URL)}`,
  ""
].join("\n")

if (isMain(import.meta)) {
  const flag = process.argv[2]
  if (flag === "--write") {
    writeFileSync(GENERATED_MODULE, renderModule(redirectMapOf()))
  } else if (flag === "--check") {
    if (readFileSync(GENERATED_MODULE, "utf8") !== renderModule(redirectMapOf())) {
      console.error("apps/server/src/docsRedirectMap.ts is stale: node scripts/package-docs.mjs --write")
      process.exitCode = 1
    }
  } else {
    console.log(JSON.stringify(redirectMapOf(), null, 2))
  }
}
