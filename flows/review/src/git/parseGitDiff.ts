import type { DiffRecord } from "./diffRecord.ts"

const ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, "\"": 34, "\\": 92 }

/**
 * Decodes the C-style quoted path Git writes when a name holds a tab, newline,
 * quote, backslash or (without `core.quotePath=false`) a non-ASCII byte.
 * `start` indexes the opening quote; the result ends just past the closing one.
 */
function unquoteAt(text: string, start: number): { value: string; end: number } | null {
  const bytes: Array<number> = []
  const encoder = new TextEncoder()
  let index = start + 1
  while (index < text.length) {
    const char = text[index]
    if (char === "\"") return { value: new TextDecoder().decode(new Uint8Array(bytes)), end: index + 1 }
    if (char !== "\\") {
      const point = text.codePointAt(index)!
      const literal = String.fromCodePoint(point)
      bytes.push(...encoder.encode(literal))
      index += literal.length
      continue
    }
    const escape = text[index + 1]
    if (escape !== undefined && escape in ESCAPES) {
      bytes.push(ESCAPES[escape]!)
      index += 2
      continue
    }
    const octal = /^[0-3][0-7]{2}/.exec(text.slice(index + 1, index + 4))
    if (octal === null) return null
    bytes.push(Number.parseInt(octal[0], 8))
    index += 4
  }
  return null
}

/** One path as Git prints it after `---`, `+++`, `rename from` and the like. */
function readPath(text: string): string | null {
  if (text.startsWith("\"")) {
    const quoted = unquoteAt(text, 0)
    return quoted !== null && quoted.end === text.length ? quoted.value : null
  }
  // An unquoted name holding a space is followed by a tab on `---`/`+++`
  // lines; a name that really ends in a tab would have been quoted.
  return text.replace(/\t$/, "")
}

function stripPrefix(path: string | null, prefix: string) {
  return path !== null && path.startsWith(prefix) ? path.slice(prefix.length) : null
}

/**
 * The two paths of a `diff --git <a> <b>` line. Each side is quoted or not on
 * its own; when neither is quoted and a name contains ` b/`, the split that
 * names the same file on both sides wins (the `---`/`+++` lines confirm it).
 */
function headerPaths(rest: string): { oldPath: string; newPath: string } | null {
  const pair = (a: string | null, b: string | null) => {
    const oldPath = stripPrefix(a, "a/")
    const newPath = stripPrefix(b, "b/")
    return oldPath !== null && newPath !== null ? { oldPath, newPath } : null
  }
  if (rest.startsWith("\"")) {
    const first = unquoteAt(rest, 0)
    if (first === null || rest[first.end] !== " ") return null
    return pair(first.value, readPath(rest.slice(first.end + 1)))
  }
  if (rest.endsWith("\"")) {
    for (let index = rest.indexOf(" \""); index >= 0; index = rest.indexOf(" \"", index + 1)) {
      const second = unquoteAt(rest, index + 1)
      if (second !== null && second.end === rest.length) return pair(rest.slice(0, index), second.value)
    }
  }
  let fallback: { oldPath: string; newPath: string } | null = null
  for (let index = rest.indexOf(" b/"); index >= 0; index = rest.indexOf(" b/", index + 1)) {
    const candidate = pair(rest.slice(0, index), rest.slice(index + 1))
    if (candidate === null) continue
    if (candidate.oldPath === candidate.newPath) return candidate
    fallback ??= candidate
  }
  return fallback
}

/**
 * Splits unified `git diff` text into one record per file, counting lines and
 * marking additions, deletions, and binaries.
 *
 * Every `diff --git` line starts a new record, quoted or not; one whose paths
 * cannot be read throws rather than folding its patch into the previous file.
 *
 * File headers (`---`, `+++`, mode lines) are read only before a file's first
 * hunk; inside a hunk every `+`/`-` line is content, so an added `++i;` (Git
 * prints `+++i;`) or a removed `-- comment` (`--- comment`) still counts.
 */
export function parseGitDiff(diffText: string): Array<DiffRecord> {
  const lines = diffText.split("\n")
  const records: Array<DiffRecord> = []
  let current: DiffRecord | null = null
  let buffer: Array<string> = []
  let inHunk = false
  const flush = () => {
    if (!current) return
    current.diff = buffer.join("\n").replace(/\n$/, "")
    records.push(current)
    buffer = []
  }

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const paths = headerPaths(line.slice("diff --git ".length))
      if (paths === null) throw new Error(`Cannot read the file paths of git diff header: ${JSON.stringify(line)}`)
      flush()
      current = {
        ...paths,
        diff: "",
        insertions: 0,
        deletions: 0,
        isNew: false,
        isDeleted: false,
        isBinary: false
      }
      inHunk = false
    }
    if (!current) continue
    if (line.startsWith("@@ ")) inHunk = true
    if (inHunk) {
      if (line.startsWith("+")) current.insertions += 1
      else if (line.startsWith("-")) current.deletions += 1
      buffer.push(line)
      continue
    }
    if (line.startsWith("Binary files ")) current.isBinary = true
    if (line.startsWith("new file mode ")) {
      current.isNew = true
      current.oldPath = "/dev/null"
    }
    if (line.startsWith("deleted file mode ")) {
      current.isDeleted = true
      current.newPath = "/dev/null"
    }
    const renamedFrom = /^(?:rename|copy) from (.*)$/.exec(line)
    const renamedTo = /^(?:rename|copy) to (.*)$/.exec(line)
    if (renamedFrom) current.oldPath = readPath(renamedFrom[1]!) ?? current.oldPath
    if (renamedTo) current.newPath = readPath(renamedTo[1]!) ?? current.newPath
    if (/^--- \/dev\/null$/.test(line) || /^--- a\/dev\/null$/.test(line)) current.isNew = true
    else if (line.startsWith("--- ") && !current.isNew) {
      current.oldPath = stripPrefix(readPath(line.slice(4)), "a/") ?? current.oldPath
    }
    if (/^\+\+\+ \/dev\/null$/.test(line) || /^\+\+\+ b\/dev\/null$/.test(line)) {
      current.isDeleted = true
      current.newPath = "/dev/null"
    } else if (line.startsWith("+++ ") && !current.isDeleted) {
      current.newPath = stripPrefix(readPath(line.slice(4)), "b/") ?? current.newPath
    }
    buffer.push(line)
  }
  flush()
  return records
}
