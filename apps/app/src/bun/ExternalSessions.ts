/*
 * The local preview's Codex and Claude Code sessions, served as raw JSONL for
 * the conversation (mvp.md M-38): this host's side of GET
 * /api/external/sessions, the contract packages/backend/internal/externalsessions
 * serves on an install. A session is found by id or unique prefix under the
 * running user's own agent home only (CODEX_HOME else ~/.codex, CLAUDE_CONFIG_DIR
 * else ~/.claude), never by path; other seats' homes stay private, and a link in
 * any component of a path is refused, so a linked home shows no sessions. A read
 * answers the file's complete lines from a byte offset. The app decodes them,
 * so nothing here parses a record. Every failed check answers no-session.
 */
import { constants } from "node:fs"
import { lstat, open, readdir, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"

export type ExternalAgent = "codex" | "claude-code"
export const agentName = (agent: ExternalAgent): string => agent === "codex" ? "Codex" : "Claude Code"

/** A session id or a prefix of at least four characters. */
export const SESSION_ID = /^[0-9a-f-]{4,36}$/
/** One read: whole lines up to 4 MiB. */
export const CHUNK_LIMIT = 4 << 20
/** The one line a read returns when that line alone is longer than a chunk. */
export const LINE_LIMIT = 64 << 20

/** Why a session was not found or read, with the status the host answers. */
export interface Refusal { readonly status: number; readonly code: string; readonly message: string }
const refusal = (status: number, code: string, message: string): { readonly refusal: Refusal } => ({ refusal: { status, code, message } })
const unknown = (agent: ExternalAgent, prefix: string) => refusal(404, "source_not_found", `No ${agentName(agent)} session ${prefix} on this machine.`)

/** The running user's own sessions directory for `agent`: its configured home, else the default one. */
export async function sessionRoots(agent: ExternalAgent, home = homedir(), env: Readonly<Record<string, string | undefined>> = process.env): Promise<string[]> {
  return agent === "codex" ? [join(env.CODEX_HOME || join(home, ".codex"), "sessions")] : [join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects")]
}

/** `path`'s metadata, refusing a link in any of its components and a path outside `root`. */
async function regularPath(path: string, root: string) {
  const absolute = resolve(path)
  let component: string = sep
  for (const name of absolute.split(sep).filter(Boolean)) {
    component = join(component, name)
    if ((await lstat(component)).isSymbolicLink()) throw new Error("Symlink transcript path")
  }
  const below = relative(await realpath(root), await realpath(absolute))
  if (below === ".." || below.startsWith(`..${sep}`)) throw new Error("Outside transcript root")
  return lstat(absolute)
}

const ROLLOUT = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f-]+)\.jsonl$/

/** Codex keeps rollouts in dated directories at any depth; Claude Code keeps one file per session in each project's directory. */
async function* sessionFiles(agent: ExternalAgent, directory: string, root: string, depth = 0): AsyncGenerator<{ readonly id: string; readonly path: string }> {
  try {
    if (!(await regularPath(directory, root)).isDirectory()) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const info = await regularPath(path, root).catch(() => undefined)
      if (info?.isDirectory() && (agent === "codex" || depth === 0)) yield* sessionFiles(agent, path, root, depth + 1)
      else if (info?.isFile()) {
        const id = agent === "codex" ? ROLLOUT.exec(entry.name)?.[1] : depth === 1 && entry.name.endsWith(".jsonl") ? entry.name.slice(0, -".jsonl".length) : undefined
        if (id !== undefined && SESSION_ID.test(id)) yield { id, path }
      }
    }
  } catch { /* Missing or unsafe roots expose no sessions. */ }
}

export type Found = { readonly id: string; readonly path: string; readonly root: string } | { readonly refusal: Refusal }

/** The session whose id starts with `prefix`, the copy written last when there are several. */
export async function findSession(agent: ExternalAgent, prefix: string, roots: readonly string[]): Promise<Found> {
  if (!SESSION_ID.test(prefix)) return refusal(400, "invalid_request", `A ${agentName(agent)} session id or a prefix of at least four characters is required.`)
  const matches: Array<{ id: string; path: string; root: string; modified: number }> = []
  for (const root of roots) for await (const file of sessionFiles(agent, root, root)) {
    if (file.id.startsWith(prefix)) matches.push({ ...file, root, modified: (await lstat(file.path)).mtimeMs })
  }
  const ids = [...new Set(matches.map(match => match.id))].sort()
  if (ids.length === 0) return unknown(agent, prefix)
  if (ids.length > 1) return refusal(409, "ambiguous_session", `${prefix} matches ${ids.length} ${agentName(agent)} sessions: ${ids.join(", ")}.`)
  const { modified: _, ...newest } = matches.reduce((best, each) => each.modified > best.modified ? each : best)
  return newest
}

