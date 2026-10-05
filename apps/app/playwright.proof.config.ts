import { defineConfig } from "@playwright/test"

/*
 * The proof tier (.specs/product/features.json; EVIDENCE-CONTRACT.md): one spec
 * per journey in e2e/proof, each on its own install from the real server
 * bundle with the GitHub fake and real models (e2e/proof/fixtures.ts), every
 * person's browser recorded. Never part of a default run:
 *
 *   PROOF_BUNDLE=~/lanes/proof-bundle/current pnpm --dir apps/app test:e2e:proof [e2e/proof/j1.spec.ts]
 *
 * results.json is what the proof page reads: per feature, its step, status,
 * screenshot (an attachment named by the feature id) and the videos.
 */
export default defineConfig({
  testDir: "e2e/proof",
  testMatch: "**/*.spec.ts",
  // Each install binds the bundle's fixed ports: one at a time.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 90 * 60_000,
  outputDir: "test-results/proof/artifacts",
  reporter: [["list"], ["json", { outputFile: "test-results/proof/results.json" }]],
  use: { headless: true, video: "on", trace: "off", actionTimeout: 15_000, viewport: { width: 1280, height: 800 } }
})
