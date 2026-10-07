import { defineConfig, devices } from "@playwright/test"
import { hostGrep, scenarioGrep } from "./e2e/real/coverage/selection"
import type { RealHost } from "./e2e/real/coverage/types"
import { DEPLOYMENT_MODES } from "./e2e/real/coverage/types"
import { MATRIX_SCENARIO_IDS, MODE_DESCRIPTORS } from "./e2e/real/coverage/matrix"
import { MODEL_CREDENTIAL_ENV_PREFIX } from "@smthrs/rpc/ConfiguredModel"
import { requireJ1Preconditions } from "./e2e/real/support/j1-preconditions"
import { ignoredJourneys } from "./e2e/real/journeys"

// The direct Playwright door must enforce the same admission as run-real-e2e.
// Otherwise selecting activation directly can start a development host before
// the test fixture checks whether a fresh reference install was supplied.
const activationSelected = ["j1-activation.spec.ts", "j1.spec.ts", "keyboard-journeys.spec.ts"].includes(process.env.SMITHERS_JOURNEY ?? "") ||
  process.env.SMITHERS_J1_ACTIVATION === "1" ||
  process.argv.some(arg => /(?:^|\/)(?:j1-activation|j1|keyboard-journeys)\.spec\.ts$/.test(arg))
if (activationSelected) requireJ1Preconditions()
const setupSelected = process.env.SMITHERS_JOURNEY === "setup.spec.ts" ||
  process.argv.some(arg => /(?:^|\/)setup\.spec\.ts$/.test(arg))
if (setupSelected && (!process.env.SMITHERS_REAL_BASE_URL || !process.env.SMITHERS_SETUP_URL ||
  !process.env.SMITHERS_REAL_E2E_BUILD_SHA || process.env.SMITHERS_REAL_HEADED !== "1")) {
  throw new Error("Setup qualification requires a built reference install, its printed setup URL, pinned build SHA and headed operator; no development host is started")
}

const installConfigSelected = ["fresh-repository.spec.ts", "wiki-generated-refresh.spec.ts"].some(spec =>
  process.env.SMITHERS_JOURNEY === spec || process.argv.some(arg => arg.endsWith(`/${spec}`) || arg === spec))
if (installConfigSelected && (process.platform !== "darwin" || !process.env.SMITHERS_REAL_BASE_URL ||
  !process.env.SMITHERS_REAL_E2E_BUILD_SHA || process.env.SMITHERS_REAL_HEADED !== "1")) {
  throw new Error("Install config qualification requires a built Mac reference install, pinned build SHA and headed operator; no development host is started")
}

const obsidianSelected = process.env.SMITHERS_JOURNEY === "wiki-obsidian.spec.ts" ||
  process.argv.some(arg => /(?:^|\/)wiki-obsidian\.spec\.ts$/.test(arg))
if (obsidianSelected && (process.platform !== "darwin" || !process.env.SMITHERS_REAL_BASE_URL ||
  !process.env.SMITHERS_OBSIDIAN_EVIDENCE_ROOT || process.env.SMITHERS_REAL_AUTH_KIND !== "owner-session")) {
  throw new Error("Obsidian qualification requires the install Mac, built reference URL, owner session and SMITHERS_OBSIDIAN_EVIDENCE_ROOT; no development host is started")
}

const PORT = Number(process.env.SMITHERS_REAL_PORT ?? "47321")
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error(`Invalid SMITHERS_REAL_PORT: ${process.env.SMITHERS_REAL_PORT}`)

const externalBaseURL = process.env.SMITHERS_REAL_BASE_URL
const baseURL = externalBaseURL ?? `http://127.0.0.1:${PORT}`
const deploymentMode = process.env.SMITHERS_REAL_E2E_MODE
const matrixScenarioIds = process.env.SMITHERS_REAL_MATRIX_SCENARIOS === undefined
  ? MATRIX_SCENARIO_IDS
  : JSON.parse(process.env.SMITHERS_REAL_MATRIX_SCENARIOS) as string[]
if (deploymentMode !== undefined && !(DEPLOYMENT_MODES as readonly string[]).includes(deploymentMode)) throw new Error(`Invalid SMITHERS_REAL_E2E_MODE: ${deploymentMode}`)
const matrixHost = deploymentMode === undefined ? undefined : MODE_DESCRIPTORS[deploymentMode as keyof typeof MODE_DESCRIPTORS].legacyHost
const expectedHost = process.env.SMITHERS_REAL_E2E_HOST ?? matrixHost ?? (externalBaseURL ? "production" : "local")
if (!["local", "production"].includes(expectedHost)) throw new Error(`Invalid SMITHERS_REAL_E2E_HOST: ${expectedHost}`)
process.env.SMITHERS_REAL_E2E_HOST = expectedHost
// The named model credentials and their pinned origins the runner declared: the host under test reads them by name.
const modelCredentials = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] =>
  entry[0].startsWith(MODEL_CREDENTIAL_ENV_PREFIX) && entry[1] !== undefined))
const parsed = new URL(baseURL)
if (!/^https?:$/.test(parsed.protocol)) throw new Error(`SMITHERS_REAL_BASE_URL must use http(s): ${baseURL}`)

export default defineConfig({
  testDir: "e2e/real",
  testMatch: "**/*.spec.ts",
  testIgnore: ignoredJourneys(process.env).map((spec) => `**/${spec}`),
  grep: deploymentMode === undefined
    ? hostGrep(expectedHost as RealHost, process.env.SMITHERS_REAL_TEST_GREP)
    : scenarioGrep(matrixScenarioIds, process.env.SMITHERS_REAL_TEST_GREP),
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [["github"], ["json", { outputFile: process.env.SMITHERS_REAL_E2E_REPORT ?? "test-results/real-e2e-results.json" }], ["./e2e/real/coverage/reporter.ts"]]
    : [["list"], ["json", { outputFile: process.env.SMITHERS_REAL_E2E_REPORT ?? "test-results/real-e2e-results.json" }], ["./e2e/real/coverage/reporter.ts"]],
  outputDir: process.env.SMITHERS_REAL_E2E_ARTIFACTS ?? "test-results/real-e2e-artifacts",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: parsed.toString(),
    headless: process.env.SMITHERS_REAL_HEADED !== "1",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: externalBaseURL ? undefined : {
    command: "bun scripts/run-real-e2e.ts serve",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 300_000,
    env: {
      SMITHERS_REAL_PORT: String(PORT),
      SMITHERS_CHAT_STUB: "0",
      ...modelCredentials
    }
  }
})
