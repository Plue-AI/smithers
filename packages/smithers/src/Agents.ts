/**
 * Wiring Smithers into the agents an operator already runs.
 *
 * `smthrs mcp add` writes the stdio MCP server entry into an agent's own
 * configuration.
 *
 * rc.0 knows two agents, Claude Code and Codex, because those are the two the
 * release supports directly; every other 0.x target (Hermes, OpenClaw, Pi)
 * moved to the plugins repository with its adapter. Writing is always
 * additive and idempotent: an entry that is already correct is left alone, and
 * an agent whose configuration cannot be written gets the snippet printed
 * instead of a silent failure.
 *
 * @since 1.0.0
 */

import { randomUUID } from "node:crypto"
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { errorCode } from "./internal/ErrorCode.ts"

/**
 * The MCP server name Smithers registers under.
 *
 * @category constants
 * @since 1.0.0
 */
export const serverName = "smithers"

/**
 * One agent this CLI can wire itself into.
 *
 * @category models
 * @since 1.0.0
 */
export interface Agent {
  readonly id: string
  /** The agent's MCP server map, relative to the home directory. */
  readonly mcpConfig: ReadonlyArray<string>
}

/**
 * The agents rc.0 wires.
 *
 * @category constants
 * @since 1.0.0
 */
export const agents: ReadonlyArray<Agent> = [
  { id: "claude", mcpConfig: [".claude.json"] },
  { id: "codex", mcpConfig: [".codex", "mcp.json"] }
]

/**
 * Finds one agent by id.
 *
 * @category getters
 * @since 1.0.0
 */
export const find = (id: string): Agent | undefined => agents.find((agent) => agent.id === id)

/**
 * The launch command an agent should start the MCP server with.
 *
 * The current executable and entry are used verbatim rather than a package
 * runner: a checkout under development must register the CLI under edit, and
 * an installed CLI registers its own installed path. 0.x registered
 * `bunx smthrs --mcp`, which silently pointed every agent at the last
 * published build.
 *
 * @category constructors
 * @since 1.0.0
 */
export const launchCommand = (
  execPath: string = process.execPath,
  entry: string = process.argv[1] ?? "smthrs"
): { readonly command: string; readonly args: ReadonlyArray<string> } => ({
  command: execPath,
  args: [entry, "--mcp"]
})

/**
 * What one wiring attempt did.
 *
 * @category models
 * @since 1.0.0
 */
export interface Wired {
  readonly agent: string
  readonly path: string
  readonly status: "written" | "unchanged" | "failed"
  readonly reason?: string | undefined
}

/** Why an existing configuration cannot be updated in place, if it cannot. */
interface Unusable {
  readonly reason: string
}

interface Configuration {
  readonly document: Record<string, unknown>
  readonly source: Buffer | undefined
  readonly mode: number | undefined
}

const isUnusable = (value: Configuration | Unusable): value is Unusable => "reason" in value

/**
 * Reads an agent's configuration, or says why it must not be written over.
 *
 * A missing file is the first-run case and reads as an empty document. Every
 * other unreadable shape is refused rather than replaced: treating a parse
 * failure as `{}` meant one stray comma in an operator's `~/.claude.json`
 * turned the whole file into a document holding nothing but the Smithers
 * server entry, with no copy of what was there before.
 */
