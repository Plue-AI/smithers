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
      // in native-process and filesystem tests. Per-file completion gates
      // enforce the coverage campaign without narrowing the source inventory.
      thresholds: {
        // macOS executed 99.45 / 97.90 / 99.45 / 99.72 on 2026-10-02 (#3480).
        // Floors keep a margin for the Linux lane, which skips different
        // platform tests. Per-file gates cover files that reached 100% on
        // macOS; the rest are listed in #3480 with their dead branches.
        branches: 96,
        functions: 99,
        lines: 99,
        statements: 98,
        "src/Container.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/Glob.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/Grep.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/EnvelopePrecheck.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/Grouping.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/Http.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/Ignore.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/Match.ts": { branches: 100, functions: 100, lines: 100, statements: 100 },
        "src/internal/SearchContract.ts": { branches: 100, functions: 100, lines: 100, statements: 100 }
      }
    }
  }
})
