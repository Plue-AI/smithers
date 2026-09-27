/**
 * Hidden transition aliases; canonical commands are the only advertised surface.
 * @since 1.0.0
 */

import { removedVerbs } from "../Unsupported.ts"
import * as Argv from "./Argv.ts"

const legacy = new Set([
  ...removedVerbs.map((verb) => verb.name),
  "up",
  "plan",
  "approve",
  "deny",
  "ps",
  "ls",
  "logs",
  "events",
  "output",
  "cancel",
  "signal",
  "steer",
  "down",
  "resume",
  "status",
  "inspect",
  "why",
  "workflow",
  "gateway",
  "claude"
])
/**
 * Route only unambiguous old spellings, retaining their existing output contracts.
 * @category constructors
 * @since 1.0.0
 */
export const legacyArguments = (input: ReadonlyArray<string> | Argv.Globals): Array<string> | undefined => {
  const parsed = Argv.parse(input)
  const args = parsed.argv
  const index = parsed.first
  const [command, ...rest] = parsed.rest
  if (command === "internal" && args[index + 1] === "claude") return [...args.slice(0, index), ...args.slice(index + 1)]
  // Only the removed lifecycle subcommands use the compatibility refusal.
  if (command === "gateway") return rest[0] === "status" || rest[0] === "stop" ? [...args] : undefined
  if (command === "bug" && rest.length === 0) return [...args]
  if (command !== undefined && legacy.has(command)) return [...args]
  if (command === "run") {
    if (rest.some((arg) => arg === "--resume" || arg.startsWith("--resume=")) || rest[0]?.trimStart().startsWith("{")) {
      return [...args]
    }
  }
  return undefined
}

/**
 * Modern log formatting and pagination use the canonical streaming command.
 * @category parsing
 * @since 1.0.0
 */
export const formattedLogArguments = (input: ReadonlyArray<string> | Argv.Globals): Array<string> | undefined => {
  const parsed = Argv.parse(input)
  const args = parsed.argv
  const index = parsed.first
  if (parsed.rest[0] !== "logs" || parsed.json || parsed.backend !== undefined) return undefined
  if (
    parsed.format === undefined &&
    !parsed.rest.some((arg) => ["--after", "--limit"].includes(arg.split("=")[0]!))
  ) return undefined
  return ["runs", "logs", ...args.slice(0, index), ...args.slice(index + 1)]
}

/**
 * Bots using familiar flat spellings get canonical Incur results and next actions.
 * Explicit legacy JSON/quiet/backend contracts and internal protocols stay intact.
 * @category parsing
 * @since 1.0.0
 */
export const agentArguments = (input: ReadonlyArray<string> | Argv.Globals): Array<string> | undefined => {
  const parsed = Argv.parse(input)
  const args = parsed.argv
  if (
    parsed.json || parsed.quiet || parsed.backend !== undefined ||
    parsed.rest.some((arg) => ["--help", "-h", "--version"].includes(arg))
  ) return undefined
  const index = parsed.first
  const command = parsed.rest[0]
  const aliases: Record<string, ReadonlyArray<string>> = {
    up: ["flow", "start"],
    plan: ["flow", "plan"],
    ls: ["flow", "list"],
    ps: ["runs", "list"],
    resume: ["runs", "resume"],
    cancel: ["runs", "cancel"],
    signal: ["runs", "signal"],
    steer: ["runs", "steer"],
    approve: ["approvals", "approve"],
    deny: ["approvals", "deny"],
    output: ["runs", "output"],
    down: ["runs", "cancel-all"]
  }
  if (command === undefined || aliases[command] === undefined) return undefined
  // A missing positional still uses the legacy parser's typed, file-free usage error.
  if (
    command !== "ls" && command !== "ps" && command !== "down" &&
    (parsed.rest[1] === undefined || parsed.rest[1].startsWith("--"))
  ) return undefined
  // Removed 0.x options must keep their specific migration refusal, not become
  // a generic Incur unknown-flag error through a superficially similar alias.
  const allowed = new Set([
    "--data",
    "--detached",
    "-d",
    "--scope",
    "--flow",
    "--status",
    "--message"
  ])
  if (parsed.rest.some((arg) => arg.startsWith("--") && !allowed.has(arg.split("=")[0]!))) return undefined
  return [...aliases[command], ...args.slice(0, index), ...args.slice(index + 1)]
}
