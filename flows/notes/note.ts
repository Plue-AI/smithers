/**
 * The shared boundary of the note flows: one Markdown note confined to a
 * workspace root, and bounded HTTP reads whose failures are short fixed
 * phrases safe to write into that note.
 */
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"

/** What every note flow's host binds: the workspace root and the network. */
export interface Host {
  readonly root: string
  readonly fetch: typeof globalThis.fetch
  readonly now: () => Date
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * The absolute path of `note` under `root`, or a reason it is refused: it must
 * be a relative `.md` path whose existing parent directory, and the note itself
 * when present, resolve inside the root through any symlink.
 */
export const resolveNote = async (root: string, note: string): Promise<string | { readonly refused: string }> => {
  if (note.length === 0 || isAbsolute(note) || !note.endsWith(".md") || /[\p{Cc}]/u.test(note)) {
    return { refused: "note must be a relative .md path" }
  }
  const path = resolve(root, note)
  if (!inside(root, path)) return { refused: "note must stay inside the workspace" }
  const realRoot = await realpath(root)
  const parent = await realpath(dirname(path)).catch(() => undefined)
  if (parent === undefined) return { refused: "note directory does not exist" }
  const target = join(parent, basename(path))
  if (!inside(realRoot, target)) return { refused: "note must stay inside the workspace" }
  const stat = await lstat(target).catch(() => undefined)
  if (stat !== undefined && !stat.isFile()) return { refused: "note must be a regular file" }
  return target
}

/** The note's text, or the empty string when it does not exist yet. */
export const readNote = (path: string) =>
  readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return ""
    throw error
  })

/** Replaces the note in one rename, so a reader never sees half a note. */
export const writeNote = async (path: string, text: string) => {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${Date.now()}.tmp`)
  await writeFile(temporary, text, "utf8")
  await rename(temporary, path)
}

/** The outcome of one bounded GET: the body, or a fixed phrase naming why not. */
export type Got = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }

const maxBytes = 5 * 1024 * 1024

/** GETs `url` within 20 seconds and 5 MiB. A failure never carries response text. */
export const get = async (host: Host, url: string, accept: string): Promise<Got> => {
  let response: Response
  try {
    response = await host.fetch(url, {
      headers: { accept, "user-agent": "smithers-note-flows" },
      redirect: "follow",
      signal: AbortSignal.timeout(20_000)
    })
  } catch {
    return { ok: false, reason: "unreachable" }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, reason: `HTTP ${response.status}` }
  }
  const declared = Number(response.headers.get("content-length") ?? "0")
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    return { ok: false, reason: "response too large" }
  }
  try {
    const text = await response.text()
    return Buffer.byteLength(text) > maxBytes ? { ok: false, reason: "response too large" } : { ok: true, text }
  } catch {
    return { ok: false, reason: "unreachable" }
  }
}

/** The date of `at` in `timeZone`, as `YYYY-MM-DD`. */
export const day = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
