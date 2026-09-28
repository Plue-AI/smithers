/**
 * Required PR browser tier; package-local Playwright owns its matching browser.
 *
 * The steps run serially. T1 and the flow-graph tier each rebuild
 * apps/app/dist (vite empties it); the showcase serves T1's dist
 * (SMITHERS_SKIP_SPA_BUILD) and keeps its own outputDir; T1, site and graph
 * write Playwright's default test-results/; site builds apps/site/dist. As
 * concurrent targets they would race. A failed test step
 * does not stop the later ones, so one run reports every red tier; the exit
 * code is the first failure's. Each step prints its duration.
 *
 * Measured on ubuntu-latest (runs 36364540459 and 36369423415): install
 * 0.4 min, T1 11.7, showcase 3.7, site 1.2; the whole run crossed 20 min at
 * graph test 16 of 20 (the graph step alone: 1.5 min on a 16-core Mac), so
 * ~22 min. The browserE2e timeout in PACKAGE.ts keeps 30% headroom over that.
 */
import { spawnSync } from "node:child_process"

const install = ["exec", "playwright", "install", "--with-deps", "chromium"]
const steps = [
  install,
  ["run", "test:e2e:auth"],
  ["run", "test:e2e:probes"],
  ["run", "test:e2e:graph-lifecycle"],
  ["exec", "playwright", "test"],
  // The showcase cases as plain assertion tests (no recording). It reuses the dist/ the
  // T1 step above builds, so it must stay after that step.
  ["exec", "playwright", "test", "--config", "playwright.showcase.config.ts"],
  ["exec", "playwright", "test", "--config", "playwright.site.config.ts"],
  ["exec", "playwright", "test", "--config", "playwright.graph.config.ts"]
]

let failure = 0
for (const args of steps) {
  const showcase = args.includes("playwright.showcase.config.ts")
  const started = Date.now()
  const result = spawnSync("pnpm", args, {
    stdio: "inherit",
    env: { ...process.env, SMITHERS_CHAT_STUB: "1", SMITHERS_PR_E2E: "1", ...(showcase ? { SMITHERS_SKIP_SPA_BUILD: "1" } : {}) }
  })
  if (result.error) throw result.error
  const status = result.status ?? 1
  console.log(`[run-pr-e2e] pnpm ${args.join(" ")}: exit ${status} in ${((Date.now() - started) / 60_000).toFixed(1)} min`)
  if (status !== 0 && args === install) process.exit(status)
  if (status !== 0 && failure === 0) failure = status
}
process.exit(failure)
