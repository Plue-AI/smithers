import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * The shipped templates' own suites, run as a gate of this package.
 *
 * `vitest.config.ts` runs `test/**` alone, because a template is a whole app
 * that installs its own `node_modules`. That left the templates' 104 tests
 * running nowhere: every test for the API's credential check, its body cap,
 * its session-id rule, the settle-once stream wrapper, and the turn wrapper's
 * cancel path lives under `template/aomi/test/`, so an edit to `worker/guard.ts`
 * or `worker/stream.ts` broke nothing any gate ran.
 *
 * The templates are not workspace members and this gate installs nothing, so
 * the aliases below stand in for what a scaffolded app's install resolves:
 *
 * - `@smthrs/create-app/*` is this package, which a scaffold gets from the
 *   registry.
 * - The five `@smthrs/*` packages the template imports that this package does
 *   not itself depend on resolve to their workspace sources. The rest already
 *   resolve through this package's own `node_modules`, and `dedupe` keeps one
 *   `effect` across all of them so Context tags stay identical.
 * - `tevm` resolves to a module whose every export throws
 *   (`test/support/tevmAbsent.ts`). It is an external dependency of the
 *   template alone and no workspace package carries it. Most suites reach the
 *   tool module only through `TOOLS.ts` and `routes.gen.ts`.
 *   `tevm-binding.test.ts` replaces the SDK explicitly to test connection
 *   recovery, endpoint selection, and input decoding without a live chain.
 *
 * `test/tevm.test.ts` is the one file excluded: it drives a real in-memory
 * chain, so it needs the real `tevm` and runs in a scaffolded app.
 *
 * What this does NOT do is typecheck the templates. That needs
 * `@cloudflare/workers-types`, `tevm`, `viem`, `react-dom`, and `@smthrs/ui`
 * resolvable as types, and this checkout installs none of them. A scaffolded
 * app does, and runs it as `pnpm typecheck`.
 */
const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url))

export default defineConfig({
  plugins: [{
    name: "bootstrap-test-imports",
    // The bootstrap suite mocks rendering; no app/Vite plugins run in tests.
    resolveId(id) {
      if (id === "virtual:smthrs-app/brand.css") return id
    }
  }],
  test: {
    include: ["template/*/test/**/*.test.ts", "template/*/flows/**/*.e2e.ts"],
    exclude: ["template/*/test/tevm.test.ts"],
    environment: "node",
    // The same finite budget `vitest.config.ts` uses: generous under a loaded
    // CI runner, still finite so a hang fails the gate instead of hanging it.
    testTimeout: 30_000,
    hookTimeout: 30_000
  },
  resolve: {
    dedupe: ["effect"],
    alias: [
      { find: /^@smthrs\/create-app$/, replacement: here("./src/index.ts") },
      { find: /^@smthrs\/create-app\/(.*)$/, replacement: here("./src/$1.ts") },
      // Spelled one package at a time. The five live at three different
      // depths now — packages nest, so `@smthrs/cli` is this package's own
      // parent, `core`, `kernel`, and `plan` are under `flows`, and `std` is
      // under `agent` — and one capture group cannot say that.
      { find: /^@smthrs\/cli$/, replacement: here("../src/index.ts") },
      { find: /^@smthrs\/cli\/(.*)$/, replacement: here("../src/$1.ts") },
      { find: /^@smthrs\/(core|kernel|plan)$/, replacement: here("../flows/$1/src/index.ts") },
      { find: /^@smthrs\/(core|kernel|plan)\/(.*)$/, replacement: here("../flows/$1/src/$2.ts") },
      { find: /^@smthrs\/std$/, replacement: here("../agent/std/src/index.ts") },
      { find: /^@smthrs\/std\/(.*)$/, replacement: here("../agent/std/src/$1.ts") },
      { find: /^@smthrs\/ui$/, replacement: here("../ui/src/index.ts") },
      { find: /^tevm(\/.*)?$/, replacement: here("./test/support/tevmAbsent.ts") },
      // The Durable Object base class, which only workerd resolves; the
      // template's own vitest.config.ts carries the same alias.
      { find: /^cloudflare:workers$/, replacement: here("./template/aomi/test/support/cloudflareWorkers.ts") }
    ]
  }
})
