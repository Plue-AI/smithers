import base from "./playwright.local.config"
import { defineConfig } from "@playwright/test"
export default defineConfig({ ...base, testMatch: ["**/setup-no-github.spec.ts", "**/monitor-labels.spec.ts"],
 outputDir: "test-results/monitor/artifacts", reporter: [["list"], ["json", { outputFile: "test-results/monitor/results.json" }]],
 use: { ...base.use, video: "on", trace: "retain-on-failure" }
})
