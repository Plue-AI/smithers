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
      reportsDirectory: join(tmpdir(), `flows-integrations-coverage-${process.pid}`),
      include: ["src/**"],
      // Ratcheted to exactly what the default gate reaches. Raise these when a
      // case closes; never lower them. The explicit shortfall below is limited
      // to host/runtime boundaries the real suite cannot manufacture safely.
      //
      // The numbers are the exact figures the suite reaches, carrying no
      // slack, so any new uncovered branch fails the gate. Only the three
      // `test/*Live.test.ts` suites change the figures, and only upward: they
      // execute more of `src` when a credential is present, and `include`
      // fixes the denominator whether they run or not.
      //
      // What the remaining shortfall stands for, behavior by behavior:
      //
      // - `core/Channel.ts:68` can only see `Unauthorized`, the declared failure
      //   of `Credential.resolve`; its defensive other arm needs a service
      //   that violates the public type. Keep that refusal intact.
      // The database matrix merges real SQLite and PostgreSQL coverage.
      thresholds: {
        branches: 99.81,
        functions: 99.74,
        lines: 99.88,
        statements: 99.83
      }
    }
  }
})
