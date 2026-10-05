/*
 * Codex sessions on this machine, read for the conversation (mvp.md M-38).
 * A session is found by id or unique prefix under the running user’s Codex home, decoded
 * with @smthrs/harness/ExternalTranscript, and tailed: each read decodes only
 * the bytes appended since the last one. Command output and diffs are
 * clipped here, so a poll never ships a whole log.
 */
import { constants } from "node:fs"
import { open, readdir, lstat, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve, relative, sep } from "node:path"
import { Result } from "effect"
import { codexStart, decodeCodex, type CodexState, type Entry } from "@smthrs/harness/ExternalTranscript"

/** Only the running user's configured home, or ~/.codex when unset. */
export async function sessionRoots(home = homedir(), env: Readonly<Record<string, string | undefined>> = process.env): Promise<string[]> {
  return [join(env.CODEX_HOME || join(home, ".codex"), "sessions")]
}

/** Reject links in every component below the filesystem root. */
async function regularPath(path: string, root: string) {
  const absolute = resolve(path)
  let component: string = sep
  for (const name of absolute.split(sep).filter(Boolean)) {
    component = join(component, name)
    if ((await lstat(component)).isSymbolicLink()) throw new Error("Symlink transcript path")
  }
  const canonicalRoot = await realpath(root)
  const canonical = await realpath(absolute)
  const below = relative(canonicalRoot, canonical)
  if (below === ".." || below.startsWith(`..${sep}`) || resolve(canonicalRoot, below) !== canonical) throw new Error("Outside transcript root")
  return lstat(absolute)
}

async function* rollouts(directory: string, root = directory): AsyncGenerator<string> {
  try {
    if (!(await regularPath(directory, root)).isDirectory()) return
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const info = await regularPath(path, root).catch(() => undefined)
      if (info?.isDirectory()) yield* rollouts(path, root)
      else if (info?.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) yield path
    }
  } catch { /* Missing or unsafe roots expose no sessions. */ }
}

export type Lookup = { readonly path: string } | { readonly error: "unknown" | "ambiguous"; readonly message: string }

/** The newest rollout whose session id starts with `id`; only regular files beneath the supplied root are eligible. */
export async function findRollout(id: string, roots: readonly string[]): Promise<Lookup> {
  const matches: Array<{ path: string; session: string; modified: number }> = []
  for (const root of roots) for await (const path of rollouts(root)) {
    const session = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(path)?.[1]
    if (session?.startsWith(id)) matches.push({ path, session, modified: (await lstat(path)).mtimeMs })
  }
  const sessions = [...new Set(matches.map(match => match.session))]
  if (sessions.length === 0) return { error: "unknown", message: `No Codex session ${id} on this machine.` }
  if (sessions.length > 1) return { error: "ambiguous", message: `${id} matches ${sessions.length} Codex sessions: ${sessions.join(", ")}.` }
  return { path: matches.sort((left, right) => right.modified - left.modified)[0]!.path }
}

const OUTPUT_HEAD = 1_500
const OUTPUT_TAIL = 2_500
const DIFF_LIMIT = 24_000

/** Long output keeps its start and its end; the middle says how many lines it left out. */
export function clip(text: string, head = OUTPUT_HEAD, tail = OUTPUT_TAIL): string {
  if (text.length <= head + tail) return text
  const omitted = text.slice(head, text.length - tail).split("\n").length
  return `${text.slice(0, head)}\n… ${omitted} lines omitted …\n${text.slice(text.length - tail)}`
}

/** A diff past the limit ends at its last whole line before it. */
const clipDiff = (diff: string): string => diff.length <= DIFF_LIMIT ? diff : diff.slice(0, diff.lastIndexOf("\n", DIFF_LIMIT) + 1)

export const clipped = (entry: Entry): Entry => entry.part.type === "tool" ? { ...entry, part: { ...entry.part, output: clip(entry.part.output) } }
  : entry.part.type === "edit" ? { ...entry, part: { ...entry.part, files: entry.part.files.map(file => ({ ...file, diff: clipDiff(file.diff) })) } }
  : entry

