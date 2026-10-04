import { defineConfig, devices } from "@playwright/test"
import { hostGrep, scenarioGrep } from "./e2e/real/coverage/selection"
import type { RealHost } from "./e2e/real/coverage/types"
import { DEPLOYMENT_MODES } from "./e2e/real/coverage/types"
import { MATRIX_SCENARIO_IDS, MODE_DESCRIPTORS } from "./e2e/real/coverage/matrix"
import { MODEL_CREDENTIAL_ENV_PREFIX } from "@smthrs/rpc/ConfiguredModel"
import { ignoredJourneys } from "./e2e/real/journeys"

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
