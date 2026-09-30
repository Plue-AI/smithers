import { tmpdir } from "node:os"
import { join } from "node:path"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Execution fixtures launch real toolchains, containers, and child CLIs;
    // planner fixtures copy and fingerprint production implementation trees.
    // Keep the file pool serial so the package does not multiply host-wide
    // contention. Test and cleanup budgets still bound external operations.
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      // Enabled so the thresholds below actually gate every run; without
      // this flag they were declared and never computed.
      enabled: true,
      provider: "v8",
      reportsDirectory: join(tmpdir(), `flows-build-cli-coverage-${process.pid}`),
      include: ["src/**"],
      // The floors are the measured coverage rounded down, an honest ratchet
      // raised as tests accrete toward the workspace's 100% norm.
      thresholds: {
        branches: 76,
        functions: 89,
        lines: 88,
        statements: 86,
        // Per-file floors over the execution backends. Without them a
        // regression in the modules that spawn, capture, and publish hides
        // behind an aggregate dominated by the planner and the renderers,
        // which is exactly where it hid before.
        "src/PackageExec.ts": { statements: 76, branches: 67, functions: 83, lines: 80 },
        // The original coordinator floor follows every extracted implementation.
        "src/internal/{PackagePlanner,PackageRunner,RulePolicy,rules/{NativeRules,NativeFileRule,DocsCheckRule}}.ts": {
          statements: 76,
          branches: 67,
          functions: 83,
          lines: 80
        },
        "src/PackageLoader.ts": { statements: 80, branches: 65, functions: 86, lines: 83 },
        "src/PackageTree.ts": { statements: 86, branches: 74, functions: 95, lines: 90 },
        "src/ServiceSupervisor.ts": { statements: 87, branches: 80, functions: 84, lines: 88 },
        "src/RepoResolution.ts": { statements: 99, branches: 98, functions: 100, lines: 99 },
        "src/RspackRunner.ts": { statements: 82, branches: 72, functions: 68, lines: 85 },
        "src/DockerExec.ts": { statements: 100, branches: 98, functions: 100, lines: 100 },
        "src/GoExec.ts": { statements: 98, branches: 94, functions: 100, lines: 99 },
        "src/StampExec.ts": { statements: 96, branches: 90, functions: 100, lines: 96 },
        // Fetch's extracted backend starts above its pre-move measured
        // 89.62/89.80/72.22/94.74 coverage. Planner and adapters are complete.
        "src/FetchExec.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/internal/CoreRuleSelection.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/Query.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/internal/rules/FetchPlan.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/internal/rules/FetchRule.ts": { statements: 100, branches: 100, functions: 100, lines: 100 },
        "src/internal/rules/FetchExecutor.ts": { statements: 90, branches: 90, functions: 73, lines: 95 }
      }
    }
  }
})