/** Complete lines from `offset`: `text` ends at a line boundary, `next` is the offset after it, `eof` says the read reached the file's end. */
export interface Chunk { readonly offset: number; readonly next: number; readonly text: string; readonly eof: boolean }

const NEWLINE = 0x0a

/** A file's identity: the one found must be the one read. */
export interface Identity { readonly dev: number; readonly ino: number }

/**
 * The file's complete lines from `offset`, at most CHUNK_LIMIT bytes of them; a longer first line alone, up to
 * LINE_LIMIT. The file is opened without following a link and must be the one `root` holds at `path` now and, when
 * `found` is given, the one found there.
 */
export async function readChunk(path: string, root: string, offset: number, found?: Identity): Promise<Chunk | { readonly refusal: Refusal }> {
  const gone = refusal(404, "source_not_found", "The session file is gone.")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined)
  if (file === undefined) return gone
  try {
    const opened = await file.stat()
    const current = await regularPath(path, root).catch(() => undefined)
    const same = (other: Identity | undefined) => other !== undefined && opened.dev === other.dev && opened.ino === other.ino
    if (!opened.isFile() || !same(current) || (found !== undefined && !same(found))) return gone
    const size = opened.size
    if (offset > size) return refusal(409, "offset_out_of_range", `The session file is ${size} bytes, shorter than offset ${offset}: it was replaced.`)
    const read = async (at: number, length: number): Promise<Uint8Array> => {
      const bytes = new Uint8Array(length)
      const { bytesRead } = await file.read(bytes, 0, length, at)
      return bytes.subarray(0, bytesRead)
    }
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes)
    const first = await read(offset, Math.min(CHUNK_LIMIT, size - offset))
    const end = offset + first.length
    const last = first.lastIndexOf(NEWLINE)
    if (last >= 0) return { offset, next: offset + last + 1, text: decode(first.subarray(0, last + 1)), eof: end >= size }
    // One line longer than a chunk: read on to its newline.
    const parts = [first]
    let length = first.length
    for (let at = end; at < size && length < LINE_LIMIT;) {
      const more = await read(at, Math.min(CHUNK_LIMIT, size - at, LINE_LIMIT - length))
      if (more.length === 0) break
      const newline = more.indexOf(NEWLINE)
      if (newline >= 0) {
        parts.push(more.subarray(0, newline + 1))
        const next = offset + length + newline + 1
        return { offset, next, text: decode(Buffer.concat(parts)), eof: next >= size }
      }
      parts.push(more)
      length += more.length
      at += more.length
    }
    if (offset + length >= size) return { offset, next: offset, text: "", eof: true }
    return refusal(422, "line_too_long", `The line at byte ${offset} is longer than ${LINE_LIMIT >> 20} MiB.`)
  } finally { await file.close() }
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
  options: { readonly find?: typeof findSession } = {}
) {
  const find = options.find ?? findSession
  const found = new Map<string, { readonly id: string; readonly path: string; readonly root: string } & Identity>()
  const read = async (agent: ExternalAgent, prefix: string, offset: number): Promise<SessionRead | { readonly refusal: Refusal }> => {
    const key = `${agent}:${prefix}`
    let session = found.get(key)
    const info = session === undefined ? undefined : await regularPath(session.path, session.root).catch(() => undefined)
    if (session !== undefined && (info?.isFile() !== true || info.dev !== session.dev || info.ino !== session.ino)) {
      found.delete(key)
      session = undefined
    }
    if (session === undefined) {
      const looked = await find(agent, prefix, await roots(agent))
      if ("refusal" in looked) return looked
      const identity = await regularPath(looked.path, looked.root)
      if (!identity.isFile()) return unknown(agent, prefix)
      session = { ...looked, dev: identity.dev, ino: identity.ino }
      found.set(key, session)
    }
    const chunk = await readChunk(session.path, session.root, offset, session)
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
