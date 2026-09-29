/*
 * The site probe: one deployment of `smithers-mvp-web` serves the smithers.sh
 * Astro build as its assets and the product app inside it.
 *
 *   bun scripts/canary/site-probe.ts <hostname or origin> [--json <path>]
 *
 *     canary.smithers.sh          the canary
 *     http://localhost:8787       a `wrangler dev` of this Worker
 *
 * Every request is an anonymous GET of a static asset or a public read, so a
 * run costs nothing and spends no model turn. Redirects are not followed by
 * the fetch: a redirect is graded as a hop, and a legacy alias may take a
 * bounded chain of them before it must answer 200.
 *
 * The verdicts live in site-checks.ts, which is covered by site-checks.test.ts.
 * The fetch below is the one line no test reaches.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { argReader } from "./CanaryArgs.ts"
import { observeSiteResponse, originFromHostname, renderTable, runSiteChecks, tally } from "./site-checks.ts"

const args = process.argv.slice(2)
const target = args[0]
if (target === undefined || target.startsWith("--")) {
  console.error("usage: bun scripts/canary/site-probe.ts <hostname or origin> [--json <path>]")
  // Exit 2, not 1: a missing target is a statement about this invocation,
  // never a verdict about a deployment.
  process.exit(2)
}
const jsonPath = argReader(args, (detail) => {
  console.error(`FAIL: ${detail}`)
  process.exit(2)
})("--json")

const origin = originFromHostname(target)
const legacy = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../site/src/data/mintlify-paths.json", import.meta.url)), "utf8")
) as { readonly paths: ReadonlyArray<string> }

const checks = await runSiteChecks(
  async (url) => {
    const response = await fetch(url, {
      redirect: "manual",
      cache: "no-store",
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(20_000)
    })
    return observeSiteResponse(response)
  },
  { origin, legacyPaths: legacy.paths }
)

console.log(renderTable(checks))
if (jsonPath !== undefined) {
  writeFileSync(jsonPath, `${JSON.stringify({ origin, checks }, null, "\t")}\n`)
  console.log(`report: ${jsonPath}`)
}

const counts = tally(checks)
if (counts.failed > 0) {
  console.log(`\nSITE PROBE FAILED against ${origin}: ${counts.passed} passed, ${counts.failed} failed.`)
  process.exit(1)
}
console.log(`\nSITE PROBE PASS against ${origin}: ${counts.passed} passed, ${counts.failed} failed.`)
