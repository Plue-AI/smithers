import { defineConfig, devices } from "@playwright/test"

/*
 * Test tier T1 (LOCAL-APP.md): the local origin without a window, driven by
 * headless Chromium, or WebKit with SMITHERS_E2E_BROWSER=webkit. Specs use
 * browserTest.ts so WebKit exercises real OPFS in isolated persistent profiles.
 * The web server builds the SPA (unless
 * SMITHERS_SKIP_SPA_BUILD=1) and boots an in-process test host
 * (e2e/playwright/webserver.ts -> scripts/browser-test-host.ts) on a fixed
 * port with the chat stub injected. SMITHERS_CHAT_STUB=0 hits the real endpoint
 * and enables chat.real.spec.ts.
 */
const PORT = Number(process.env.SMITHERS_E2E_PORT ?? "47311")
const BASE_URL = `http://127.0.0.1:${PORT}`
const CHAT_STUB = process.env.SMITHERS_CHAT_STUB === "0" ? "0" : "1"

export default defineConfig({
  testDir: "e2e/playwright",
  testIgnore: ["**/native/**", ...(process.env.SMITHERS_VIEW_STORIES === "1" ? [] : ["**/view-stories.spec.ts"])],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  timeout: 60_000,
  use: {
    baseURL: BASE_URL,
    headless: true,
    trace: "retain-on-failure"
  },
  projects: process.env.SMITHERS_E2E_BROWSER === "webkit"
    ? [{ name: "webkit", use: { ...devices["Desktop Safari"] } }]
    : [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bun e2e/playwright/webserver.ts",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
    timeout: 240_000,
    env: {
      SMITHERS_VIEW_STORIES: process.env.SMITHERS_VIEW_STORIES ?? "0",
      SMITHERS_LOCAL_PORT: String(PORT),
      SMITHERS_CHAT_STUB: CHAT_STUB
    }
  }
})
