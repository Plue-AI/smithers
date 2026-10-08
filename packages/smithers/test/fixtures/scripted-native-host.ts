/**
 * An explicit offline judge for process fixtures that boot the native host.
 * Load with Node's --import before the real CLI entry. The CLI still runs its
 * actual bootstrap, storage and control paths; its platform deliberately
 * supplies the same evidence-based completion script as the in-process tests.
 */
import { installEffectResolution } from "@smthrs/build-cli/effect-resolution"

// Detached fixtures carry their preloads through NODE_OPTIONS. Preserve the
// caller's existing --no-warnings selection there too, before loading tsx.
if (process.execArgv.includes("--no-warnings") && !process.env.NODE_OPTIONS?.includes("--no-warnings")) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --no-warnings`.trim()
}

installEffectResolution()
const [ScriptedJudge, { platform }] = await Promise.all([
  import("@smthrs/agent/ScriptedJudge"),
  import("../../src/internal/NodeControlHost.ts")
])
Object.assign(platform, { evaluator: ScriptedJudge.layer })

// Detached CLI children compose their own host in a fresh process. Carry this
// explicit fixture decision through the same standard Node preload mechanism.
const preload = `--import=${import.meta.url}`
if (!process.env.NODE_OPTIONS?.includes(preload)) {
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} ${preload}`.trim()
}
