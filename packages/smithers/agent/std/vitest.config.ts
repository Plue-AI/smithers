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
      reportsDirectory: join(tmpdir(), `flows-std-coverage-${process.pid}`),
      include: ["src/**"],
      // Aggregate floors apply across the supported host lanes, which differ
      // in native-process and filesystem tests. Completed portable modules
      // get stricter per-file gates without narrowing the source inventory.
      thresholds: {
        branches: 84,
        functions: 88,
        lines: 94,
        statements: 93,
        "src/Container.ts": { branches: 100, functions: 100, lines: 100, statements: 100 }
      }
    }
  }
})
