// Fixture-only raw session lookup; production history uses normalized branch ingestion.
import { lstat, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export type ExternalAgent = "codex" | "claude-code"
export const agentName = (agent: ExternalAgent): string => agent === "codex" ? "Codex" : "Claude Code"

/** A session id or a prefix of at least four characters. */
export const SESSION_ID = /^[0-9a-f-]{4,36}$/
import { regularPath, readChunk, type Chunk, type Identity, type Refusal } from "../AgentLaunchFiles"
export { regularPath, readChunk, CHUNK_LIMIT, LINE_LIMIT } from "../AgentLaunchFiles"
const refusal = (status: number, code: string, message: string): { readonly refusal: Refusal } => ({ refusal: { status, code, message } })
const unknown = (agent: ExternalAgent, prefix: string) => refusal(404, "source_not_found", `No ${agentName(agent)} session ${prefix} on this machine.`)

/** The running user's own sessions directory for `agent`: its configured home, else the default one. */
export async function sessionRoots(agent: ExternalAgent, home = homedir(), env: Readonly<Record<string, string | undefined>> = process.env): Promise<string[]> {
  return agent === "codex" ? [join(env.CODEX_HOME || join(home, ".codex"), "sessions")] : [join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects")]
}

const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]+)\.jsonl$/

/** Codex keeps rollouts in dated directories at any depth; Claude Code keeps one file per session in each project's directory. */
async function* sessionFiles(agent: ExternalAgent, directory: string, root: string, home: string, depth = 0): AsyncGenerator<{ readonly id: string; readonly path: string }> {
  try {
    if (!(await regularPath(directory, root, home)).isDirectory()) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const info = await regularPath(path, root, home).catch(() => undefined)
      if (info?.isDirectory() && (agent === "codex" || depth === 0)) yield* sessionFiles(agent, path, root, home, depth + 1)
      else if (info?.isFile()) {
        const id = agent === "codex" ? ROLLOUT.exec(entry.name)?.[1] : depth === 1 && entry.name.endsWith(".jsonl") ? entry.name.slice(0, -".jsonl".length) : undefined
        if (id !== undefined && SESSION_ID.test(id)) yield { id, path }
      }
    }
  } catch { /* Missing or unsafe roots expose no sessions. */ }
}

export type Found = { readonly id: string; readonly path: string; readonly root: string } | { readonly refusal: Refusal }

/** The session whose id starts with `prefix`, the copy written last when there are several. */
export async function findSession(agent: ExternalAgent, prefix: string, roots: readonly string[], home = homedir()): Promise<Found> {
  if (!SESSION_ID.test(prefix)) return refusal(400, "invalid_request", `A ${agentName(agent)} session id or a prefix of at least four characters is required.`)
  const matches: Array<{ id: string; path: string; root: string; modified: number }> = []
  for (const root of roots) for await (const file of sessionFiles(agent, root, root, home)) {
    if (file.id.startsWith(prefix)) matches.push({ ...file, root, modified: (await lstat(file.path)).mtimeMs })
  }
  const ids = [...new Set(matches.map(match => match.id))].sort()
  if (ids.length === 0) return unknown(agent, prefix)
  if (ids.length > 1) return refusal(409, "ambiguous_session", `${prefix} matches ${ids.length} ${agentName(agent)} sessions: ${ids.join(", ")}.`)
  const { modified: _, ...newest } = matches.reduce((best, each) => each.modified > best.modified ? each : best)
  return newest
}

export interface SessionRead extends Chunk {
  readonly agent: ExternalAgent
  readonly session_id: string
}

/**
 * Reads a session by agent, id and offset under the directories `roots` names. A found session is reused until its
 * file is gone or replaced (another inode), so a session read every few seconds is not looked for every time. A file
 * that is gone, replaced or turned into a link between finding and reading answers no-session, and is forgotten.
 */
export function externalSessions(
  roots: (agent: ExternalAgent) => Promise<readonly string[]> = agent => sessionRoots(agent),
  options: { readonly find?: typeof findSession; readonly home?: string } = {}
) {
  const home = options.home ?? homedir()
  const find = options.find ?? findSession
  const found = new Map<string, { readonly id: string; readonly path: string; readonly root: string } & Identity>()
  const read = async (agent: ExternalAgent, prefix: string, offset: number): Promise<SessionRead | { readonly refusal: Refusal }> => {
    const key = `${agent}:${prefix}`
    let session = found.get(key)
    const info = session === undefined ? undefined : await regularPath(session.path, session.root, home).catch(() => undefined)
    if (session !== undefined && (info?.isFile() !== true || info.dev !== session.dev || info.ino !== session.ino)) {
      found.delete(key)
      session = undefined
    }
    if (session === undefined) {
      const looked = await find(agent, prefix, await roots(agent), home)
      if ("refusal" in looked) return looked
      const identity = await regularPath(looked.path, looked.root, home)
      if (!identity.isFile()) return unknown(agent, prefix)
      session = { ...looked, dev: identity.dev, ino: identity.ino }
      found.set(key, session)
    }
    const chunk = await readChunk(session.path, session.root, offset, session, home)
    if ("refusal" in chunk && chunk.refusal.status === 404) {
      found.delete(key)
      return unknown(agent, prefix)
    }
    return "refusal" in chunk ? chunk : { agent, session_id: session.id, ...chunk }
  }
  return async (agent: ExternalAgent, prefix: string, offset: number): Promise<SessionRead | { readonly refusal: Refusal }> => {
    try { return await read(agent, prefix, offset) } catch {
      // Discovery and every read-time path check fail closed with the same refusal.
      found.delete(`${agent}:${prefix}`)
      return unknown(agent, prefix)
    }
  }
}
