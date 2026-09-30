import { defineConfig } from "vitest/config"

// One runner over `flows/**/*.e2e.ts`: each flow replays its recorded model
// fixture, so the suite runs offline and needs no provider key.
//
// The vite.config.ts plugins are deliberately absent: nothing under test needs
// workerd, and the create-app plugin would regenerate routes.gen.ts on every
// run. Regeneration is `pnpm routes`.
export default defineConfig({
  test: {
    include: ["flows/**/*.e2e.ts", "test/**/*.test.ts"],
    environment: "node",
    // The replay helper imports the routed flow and TOOLS.ts dynamically.
    // Keep those imports in Vitest's module graph so the test and the tool
    // share their collecting sink when create-app is installed from npm.
    server: { deps: { inline: ["@smthrs/create-app"] } },
    // A replay is fast; a recording run makes real provider calls, so the
    // budget is sized for the slower of the two.
    testTimeout: 300000
  },
  resolve: {
    // Linked @smthrs/* packages carry their own node_modules. One `effect`
    // instance per run keeps Context tags identical across them.
    dedupe: ["effect"]
  }
})
