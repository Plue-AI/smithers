import { defineConfig, devices } from "@playwright/test"

// The Go rehearsal owns the production router, PostgreSQL, packaged model
// host and fake model endpoint; Playwright owns only browser gestures.
export default defineConfig({
  testDir: ".", testMatch: "branch-conversations.spec.ts", workers: 1,
  timeout: 60_000, reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL: process.env.SMITHERS_W17_URL, headless: true }
})
