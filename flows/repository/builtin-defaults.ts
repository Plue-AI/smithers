/**
 * The overridable flows the install ships as packaged defaults
 * (`packages/backend/internal/services/builtin_flows.json`) and the files each
 * one carries: its entry and the source modules beside it.
 *
 * `flows/coding/build.mjs` compiles these bytes into the deployed host and
 * `provisionBuiltins` writes them under the host's policy root, so discovery
 * measures the same closure, and the same execution digest, on every host.
 */
export const builtinDefaults = ["todo", "learning", "review"] as const

/** Whether a POSIX path under `flows/<name>/` ships with that default. */
export const shipsWithDefault = (relative: string): boolean =>
  relative === "flow.ts" || /^src\/(?:[\w.-]+\/)*[\w.-]+\.ts$/.test(relative)
