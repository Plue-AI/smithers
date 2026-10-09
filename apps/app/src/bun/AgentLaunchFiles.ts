// File checks used by the local preview launcher while binding its own child.
import { constants } from "node:fs"
import { lstat, open, realpath } from "node:fs/promises"
import { homedir } from "node:os"
import { join, relative, resolve, sep } from "node:path"

export const CHUNK_LIMIT = 4 << 20
export const LINE_LIMIT = 64 << 20
export interface Refusal { readonly status: number; readonly code: string; readonly message: string }
const refusal = (status: number, code: string, message: string): { readonly refusal: Refusal } => ({ refusal: { status, code, message } })

const within = (root: string, path: string): boolean => {
  const below = relative(root, path)
  return below !== ".." && !below.startsWith(`..${sep}`) && !below.startsWith(sep)
}

/** Resolve root links afresh, allowing only the user's real home outside other seats; never follow a link beneath it. */
export async function regularPath(path: string, root: string, home = homedir()) {
  const absolute = resolve(path)
  const lexicalRoot = resolve(root)
  if (!within(lexicalRoot, absolute)) throw new Error("Outside transcript root")
  const resolvedRoot = await realpath(lexicalRoot)
  if (resolvedRoot !== lexicalRoot) {
    const resolvedHome = await realpath(home)
    if (!within(resolvedHome, resolvedRoot) || within(join(resolvedHome, ".smithers", "accounts"), resolvedRoot)) {
      throw new Error("Unsafe transcript root link")
    }
  }
  let component = lexicalRoot
  for (const name of relative(lexicalRoot, absolute).split(sep).filter(Boolean)) {
    component = join(component, name)
    if ((await lstat(component)).isSymbolicLink()) throw new Error("Symlink transcript path")
  }
  if (!within(resolvedRoot, await realpath(absolute))) throw new Error("Outside transcript root")
  return lstat(absolute === lexicalRoot ? resolvedRoot : absolute)
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
export async function readChunk(path: string, root: string, offset: number, found?: Identity, home = homedir()): Promise<Chunk | { readonly refusal: Refusal }> {
  const gone = refusal(404, "source_not_found", "The session file is gone.")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => undefined)
  if (file === undefined) return gone
  try {
    const opened = await file.stat()
    const current = await regularPath(path, root, home).catch(() => undefined)
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

