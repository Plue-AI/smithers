/**
 * The long fault tier: `test/faults/long/`, the durability cases measured in
 * tens of minutes or budgeted in hours. Scheduled reliability runs it nightly
 * through `//packages/smithers:faultsLong`; the release gate runs the rest of
 * `test/faults` from `vitest.faults.config.ts`.
 *
 * The same rules hold as for that tier: serial, because the cases kill process
 * groups and bind machine-global ports, and without coverage, because the work
 * happens in child processes. Each case declares its own budget.
 */
import { configDefaults, defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/faults/long/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    coverage: { enabled: false }
  }
})
