import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "e2e/local", testMatch: ["**/setup-no-github.spec.ts", "**/team-no-github.spec.ts", "**/stack-no-github.spec.ts"], workers: 1,
  fullyParallel: false, retries: 0, timeout: 20_000,
  outputDir: "test-results/local-no-github/artifacts", reporter: "list",
  use: { headless: true, actionTimeout: 5000, trace: "off" },
  webServer: { command: "bun scripts/run-local-no-github.ts --no-browser", url: "http://127.0.0.1:4000/readyz", timeout: 120_000, reuseExistingServer: false, gracefulShutdown: { signal: "SIGTERM", timeout: 20_000 } }
})
