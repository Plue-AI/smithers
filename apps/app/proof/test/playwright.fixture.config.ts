/* Records fixtures/results.json from fx.pw.ts; record-fixture.ts runs it and makes the paths relative. */
import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: ".", testMatch: ["fx.pw.ts"], workers: 1, retries: 0, timeout: 30_000,
  outputDir: "fixtures/run",
  reporter: [["json", { outputFile: "fixtures/results.json" }]],
  use: { headless: true, video: "on", viewport: { width: 480, height: 300 }, screenshot: "off", trace: "off" }
})
