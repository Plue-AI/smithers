import { defineConfig, devices } from "@playwright/test"

/*
 * The showcase (e2e/showcase): the T1 host and fixtures, one test per case.
 * `pnpm showcase [id...]` (scripts/showcase.ts) records GIFs through it; run
 * alone it is the cases' assertion check. Its own port lets it run beside T1.
 */
const PORT = Number(process.env.SMITHERS_SHOWCASE_PORT ?? "47313")
const BASE_URL = `http://127.0.0.1:${PORT}`

export default defineConfig({
  testDir: "e2e/showcase",
  testMatch: "**/showcase.spec.ts",
  // Outside T1's test-results/ (which T1 clears on start), and per port.
  outputDir: `test-results-showcase/${PORT}`,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: process.env.SHOWCASE_RECORD === undefined ? 60_000 : 180_000,
  use: { baseURL: BASE_URL, headless: true, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun e2e/playwright/webserver.ts",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    timeout: 240_000,
    env: { SMITHERS_LOCAL_PORT: String(PORT), SMITHERS_CHAT_STUB: "1" }
  }
})
