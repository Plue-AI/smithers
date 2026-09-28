import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // House convention (see packages/smithers/flows/journal/vitest.config.ts): a finite 30 s
    // wall-clock budget so correct suites survive coverage-instrumented load
    // while a genuine hang still fails the run.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      // Per-process report directory so concurrent vitest runs do not destroy
      // each other's coverage scratch state (issues #115/#121).
      reportsDirectory: join(tmpdir(), `flows-memory-coverage-${process.pid}`),
      include: ["src/**/*.ts"],
      // These floors also apply to a single-adapter developer run. The declared
      // SQLite/PostgreSQL matrix measures their combined coverage; neither
      // adapter alone exercises every adapter-specific path. Remaining branch
      // gaps keep this package in `coverageFloorDeferred` in
      // scripts/test/coverage.test.ts. Raising the last floor to 100 must remove
      // that deferral in the same change.
      thresholds: {
        branches: 95,
        functions: 99,
        lines: 99,
        statements: 99
      }
    }
  }
})
