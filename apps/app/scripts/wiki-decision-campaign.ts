import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

export type WikiDecisionInstall = { environment: Record<string, string>; stateDirectory: string }
const required = ["SMITHERS_REAL_BASE_URL", "SMITHERS_REAL_E2E_BUILD_SHA", "SMITHERS_JOURNEY_REPOSITORY", "SMITHERS_JOURNEY_DATABASE_URL", "SMITHERS_JOURNEY_SMTHRS", "SMITHERS_JOURNEY_WILL_SESSION", "SMITHERS_JOURNEY_BEN_SESSION", "SMITHERS_JOURNEY_ALICE_SESSION"]

// Prepared installs only: provisioning and GitHub login remain the owner's doors.
export function validateInstalls(installs: WikiDecisionInstall[]) {
  if (!Array.isArray(installs) || installs.length !== 3) throw new Error("Three fresh reference installs are required")
  for (const install of installs) {
    if (!install?.environment || required.some(key => !install.environment[key]?.trim())) throw new Error("Incomplete reference install")
    const env = install.environment
    if (!/^smithers-mvp-canary\/[a-zA-Z0-9._-]+$/.test(env.SMITHERS_JOURNEY_REPOSITORY)) throw new Error("Scratch repository required")
    if (!/^[0-9a-f]{40}$/.test(env.SMITHERS_REAL_E2E_BUILD_SHA)) throw new Error("Pinned commit required")
    if (!/^https?:$/.test(new URL(env.SMITHERS_REAL_BASE_URL).protocol)) throw new Error("Reference HTTP origin required")
    if (!install.stateDirectory?.startsWith("/")) throw new Error("Absolute fresh install state directory required")
  }
  for (const identities of [installs.map(i => resolve(i.stateDirectory)), installs.map(i => i.environment.SMITHERS_JOURNEY_REPOSITORY), installs.map(i => i.environment.SMITHERS_JOURNEY_DATABASE_URL)]) {
    if (new Set(identities).size !== 3) throw new Error("Each run requires independent state, repository and database")
  }
  if (new Set(installs.map(i => i.environment.SMITHERS_REAL_E2E_BUILD_SHA)).size !== 1) throw new Error("All runs must qualify the same commit")
}

export function requirePassingReport(report: any) {
  if (report?.stats?.expected !== 1 || report.stats.unexpected !== 0 || report.stats.skipped !== 0 || report.stats.flaky !== 0) throw new Error("Expected one passing journey without skips or retries")
}

if (import.meta.main) {
  const [manifest, output] = process.argv.slice(2)
  if (!manifest || !output) throw new Error("Usage: bun scripts/wiki-decision-campaign.ts <prepared-installs.json> <evidence-directory>")
  const installs = JSON.parse(readFileSync(manifest, "utf8")) as WikiDecisionInstall[]
  validateInstalls(installs)
  if (process.platform !== "darwin") throw new Error("Reference Mac required")
  const root = resolve(output)
  mkdirSync(root)
  const receipts: unknown[] = []
  for (const [index, install] of installs.entries()) {
    const directory = resolve(root, `run-${index + 1}`)
    mkdirSync(directory, { recursive: true })
    const report = resolve(directory, "results.json")
    const child = Bun.spawn(["pnpm", "exec", "playwright", "test", "--config", "playwright.real.config.ts", "e2e/real/wiki-decision-follow.spec.ts", "--workers=1", "--retries=0"], {
      cwd: resolve(import.meta.dir, ".."), stdin: "inherit", stdout: "inherit", stderr: "inherit",
      env: { ...process.env, ...install.environment, SMITHERS_JOURNEY: "wiki-decision-follow.spec.ts", SMITHERS_REAL_HEADED: "1", SMITHERS_WIKI_DECISION_RUN: String(index + 1), SMITHERS_REAL_E2E_REPORT: report, SMITHERS_REAL_E2E_ARTIFACTS: resolve(directory, "artifacts") }
    })
    if (await child.exited !== 0) throw new Error(`Run ${index + 1} failed; no aggregate passing receipt`)
    requirePassingReport(JSON.parse(readFileSync(report, "utf8")))
    receipts.push({ run: index + 1, repository: install.environment.SMITHERS_JOURNEY_REPOSITORY, declaredStateDirectory: install.stateDirectory, report })
  }
  writeFileSync(resolve(root, "campaign.json"), JSON.stringify({ check: "C-J8-05", commit: installs[0].environment.SMITHERS_REAL_E2E_BUILD_SHA, passed: 3, runs: receipts }, null, 2) + "\n")
}
