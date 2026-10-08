import { defineConfig, devices } from "@playwright/test"
export default defineConfig({
  testDir: "../playwright/spec",
  testMatch: ["C-J11-01.spec.ts", "C-J11-04.spec.ts"],
  workers: 1, retries: 0, timeout: 90_000,
  outputDir: "../../../../.artifacts/checks/C-J11-01/browser",
  use: { ...devices["Desktop Chrome"], baseURL: process.env.SMITHERS_J11_ORIGIN, trace: "retain-on-failure", video: "on" }
})
