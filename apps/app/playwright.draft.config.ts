import { defineConfig } from "@playwright/test"
export default defineConfig({
  testDir: "./e2e/playwright",
  testMatch: "draft-view-stories.spec.ts",
  workers: 1,
  reporter: "list",
  use: { browserName: "chromium", baseURL: "http://127.0.0.1:5179" },
  webServer: {
    command: "bun x vite --config e2e/fixtures/draft-stories/vite.config.ts --configLoader runner",
    url: "http://127.0.0.1:5179", reuseExistingServer: false
  }
})