const readJson = (path: string): Configuration | Unusable => {
  let descriptor: number
  try {
    descriptor = openSync(path, "r")
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { document: {}, source: undefined, mode: undefined }
    return { reason: `${path} could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  let source: Buffer
  let mode: number
  try {
    source = readFileSync(descriptor)
    mode = fstatSync(descriptor).mode & 0o777
  } catch (error) {
    return { reason: `${path} could not be read: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    closeSync(descriptor)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(source.toString("utf8"))
  } catch (error) {
    return {
      reason: `${path} is not valid JSON (${
        error instanceof Error ? error.message : String(error)
      }). Fix the file, then run this again.`
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { reason: `${path} has a root that is not a JSON object. Fix the file, then run this again.` }
  }
  return { document: parsed as Record<string, unknown>, source, mode }
}

const sourceStillMatches = (path: string, source: Buffer | undefined, mode: number | undefined): boolean => {
  try {
    const current = readFileSync(path)
    return source !== undefined && current.equals(source) && (statSync(path).mode & 0o777) === mode
  } catch (error) {
    return source === undefined && errorCode(error) === "ENOENT"
  }
}

const syncPath = (path: string): void => {
  const descriptor = openSync(path, "r")
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

/**
 * Age after which a lock carrying no owner is treated as abandoned.
 *
 * Only a lock written by 0.x, or by a process killed between creating the file
 * and naming itself in it, has no owner to ask about. Registration takes
 * milliseconds, so nothing this old is still being written.
 */
const ORPHAN_LOCK_MS = 5 * 60_000

/** Why the lock could not be taken, in the words the operator sees. */
interface Refusal {
  readonly reason: string
}

/** The process recorded in a lock, when it recorded one at all. */
const lockOwner = (token: string): number | undefined => {
  const separator = token.indexOf(":")
  const pid = Number(token.slice(0, separator < 0 ? token.length : separator))
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Whether the recorded owner is still running.
 *
 * Only `ESRCH` proves absence: a process owned by another user answers
 * `EPERM`, and reading that as death would delete a live owner's lock. A
 * recycled pid can only make a dead owner look alive, which costs a retry.
 */
const lockOwnerAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== "ESRCH"
  }
}

/**
 * Creates the lock with its owner already inside it, or reports it taken.
 *
 * The owner arrives by hard link rather than by a write after `openSync`,
 * because a crash between those two calls is exactly what leaves a lock nobody
 * can prove is dead.
 */
const claimLock = (lockPath: string, token: string): boolean => {
  const claim = `${lockPath}.${process.pid}.${randomUUID()}`
  writeFileSync(claim, token, { encoding: "utf8", flag: "wx", mode: 0o600 })
  try {
    linkSync(claim, lockPath)
    return true
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false
    throw error
  } finally {
    try {
      unlinkSync(claim)
    } catch {
      // The scratch file is already gone, which is the outcome this wanted.
    }
  }
}

/**
 * Removes a lock whose owner is provably gone.
 *
 * Answers a refusal, naming the lock file, whenever the lock has to stand:
 * removing one still held would let two processes rewrite the configuration at
 * once, so an owner that cannot be shown to be dead keeps it.
 */
const reclaimLock = (lockPath: string, path: string): Refusal | undefined => {
  let observed: string
  let age: number
  try {
    observed = readFileSync(lockPath, "utf8")
    age = Date.now() - statSync(lockPath).mtimeMs
  } catch (error) {
    // Gone between the failed claim and this read: the caller claims again.
    if (errorCode(error) === "ENOENT") return undefined
    throw error
  }
  const owner = lockOwner(observed)
  if (owner !== undefined && lockOwnerAlive(owner)) {
    return {
      reason: `${path} is being updated by another Smithers process (pid ${owner}). No change was written; ` +
        `run this again once it exits, or delete ${lockPath} if that process is gone.`
    }
  }
  if (owner === undefined && age < ORPHAN_LOCK_MS) {
    return {
      reason: `${path} is being updated by another Smithers process. No change was written; run this again, ` +
        `or delete ${lockPath} if no other Smithers process is running.`
    }
  }
  try {
    // Read the owner again immediately before removing it, so an observation
    // that has since been replaced never deletes the new owner's lock.
    if (readFileSync(lockPath, "utf8") === observed) unlinkSync(lockPath)
  } catch {
    // Another process recovered it first, which is the outcome this wanted.
  }
  return undefined
}

/** Takes the registration lock, recovering one left by a dead process. */
const acquireLock = (lockPath: string, path: string, token: string): Refusal | undefined => {
  if (claimLock(lockPath, token)) return undefined
  const refusal = reclaimLock(lockPath, path)
  if (refusal !== undefined) return refusal
  if (claimLock(lockPath, token)) return undefined
  // The lock was recovered and immediately taken by a live peer.
  return {
    reason: `${path} is being updated by another Smithers process. No change was written; run this again, ` +
      `or delete ${lockPath} if no other Smithers process is running.`
  }
}

/** Removes only the lock this call took, never a replacement. */
const releaseLock = (lockPath: string, token: string): void => {
  try {
    if (readFileSync(lockPath, "utf8") === token) unlinkSync(lockPath)
  } catch {
    // Best effort: a recovery may have replaced this token, and deleting the
    // new owner's lock would reopen the race the lock exists to close.
  }
}

/**
 * Registers the Smithers MCP server with one agent.
 *
 * @category constructors
 * @since 1.0.0
 */
export const addMcp = (agent: Agent, home: string = homedir()): Wired => {
  const path = join(home, ...agent.mcpConfig)
  const entry = launchCommand()
  const lockPath = `${path}.smithers.lock`
  const token = `${process.pid}:${Date.now()}:${randomUUID()}`
  let held = false
  try {
    mkdirSync(dirname(path), { recursive: true })
    const refusal = acquireLock(lockPath, path, token)
    if (refusal !== undefined) return { agent: agent.id, path, status: "failed", reason: refusal.reason }
    held = true
    const configuration = readJson(path)
    if (isUnusable(configuration)) {
      return { agent: agent.id, path, status: "failed", reason: configuration.reason }
    }
    const { document, mode, source } = configuration
    const existing = document["mcpServers"]
    if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
      return {
        agent: agent.id,
        path,
        status: "failed",
        reason: `${path} has an mcpServers member that is not an object. Fix the file, then run this again.`
      }
    }
    const servers = existing === undefined ? {} : { ...existing as Record<string, unknown> }
    const desired = { command: entry.command, args: [...entry.args] }
    if (JSON.stringify(servers[serverName]) === JSON.stringify(desired)) {
      return { agent: agent.id, path, status: "unchanged" }
    }
    servers[serverName] = desired
    // Temp-plus-rename, mode preserved: a crash between truncation and the
    // last byte would otherwise leave the operator with a half-written
    // configuration and no copy of the original.
    const temporary = `${path}.smithers-${process.pid}-${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ ...document, mcpServers: servers }, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: mode ?? 0o600
    })
    try {
      if (mode !== undefined) chmodSync(temporary, mode)
      syncPath(temporary)
      if (!sourceStillMatches(path, source, mode)) {
        return {
          agent: agent.id,
          path,
          status: "failed",
          reason: `${path} changed while Smithers was preparing the update. No change was written; run this again.`
        }
      }
      renameSync(temporary, path)
      syncPath(dirname(path))
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {
        // The temp file is already gone, which is the outcome this wanted.
      }
      throw error
    }
    return { agent: agent.id, path, status: "written" }
  } catch (error) {
    return {
      agent: agent.id,
      path,
      status: "failed",
      reason: error instanceof Error ? error.message : String(error)
    }
  } finally {
    if (held) releaseLock(lockPath, token)
  }
}

/**
 * The manual instructions printed when automatic registration fails.
 *
 * The `--` separator matters: without it an agent's own argument parser reads
 * `--mcp` as one of its flags and rejects the registration.
 *
 * @category constructors
 * @since 1.0.0
 */
export const manualInstructions = (targets: ReadonlyArray<string> = agents.map((agent) => agent.id)): string => {
  const entry = launchCommand()
  const launch = [entry.command, ...entry.args].join(" ")
  return [
    "Could not register the Smithers MCP server automatically.",
    "",
    "Register it with the agent's own CLI. The `--` separator is required so the",
    "agent treats everything after it as the launch command, not its own flags:",
    "",
    ...targets.map((target) => `  ${target} mcp add ${serverName} -- ${launch}`),
    "",
    "Or add it to the agent's MCP configuration by hand:",
    "",
    "  {",
    "    \"mcpServers\": {",
    `      "${serverName}": { "command": ${JSON.stringify(entry.command)}, "args": ${JSON.stringify(entry.args)} }`,
    "    }",
    "  }",
    "",
    "Docs: https://smithers.sh/docs/guides/mcp-setup/"
  ].join("\n")
}
