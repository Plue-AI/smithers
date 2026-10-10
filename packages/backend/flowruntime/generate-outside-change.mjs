import { readFileSync, writeFileSync } from "node:fs"
const source = new URL("./outside_change.json", import.meta.url)
const target = new URL("../../smithers/agent/src/OutsideChangePolicy.ts", import.meta.url)
const policy = JSON.parse(readFileSync(source, "utf8"))
if (typeof policy.enabled !== "boolean") throw new Error("Consumer policy must be boolean")
const text = `// Generated from packages/backend/flowruntime/outside_change.json.
// Regenerate: node packages/backend/flowruntime/generate-outside-change.mjs
/**
 * The build-time outside-change switch the agent host shares with the backend.
 * While it is false, the host refuses outside_change signals. Enable it only
 * with the pinned durable consumer and daemon stale-write enforcement composed.
 *
 * @since 1.0.0
 */

/**
 * @since 1.0.0
 * @private
 */
export const outsideChangeConsumerEnabled: boolean = ${policy.enabled}
`
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== text) throw new Error("Outside-change policy artifact is stale")
} else writeFileSync(target, text)
