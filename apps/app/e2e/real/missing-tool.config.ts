import { defineConfig, devices } from "@playwright/test"
export default defineConfig({
  testDir: ".", testMatch: "missing-tool.spec.ts", workers: 1, retries: 0, timeout: 90_000,
  outputDir: process.env.SMITHERS_MISSING_TOOL_OUTPUT_DIR ?? "../../../../.artifacts/checks/C-APP-03/browser",
  use: { ...devices["Desktop Chrome"], baseURL: process.env.SMITHERS_MISSING_TOOL_ORIGIN, trace: "retain-on-failure", video: "on" }
})
