import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    // The suite `//examples:suite` declares. `burndown/pacer.test.mjs` is a
    // `node:test` file that `//examples:pacer` runs under Node's runner, as
    // PACER.md documents; collected here it registers no Vitest suite and fails.
    include: ["test/**/*.test.ts"],
    // A developer's credentials must not turn the ordinary suite into a paid
    // network run. Live smoke tests remain available through explicit opt-in.
    // Every provider key an example reads is masked, not only today's live one.
    env: process.env.SMITHERS_LIVE_EXAMPLES === "1"
      ? {}
      : { OPENAI_API_KEY: "", GEMINI_API_KEY: "", SMITHERS_EXAMPLE_API_KEY: "" },
    // Examples drive real SQLite files and real engine restarts, so they are
    // slower than a unit suite. The budget stays finite so a hang still fails.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
})
