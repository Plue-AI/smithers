/**
 * The fault tier: process, durability, time-travel, redaction, and served
 * control-plane cases.
 *
 * These cases spawn real hosts and child processes, kill or suspend them, and
 * use real SQLite files and sockets. Ports, pids, and process groups are
 * machine-global, so the tier runs serially.
 *
 * Coverage is off. The work these cases do happens in child processes this one
 * never instruments, and `vitest.config.ts` beside this file stays the coverage
 * gate for `src`.
 *
 * `test/faults/long/` is the long tier, run nightly from
 * `vitest.faults-long.config.ts`; the release gate does not wait on it.
 */
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/faults/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "test/faults/long/**"],
    // A fault case drives real processes, real SQLite files, and real sockets.
    // The budget stays finite so a wedged case still fails instead of sitting
    // until the CI job timeout.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // A suite that spawns and kills processes cannot share a worker with
    // another suite doing the same: pids, ports, and process groups are
    // process-global.
    fileParallelism: false,
    coverage: { enabled: false }
  }
})
