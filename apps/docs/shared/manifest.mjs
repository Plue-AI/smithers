/**
 * manifest.mjs
 *
 * The roster of the per-package documentation sites under apps/docs/. Every
 * script in this directory (gen-sites.mjs, sync-content.mjs,
 * add-readme-doc-links.mjs) reads this list and nothing else, so adding a
 * package's site is one row here plus a generator run.
 *
 * Each row is [slug, npm name, source package dir]. The slug is the site
 * directory under apps/docs/ and the subdomain under smithers.sh
 * (<slug>.smithers.sh). The description is read live from the source
 * package's package.json, so a description edit there is the only edit a
 * package makes; gen-sites.mjs --check reports the generated files that the
 * edit puts out of date.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

/** The apps/docs directory, parent of shared/ and of every site directory. */
export const docsRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

/** The repository root, two levels above apps/docs. */
export const repoRoot = join(docsRoot, "..", "..")

/** [slug, npm name, source package dir relative to the repo root]. */
const entries = [
  ["agent", "@smthrs/agent", "packages/smithers/agent"],
  ["chain", "@smthrs/chain", "packages/smithers/agent/chain"],
  ["evals", "@smthrs/evals", "packages/smithers/agent/evals"],
  ["fs", "@smthrs/fs", "packages/smithers/agent/fs"],
  ["harness", "@smthrs/harness", "packages/smithers/agent/harness"],
  ["integrations", "@smthrs/integrations", "packages/smithers/agent/integrations"],
  ["memory", "@smthrs/memory", "packages/smithers/agent/memory"],
  ["model", "@smthrs/model", "packages/smithers/agent/model"],
  ["plugin", "@smthrs/plugin", "packages/smithers/agent/plugin"],
  ["registry", "@smthrs/registry", "packages/smithers/agent/registry"],
  ["scorers", "@smthrs/scorers", "packages/smithers/agent/scorers"],
  ["std", "@smthrs/std", "packages/smithers/agent/std"],
  ["triggers", "@smthrs/triggers", "packages/smithers/agent/triggers"],
  ["control", "@smthrs/control", "packages/smithers/control"],
  ["create-app", "@smthrs/create-app", "packages/smithers/create-app"],
  ["cli", "@smthrs/cli", "packages/smithers"],
  ["artifacts", "@smthrs/artifacts", "packages/smithers/flows/artifacts"],
  ["canonical", "@smthrs/canonical", "packages/smithers/flows/canonical"],
  ["capability", "@smthrs/capability", "packages/smithers/flows/capability"],
  ["core", "@smthrs/core", "packages/smithers/flows/core"],
  ["crypto", "@smthrs/crypto", "packages/smithers/flows/crypto"],
  ["database", "@smthrs/database", "packages/smithers/flows/database"],
  ["flows", "@smthrs/flows", "packages/smithers/flows"],
  ["engine-store", "@smthrs/engine-store", "packages/smithers/flows/engine-store"],
  ["engine", "@smthrs/engine", "packages/smithers/flows/engine"],
  ["flow", "@smthrs/flow", "packages/smithers/flows/flow"],
  ["jj", "@smthrs/jj", "packages/smithers/flows/jj"],
  ["journal", "@smthrs/journal", "packages/smithers/flows/journal"],
  ["kernel", "@smthrs/kernel", "packages/smithers/flows/kernel"],
  ["keys", "@smthrs/keys", "packages/smithers/flows/keys"],
  ["observability", "@smthrs/observability", "packages/smithers/flows/observability"],
  ["smithers-patterns", "@smthrs/patterns", "packages/smithers/flows/patterns"],
  ["plan", "@smthrs/plan", "packages/smithers/flows/plan"],
  ["plan-store", "@smthrs/plan-store", "packages/smithers/flows/plan-store"],
  ["platform-browser", "@smthrs/platform-browser", "packages/smithers/flows/platform-browser"],
  ["platform-bun", "@smthrs/platform-bun", "packages/smithers/flows/platform-bun"],
  ["platform-node", "@smthrs/platform-node", "packages/smithers/flows/platform-node"],
  ["run-store", "@smthrs/run-store", "packages/smithers/flows/run-store"],
  ["sandbox", "@smthrs/sandbox", "packages/smithers/flows/sandbox"],
  ["step-cache", "@smthrs/step-cache", "packages/smithers/flows/step-cache"],
  ["smithers-sync", "@smthrs/sync", "packages/smithers/flows/sync"],
  ["time-travel", "@smthrs/time-travel", "packages/smithers/flows/time-travel"],
  ["gateway", "@smthrs/gateway", "packages/smithers/gateway"],
  ["mcp", "@smthrs/mcp", "packages/smithers/mcp"],
  ["migrate", "@smthrs/migrate", "packages/smithers/migrate"],
  ["notifications", "@smthrs/notifications", "packages/smithers/notifications"],
  ["errors", "@smthrs/errors", "packages/errors"],
  ["testing", "@smthrs/testing", "packages/testing"],
  ["smthrs", "smthrs", "packages/smthrs-deprecation"]
]

/** The package.json description of a source package, read at evaluation time. */
const readDescription = (dir) => {
  const manifest = JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8"))
  return typeof manifest.description === "string" ? manifest.description.replace(/\s+/g, " ").trim() : ""
}

/**
 * The site entries, in manifest order. `title` is the package's npm name,
 * which is also the index page's fallback title; `siteDir` is absolute.
 */
export const sites = entries.map(([slug, name, dir]) => ({
  slug,
  name,
  dir,
  description: readDescription(dir),
  title: name,
  domain: `${slug}.smithers.sh`,
  siteDir: join(docsRoot, slug)
}))

/** The manifest keyed by slug. */
export const bySlug = new Map(sites.map((site) => [site.slug, site]))
