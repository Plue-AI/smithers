/* e2e for the generated proof page: page.pw.ts opens it from file:// in Chromium. */
import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: ".", testMatch: ["page.pw.ts"], workers: 1, retries: 0, timeout: 60_000,
  outputDir: "../../test-results/proof-page-e2e", reporter: "list",
  use: { headless: true, trace: "retain-on-failure" }
})
