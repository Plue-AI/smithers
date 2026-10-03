import { defineConfig } from "@playwright/test";
import { join } from "node:path";

export default defineConfig({
  testDir: ".",
  testMatch: "keystrokes.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [["line"]],
  outputDir: join(process.env.SPIKE_EVIDENCE ?? "/tmp/col-01-missing-evidence", "playwright-results"),
  use: { headless: true, browserName: "chromium", actionTimeout: 15_000 },
});