export interface SessionRead {
  readonly session_id: string
  readonly format_version: string
  readonly cwd: string
  readonly entries: ReadonlyArray<Entry>
  /** The next `since`: entries with a lower `seq` were already sent. */
  readonly next: number
  readonly error?: { readonly code: string; readonly message: string }
}

interface Tail { lastRead: number; dev: number; ino: number; offset: number; state: CodexState; readonly decoder: TextDecoder; readonly entries: Entry[]; error?: SessionRead["error"] }

/** Cache discovery per id; retain decoded tails only while actively read. */
export function externalSessions(
  roots: () => Promise<readonly string[]> = () => sessionRoots(),
  options: { readonly now?: () => number; readonly lookup?: typeof findRollout } = {}
) {
  const now = options.now ?? Date.now
  const lookup = options.lookup ?? findRollout
  const paths = new Map<string, { path: string; root: string; dev: number; ino: number }>()
  const tails = new Map<string, Tail>()
  return async (id: string, since = 0): Promise<SessionRead | Exclude<Lookup, { path: string }>> => {
    const time = now()
    for (const [path, tail] of tails) if (time - tail.lastRead >= 10 * 60_000) {
      tails.delete(path)
      for (const [session, cached] of paths) if (cached.path === path) paths.delete(session)
    }
    let found = paths.get(id)
    let info = found ? await regularPath(found.path, found.root).catch(error => {
      if (error?.code === "ENOENT") return undefined
      throw error
    }) : undefined
    if (found && (!info || info.dev !== found.dev || info.ino !== found.ino)) {
      tails.delete(found.path)
      paths.delete(id)
      found = undefined
    }
    if (!found) {
      const directories = await roots()
      const discovered = await lookup(id, directories)
      if (!("path" in discovered)) return discovered
      const path = resolve(discovered.path)
      const root = directories.find(root => path.startsWith(resolve(root) + sep))
      if (!root) return { error: "unknown", message: `No Codex session ${id} on this machine.` }
      info = await regularPath(path, root)
      found = { path, root, dev: info.dev, ino: info.ino }
      paths.set(id, found)
    }
    if (!info?.isFile()) return { error: "unknown", message: `No Codex session ${id} on this machine.` }
    const root = found.root
    const previous = tails.get(found.path)
    const tail: Tail = previous && previous.dev === info.dev && previous.ino === info.ino && info.size >= previous.offset
      ? previous : { lastRead: time, dev: info.dev, ino: info.ino, offset: 0, state: codexStart, decoder: new TextDecoder(), entries: [] }
    tail.lastRead = time
    tails.set(found.path, tail)
    const size = info.size
    if (tail.error === undefined && size > tail.offset) {
      const file = await open(found.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const opened = await file.stat()
        const current = await regularPath(found.path, root)
        if (!opened.isFile() || opened.dev !== current.dev || opened.ino !== current.ino) return { error: "unknown", message: `No Codex session ${id} on this machine.` }
        const bytes = new Uint8Array(size - tail.offset)
        const { bytesRead } = await file.read(bytes, 0, bytes.length, tail.offset)
        tail.offset += bytesRead
        const text = tail.decoder.decode(bytes.subarray(0, bytesRead), { stream: true })
        const decoded = decodeCodex(tail.state, text)
        if (Result.isSuccess(decoded)) {
          tail.state = decoded.success.state
          tail.entries.push(...decoded.success.entries.map(clipped))
        } else {
          // Keep every entry before the line that stopped the import; the error says where it stopped.
          const good = (tail.state.pending + text).split("\n").slice(0, decoded.failure.line - tail.state.line - 1)
          const before = decodeCodex({ ...tail.state, pending: "" }, good.map(line => `${line}\n`).join(""))
          if (Result.isSuccess(before)) tail.entries.push(...before.success.entries.map(clipped))
          tail.error = { code: decoded.failure.code, message: decoded.failure.message }
        }
      } finally { await file.close() }
    }
    const session = tail.state.session
    return {
      session_id: session?.id ?? id, format_version: session?.format_version ?? "", cwd: session?.cwd ?? "",
      entries: tail.entries.slice(Math.max(0, since)), next: tail.entries.length,
      ...(tail.error === undefined ? {} : { error: tail.error })
    }
  }
}
