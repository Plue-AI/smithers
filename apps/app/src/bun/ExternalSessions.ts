/*
 * Codex sessions on this machine, read for the conversation (mvp.md M-38).
 * A session is found by id or unique prefix under every Codex home, decoded
 * with @smthrs/harness/ExternalTranscript, and tailed: each read decodes only
 * the bytes appended since the last one. Command output and diffs are
 * clipped here, so a poll never ships a whole log.
 */
import { open, readdir, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { Result } from "effect"
import { codexStart, decodeCodex, type CodexState, type Entry } from "@smthrs/harness/ExternalTranscript"

/** Every sessions directory a Codex home on this machine can hold, CODEX_HOME first. */
export async function sessionRoots(home = homedir(), env: Readonly<Record<string, string | undefined>> = process.env): Promise<string[]> {
  const roots = [env.CODEX_HOME ? join(env.CODEX_HOME, "sessions") : "", join(home, ".codex", "sessions")]
  const accounts = join(home, ".smithers", "accounts")
  for (const name of await readdir(accounts).catch(() => [] as string[])) if (name.startsWith("codex")) roots.push(join(accounts, name, "sessions"))
  return [...new Set(roots.filter(Boolean))]
}

async function* rollouts(directory: string): AsyncGenerator<string> {
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) yield* rollouts(path)
    else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) yield path
  }
}

export type Lookup = { readonly path: string } | { readonly error: "unknown" | "ambiguous"; readonly message: string }

/** The newest rollout whose session id starts with `id`; a session copied into several homes reads the copy written last. */
export async function findRollout(id: string, roots: readonly string[]): Promise<Lookup> {
  const matches: Array<{ path: string; session: string; modified: number }> = []
  for (const root of roots) for await (const path of rollouts(root)) {
    const session = /rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(path)?.[1]
    if (session?.startsWith(id)) matches.push({ path, session, modified: (await stat(path)).mtimeMs })
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

interface Tail { offset: number; state: CodexState; readonly decoder: TextDecoder; readonly entries: Entry[]; error?: SessionRead["error"] }

/** Reads sessions by id, keeping one tail per rollout file for this host's lifetime. */
export function externalSessions(roots: () => Promise<readonly string[]> = () => sessionRoots()) {
  const tails = new Map<string, Tail>()
  return async (id: string, since = 0): Promise<SessionRead | Exclude<Lookup, { path: string }>> => {
    const found = await findRollout(id, await roots())
    if (!("path" in found)) return found
    const tail = tails.get(found.path) ?? { offset: 0, state: codexStart, decoder: new TextDecoder(), entries: [] }
    tails.set(found.path, tail)
    const size = (await stat(found.path)).size
    if (tail.error === undefined && size > tail.offset) {
      const file = await open(found.path)
      try {
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
