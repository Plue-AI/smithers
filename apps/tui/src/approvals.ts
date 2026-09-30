/**
 * Approvals: a consequential flow call waits for the person at the keyboard.
 *
 * The kernel's attended `GrantStore` asks. `authorize` asks it for each
 * consequential capability a call declares, `Agent.Options.authorize` runs
 * that before the call's clock starts, and a denial reaches the cell as
 * `capability_refused` carrying the `Denied: ` message this module writes. The
 * UI polls `list` and answers with `reply`. Under `ask`, a `Memory` answers
 * first for what this run already decided; see `Memory`.
 *
 * Consequential means the declared capability can change something the
 * workspace's VCS will not show, or reach outside the process: every
 * `fs:write` (this host restores no snapshot, so "compensable" is never
 * compensated), `proc:spawn`, and all `net:` actions (a GET still sends data
 * out). Reads and the TUI's own runtime flows declare none of these, except
 * `monitor.create`, whose shell source runs a command.
 */
import * as Capability from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import type * as Cell from "@smthrs/harness/Cell"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { structuredPatch } from "diff"
import { Effect, Layer, Option } from "effect"
import { createHash } from "node:crypto"
import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import * as Changes from "./changes.ts"
import type * as Monitors from "./monitors.ts"

/** `ask` waits for y/n, `all` asks nothing, `deny` refuses every consequential call. */
export type Mode = "ask" | "all" | "deny"
/** The answers `GrantStore.reply` takes that the TUI offers. */
export type Choice = "once" | "deny" | "run"

/** The lines a write changes, as a row shows them: `+` or `-` first. */
export interface Preview {
  readonly added: number
  readonly removed: number
  /** At most `previewLines`, each at most `previewWidth` characters. */
  readonly lines: ReadonlyArray<string>
}

export interface Meta {
  readonly flow: string
  readonly subject: string
  /** `chat`, or the worker tab id. */
  readonly source: string
  /** The same for the same flow, input and capability; see `Memory`. */
  readonly identity: string
  readonly preview?: Preview
}

/** A shell call, as a denied path or a read-only declaration reads it. */
export interface Command {
  /** Every string the call runs: command, script, arguments, stdin, interpreter, environment. */
  readonly text: string
  /** The real directory it runs in, which its relative words resolve against. */
  readonly base: string
  /** Absolute patterns from a hermetic call's `writes`; `undefined` when it declared none. */
  readonly writes: ReadonlyArray<string> | undefined
  /** What it does if it declared `writes: []` and nothing in its text says otherwise; see `readOnly`. */
  readonly readOnly: Reading
}

export interface Request {
  readonly capability: Capability.Capability
  readonly meta: Meta
  readonly command?: Command
  /** The harness call's identity (`Changes.identity`), for `Memory.changed`. */
  readonly call?: string
}

export interface Pending extends Meta {
  readonly requestId: string
  readonly action: Capability.Action
  readonly resource: string
  readonly tier: Capability.EffectTier
  /** Whether `a` can allow this for the rest of the run. */
  readonly always: boolean
}

export const environmentKey = "SMITHERS_TUI_APPROVE"

/**
 * Every call runs unasked by default. `--approve` (winning) or
 * `SMITHERS_TUI_APPROVE` set to `ask` or `deny` turns the gate on.
 */
export const mode = (
  env: Readonly<Record<string, string | undefined>>,
  options: { readonly print: boolean; readonly flag?: string | undefined }
): Mode | { readonly error: string } => {
  const [value, name, joiner] = options.flag !== undefined
    ? [options.flag, "--approve", " "]
    : [env[environmentKey], environmentKey, "="]
  if (value === undefined || value === "") return "all"
  if (value !== "ask" && value !== "all" && value !== "deny") {
    return { error: `${name} must be ask, all or deny` }
  }
  if (value === "ask" && options.print) return { error: `${name}${joiner}ask needs the interactive TUI` }
  return value
}

export const consequential = (capability: Capability.Capability, cwd: string): boolean =>
  capability.action.startsWith("net:") || Capability.tierOf(capability, { workspaceRoot: cwd }) !== "sealed"

/**
 * A path as the write will reach it: every symlink on the way is followed,
 * including a dangling last one, which a write creates the target of.
 * Components that do not exist yet are kept as written.
 */
export const real = (path: string): string => {
  let head = "/"
  const rest = (isAbsolute(path) ? path : `${process.cwd()}/${path}`).split("/")
  let hops = 0
  while (rest.length > 0) {
    const part = rest.shift()!
    if (part === "" || part === ".") continue
    if (part === "..") {
      head = dirname(head)
      continue
    }
    const next = join(head, part)
    let link: string | undefined
    try {
      if (lstatSync(next).isSymbolicLink()) link = readlinkSync(next)
    } catch {
      // Absent components retain their names.
    }
    if (link === undefined) head = next
    else {
      if (++hops > 64) throw new HarnessError({ code: "engine_failed", message: "Too many symlinks" })
      if (isAbsolute(link)) head = "/"
      rest.unshift(...link.split("/"))
    }
  }
  return cased(head)
}

/** `path` with its existing part spelled as on disk, which a case-insensitive volume need not match. */
const cased = (path: string): string => {
  let head = path
  const tail: Array<string> = []
  for (;;) {
    try {
      return join(realpathSync.native(head), ...tail)
    } catch {
      if (head === "/") return path
      tail.unshift(basename(head))
      head = dirname(head)
    }
  }
}

/** Whether names on the volume holding `path` match regardless of case: `A` finds `a`. */
const insensitive = (path: string): boolean => {
  for (let at = path; at !== dirname(at); at = dirname(at)) {
    const name = basename(at)
    const swapped = name === name.toLowerCase() ? name.toUpperCase() : name.toLowerCase()
    if (swapped === name) continue
    try {
      const here = statSync(at)
      try {
        const there = statSync(join(dirname(at), swapped))
        return here.ino === there.ino && here.dev === there.dev
      } catch {
        return false
      }
    } catch {
      // Not on disk yet: the volume is its nearest existing parent's.
    }
  }
  return false
}

/** How the volume holding `path` compares names: lowercased where case does not matter. */
const comparing = (path: string): (text: string) => string =>
  insensitive(path) ? (text) => text.toLowerCase() : (text) => text

/**
 * Keys that never change what a call does, per flow. A hermetic call's
 * `reads` and `writes` only narrow a lexical pre-check that refuses more.
 */
const inert: Record<string, ReadonlyArray<string>> = { bash: ["mode", "timeoutMs", "reads", "writes"] }

/** A word the shell reads as itself; anything else is single-quoted. */
const quoted = (word: string): string => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`

/**
 * A command as the shell line that runs it: `cd dir && export NAME=value; command`.
 * The environment reads as an export because it covers the whole line. Only a
 * call whose every other key is inert reads this way; anything more shows
 * whole, so `y` approves exactly what runs.
 */
const commandLine = (input: Record<string, unknown>, keys: ReadonlyArray<string>): string | undefined => {
  const { command, cwd, env } = input
  if (typeof command !== "string" || !keys.every((key) => key === "command" || key === "cwd" || key === "env")) {
    return undefined
  }
  if (cwd !== undefined && typeof cwd !== "string") return undefined
  if (env !== undefined && (typeof env !== "object" || env === null || Array.isArray(env))) return undefined
  const pairs = Object.entries((env ?? {}) as Record<string, unknown>)
  if (!pairs.every(([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && typeof value === "string")) {
    return undefined
  }
  return [
    ...(cwd === undefined ? [] : [`cd ${quoted(cwd)} &&`]),
    ...(pairs.length === 0
      ? []
      : [`export ${pairs.map(([name, value]) => `${name}=${quoted(value as string)}`).join(" ")};`]),
    command
  ].join(" ")
}

/**
 * What a row shows for a call: a command as its shell line, a lone string
 * input as itself, otherwise every key that changes what runs. Never a chosen
 * key alone, since the flow's decoder may strip that key while another one runs.
 */
export const shownInput = (flow: string, input: unknown): string => {
  if (typeof input !== "object" || input === null) return input === undefined ? "" : JSON.stringify(input)
  const keys = Object.keys(input).filter((key) => !(inert[flow] ?? []).includes(key))
  const line = flow === "bash" ? commandLine(input as Record<string, unknown>, keys) : undefined
  if (line !== undefined) return line
  const only = keys.length === 1 ? (input as Record<string, unknown>)[keys[0]!] : undefined
  if (typeof only === "string") return only
  return JSON.stringify(Object.fromEntries(keys.map((key) => [key, (input as Record<string, unknown>)[key]])))
}

/** The verb a row reads: `? run node check.mjs`, `? edit math.js`. */
export const verb = (flow: string): string => flow === "bash" ? "run" : flow

/** Row bounds, well inside the store's metadata limit. */
export const previewLines = 24
export const previewWidth = 240

/** Text the store accepts: a lone surrogate becomes `�`. */
export const wellFormed = (text: string): string => text.toWellFormed()

/**
 * One changed line as a row can draw it: control characters shown as `�` so
 * no line rewrites the screen, cut by code point with `…` so it stays valid text.
 */
const drawable = (line: string): string => {
  const points = [...wellFormed(line).replace(/(?!\t)\p{Cc}/gu, "\ufffd")]
  return points.length <= previewWidth ? points.join("") : `${points.slice(0, previewWidth - 1).join("")}…`
}

/** Counts every changed line; keeps the first `previewLines`. */
const collect = (lines: ReadonlyArray<string>): Preview => {
  let added = 0
  let removed = 0
  const kept: Array<string> = []
  for (const line of lines) {
    if (line.startsWith("+")) added++
    else if (line.startsWith("-")) removed++
    else continue
    if (kept.length < previewLines) kept.push(drawable(line))
  }
  return { added, removed, lines: kept }
}

const split = (text: string): ReadonlyArray<string> => text === "" ? [] : text.replace(/\n$/, "").split("\n")

/** The changed lines between two texts; a diff too large to compute is every line out, then every line in. */
export const hunk = (before: string, after: string): Preview => {
  const patch = structuredPatch("", "", before, after, "", "", { context: 0, maxEditLength: 1_000 })
  return collect(
    patch === undefined
      ? [...split(before).map((line) => `-${line}`), ...split(after).map((line) => `+${line}`)]
      : patch.hunks.flatMap((each) => each.lines)
  )
}

/** A text file's content; `null` when absent, `undefined` when unreadable, binary or large. */
const text = (path: string): string | null | undefined => {
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size > 512_000) return undefined
    const bytes = readFileSync(path)
    if (bytes.includes(0)) return undefined
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "ENOENT" || code === "ENOTDIR" ? null : undefined
  }
}

interface Section {
  readonly kind: string
  readonly lines: Array<string>
}

/** Each file's sections of a V4A patch, keyed by every path they name; a file named twice collects both. */
const sections = (patch: string): ReadonlyMap<string, Section> => {
  const found = new Map<string, Section>()
  let open: Section | undefined
  for (const line of patch.split("\n")) {
    const header = /^\s*\*\*\* (Add|Update|Delete) File: (.+?)\s*$/.exec(line)
    const moved = /^\s*\*\*\* Move to: (.+?)\s*$/.exec(line)
    if (header !== null) {
      open = found.get(header[2]!) ?? { kind: header[1]!, lines: [] }
      found.set(header[2]!, open)
    } else if (moved !== null && open !== undefined) found.set(moved[1]!, open)
    else if (/^\s*\*\*\* /.test(line)) open = line.includes("End of File") ? open : undefined
    else if (open !== undefined && (line.startsWith("+") || line.startsWith("-"))) open.lines.push(line)
  }
  return found
}

/**
 * What a write to `path` changes, for its row: the file as the edit or write
 * leaves it against the file now, or a patch's own lines for that file.
 * `undefined` when the file cannot be read.
 */
export const preview = (flow: string, input: unknown, path: string, cwd: string): Preview | undefined => {
  if (typeof input !== "object" || input === null) return undefined
  const value = input as Record<string, unknown>
  const file = isAbsolute(path) ? path : join(cwd, path)
  if (flow === "write" && typeof value.content === "string") {
    const before = text(file)
    return before === undefined ? undefined : hunk(before ?? "", value.content)
  }
  if (flow === "edit" && typeof value.newString === "string") {
    const replacing = value.newString
    const before = text(file)
    if (typeof value.oldString === "string") {
      const old = value.oldString
      // Every occurrence `replaceAll` replaces; the anchor's own lines when the file does not hold it.
      if (typeof before !== "string" || old === "" || !before.includes(old)) return hunk(old, replacing)
      return hunk(
        before,
        value.replaceAll === true ? before.split(old).join(replacing) : before.replace(old, () => replacing)
      )
    }
    const { startLine, endLine } = value
    if (typeof startLine !== "number" || typeof endLine !== "number" || typeof before !== "string") return undefined
    // As the edit splices it: the range's text, without its last line's newline, becomes `newString`.
    const lines = before.split("\n")
    if (startLine < 1 || endLine < startLine || endLine > lines.length) return undefined
    const start = startLine === 1 ? 0 : lines.slice(0, startLine - 1).join("\n").length + 1
    return hunk(before, before.slice(0, start) + replacing + before.slice(lines.slice(0, endLine).join("\n").length))
  }
  if (flow === "apply_patch" && typeof value.input === "string") {
    const section = sections(value.input).get(path)
    if (section === undefined) return undefined
    if (section.kind !== "Delete") return collect(section.lines)
    const before = text(file)
    return typeof before === "string" ? hunk(before, "") : undefined
  }
  return undefined
}

/** Object keys sorted at every depth, so the same input always hashes the same. */
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : typeof value === "object" && value !== null
    ? Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    )
    : value

/**
 * See `Meta.identity`. `state` is what else decides the outcome: the file a
 * write or a line-range edit replaces, or the plan a launch approves.
 */
export const identity = (
  flow: string,
  input: unknown,
  capability: Capability.Capability,
  state?: unknown
): string =>
  createHash("sha256").update(
    JSON.stringify([flow, canonical(input), Capability.format(capability), state === undefined ? null : state])
  ).digest("hex")

/** What a write replaces, for its identity: `null` when nothing does. */
const replaced = (flow: string, input: unknown, path: string, cwd: string): string | null => {
  const value = typeof input === "object" && input !== null ? input as Record<string, unknown> : {}
  if (flow !== "write" && !(flow === "edit" && value.oldString === undefined)) return null
  const before = text(isAbsolute(path) ? path : join(cwd, path))
  return typeof before === "string" ? createHash("sha256").update(before).digest("hex") : String(before)
}

/**
 * How a reading program may be called. Every word that starts with `-` must
 * be a bundle of `letters` (a count may follow: `-n5`, `-U3`), a bare count
 * (`-5`), or one of `options` whole, with or without `=value`. An
 * abbreviation is not the option it abbreviates, so it is refused.
 */
interface Reader {
  readonly letters?: string
  readonly options?: ReadonlyArray<string>
  /** The first word after `global` options must be one of these: `git status`. */
  readonly subcommands?: ReadonlyArray<string>
  readonly global?: ReadonlyArray<string>
}

/** Programs that can neither write nor start another program, whatever their options. */
const plain = new Set([
  "basename",
  "cat",
  "cmp",
  "column",
  "cut",
  "dirname",
  "du",
  "echo",
  "false",
  "grep",
  "head",
  "jq",
  "ls",
  "md5sum",
  "pwd",
  "realpath",
  "sha256sum",
  "shasum",
  "stat",
  "tail",
  "test",
  "tr",
  "true",
  "wc",
  "which"
])

/** Programs with options that write or start another program: only the listed options pass. */
const readers: Readonly<Record<string, Reader>> = {
  diff: {
    letters: "abBcCiNqrstTuUwy",
    options: [
      "--",
      "--brief",
      "--color",
      "--ignore-all-space",
      "--ignore-blank-lines",
      "--ignore-case",
      "--ignore-space-change",
      "--new-file",
      "--recursive",
      "--side-by-side",
      "--strip-trailing-cr",
      "--text",
      "--unified"
    ]
  },
  find: {
    options: [
      "-a",
      "-and",
      "-depth",
      "-empty",
      "-false",
      "-iname",
      "-ipath",
      "-iregex",
      "-maxdepth",
      "-mindepth",
      "-mmin",
      "-mtime",
      "-name",
      "-newer",
      "-not",
      "-o",
      "-or",
      "-path",
      "-perm",
      "-print",
      "-print0",
      "-prune",
      "-regex",
      "-size",
      "-true",
      "-type",
      "-wholename",
      "-xdev"
    ]
  },
  git: {
    global: ["--no-pager"],
    subcommands: ["status", "diff", "log", "show", "grep", "ls-files", "rev-parse", "blame"],
    letters: "abcCehilLmMnopPqRsStuUvwzAEFG",
    options: [
      "--",
      "--abbrev-commit",
      "--abbrev-ref",
      "--after-context",
      "--all",
      "--author",
      "--before-context",
      "--branch",
      "--cached",
      "--check",
      "--color",
      "--context",
      "--count",
      "--date",
      "--decorate",
      "--deleted",
      "--diff-filter",
      "--exclude-standard",
      "--exit-code",
      "--extended-regexp",
      "--files-with-matches",
      "--first-parent",
      "--fixed-strings",
      "--follow",
      "--format",
      "--full-name",
      "--graph",
      "--grep",
      "--ignore-case",
      "--ignored",
      "--is-inside-work-tree",
      "--line-number",
      "--max-count",
      "--merges",
      "--modified",
      "--name-only",
      "--name-status",
      "--no-color",
      "--no-ext-diff",
      "--no-merges",
      "--no-renames",
      "--no-textconv",
      "--numstat",
      "--oneline",
      "--others",
      "--patch",
      "--porcelain",
      "--pretty",
      "--quiet",
      "--raw",
      "--reverse",
      "--short",
      "--shortstat",
      "--show-prefix",
      "--show-toplevel",
      "--since",
      "--stat",
      "--staged",
      "--summary",
      "--unified",
      "--until",
      "--untracked-files",
      "--verify",
      "--word-diff"
    ]
  },
  // `-v` assigns a shell variable, such as `HOME` or `PATH` for a later command.
  printf: { options: ["--"] },
  rg: {
    letters: "aABcCeEfFgHiIjlLmMnNopPqrsStTuUvwx0",
    options: [
      "--",
      "--after-context",
      "--before-context",
      "--case-sensitive",
      "--color",
      "--context",
      "--count",
      "--count-matches",
      "--files",
      "--files-with-matches",
      "--files-without-match",
      "--fixed-strings",
      "--follow",
      "--glob",
      "--heading",
      "--hidden",
      "--iglob",
      "--ignore-case",
      "--invert-match",
      "--json",
      "--line-number",
      "--line-regexp",
      "--max-count",
      "--max-depth",
      "--multiline",
      "--no-filename",
      "--no-heading",
      "--no-ignore",
      "--no-line-number",
      "--null",
      "--only-matching",
      "--quiet",
      "--regexp",
      "--smart-case",
      "--sort",
      "--type",
      "--type-not",
      "--vimgrep",
      "--with-filename",
      "--word-regexp"
    ]
  },
  sort: {
    letters: "bdfghkMnrstuVz",
    options: [
      "--dictionary-order",
      "--general-numeric-sort",
      "--human-numeric-sort",
      "--ignore-case",
      "--ignore-leading-blanks",
      "--month-sort",
      "--numeric-sort",
      "--reverse",
      "--stable",
      "--unique",
      "--version-sort",
      "--zero-terminated"
    ]
  },
  tree: {
    letters: "aCdDfFghiIJlLnNpPQrstuUvx",
    options: ["--charset", "--dirsfirst", "--du", "--filelimit", "--gitignore", "--noreport", "--prune"]
  }
}

const allowed = (reader: Reader, word: string): boolean =>
  /^-[0-9]+$/.test(word) ||
  (reader.letters !== undefined && new RegExp(`^-[${reader.letters}]+[0-9]*$`).test(word)) ||
  reader.options?.includes(word.split("=")[0]!) === true

/**
 * Programs that run the workspace's own code: the script file a call names,
 * by the extension its interpreter runs it by.
 */
const scripts: Readonly<Record<string, RegExp>> = {
  bun: /\.[cm]?[jt]sx?$/,
  node: /\.[cm]?[jt]s$/,
  python: /\.py$/,
  python3: /\.py$/
}

/** The words that start each program's test runner, which also runs the workspace's own code. */
const runners: Readonly<Record<string, ReadonlyArray<ReadonlyArray<string>>>> = {
  bun: [["test"]],
  node: [["--test"]],
  npm: [["test"], ["t"]],
  pnpm: [["test"], ["t"]],
  python: [["-m", "pytest"], ["-m", "unittest"]],
  python3: [["-m", "pytest"], ["-m", "unittest"]],
  yarn: [["test"]]
}

/**
 * What a declared-read-only command does, read lexically: `reads`, `runs`
 * the workspace's own scripts or tests, or `false` for anything else.
 */
export type Reading = "reads" | "runs" | false

/** The real path `word` names from `base`, when it is `root` or inside it. */
const inside = (word: string, root: string, base: string): string | undefined => {
  const target = real(isAbsolute(word) ? word : join(base, word))
  const path = relative(root, target)
  return path.startsWith("..") || isAbsolute(path) ? undefined : target
}

/** Whether `word` names a regular file inside `root`, from `base`. */
const within = (word: string, root: string, base: string): boolean => {
  const target = inside(word, root, base)
  try {
    return target !== undefined && statSync(target).isFile()
  } catch {
    return false
  }
}

/**
 * One command. A program is found by its bare name only, never a path to
 * one. A script or test runner never takes piped or redirected input, which
 * could be code. A runner takes no options, which could load some, and no
 * path outside `root`, which could be code from anywhere.
 */
const reading = (command: Words, root: string, base: string): Reading => {
  const [program, ...rest] = command.words
  if (program === undefined) return "reads"
  if (program.includes("/")) return false
  const runner = runners[program]?.find((prefix) => prefix.every((word, at) => rest[at] === word))
  if (runner !== undefined) {
    const words = rest.slice(runner.length)
    return !command.fed && words.every((word) => !word.startsWith("-") && inside(word, root, base) !== undefined) &&
      "runs"
  }
  const script = scripts[program]
  if (script !== undefined) {
    const file = rest[0]
    return !command.fed && file !== undefined && script.test(file) && within(file, root, base) && "runs"
  }
  if (plain.has(program)) return "reads"
  const reader = readers[program]
  if (reader === undefined) return false
  let at = 0
  if (reader.subcommands !== undefined) {
    while (reader.global?.includes(rest[at] ?? "") === true) at++
    if (!reader.subcommands.includes(rest[at] ?? "")) return false
    at++
  }
  return rest.slice(at).every((word) => !word.startsWith("-") || word === "-" || allowed(reader, word)) && "reads"
}

/** One command's words, quotes and escapes removed. */
interface Words {
  readonly words: ReadonlyArray<string>
  /** Its input is a pipe or a file: `a | b`, `b < file`. */
  readonly fed: boolean
}

/** Shell text as its commands, and what in it a lexical reading cannot follow. */
interface Parsed {
  readonly commands: ReadonlyArray<Words>
  /** An unquoted `>` other than `N>&M` or to `/dev/null`, or a here-document. */
  readonly redirects: boolean
  /**
   * Text the shell rewrites before it runs: `$` outside single quotes, an
   * unquoted `~` starting a word or following `=` or `:`, or an unquoted `*`,
   * `?`, `[` or `{`.
   */
  readonly expands: boolean
}

/** Reads shell text as the shell splits it: separators and redirections inside quotes are text. */
const parse = (shell: string): Parsed => {
  const found: Array<{ words: Array<string>; fed: boolean }> = [{ words: [], fed: false }]
  let redirects = false
  let expands = false
  let word: string | undefined
  let quote: string | undefined
  const end = () => {
    if (word !== undefined) found.at(-1)!.words.push(word)
    word = undefined
  }
  for (let at = 0; at < shell.length; at++) {
    const char = shell[at]!
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else if (char === "\\" && quote === "\"" && at + 1 < shell.length) word = (word ?? "") + shell[++at]
      else {
        expands ||= char === "$" && quote === "\""
        word = (word ?? "") + char
      }
    } else if (char === "'" || char === "\"") {
      quote = char
      word = word ?? ""
    } else if (char === "\\" && at + 1 < shell.length) word = (word ?? "") + shell[++at]
    else if (char === ">") {
      // A descriptor number just before belongs to the redirection, not the command.
      if (word !== undefined && /^[0-9]*$/.test(word)) word = undefined
      end()
      const rest = shell.slice(shell[at + 1] === ">" ? at + 2 : at + 1)
      const duplicate = /^&(?:[0-9]+|-)(?=$|[\s;&|)])/.exec(rest)
      const discarded = /^\s*\/dev\/null(?=$|[\s;&|)])/.exec(rest)
      if (duplicate === null && discarded === null) redirects = true
      // Past the redirection; a file target is read on as a word.
      at = shell.length - rest.length + (duplicate?.[0].length ?? discarded?.[0].length ?? 0) - 1
    } else if (char === "<" && shell[at + 1] === "<") {
      redirects = true
      end()
    } else if (char === "<") {
      end()
      found.at(-1)!.fed = true
    } else if (char === "&" && shell[at - 1] === "|") continue
    else if (/[;&|\n(){}]/.test(char)) {
      end()
      expands ||= char === "{"
      // `|` and `|&` feed the next command; `||` does not.
      found.push({ words: [], fed: char === "|" && shell[at - 1] !== "|" && shell[at + 1] !== "|" })
    } else if (/\s/.test(char)) end()
    else {
      expands ||= /[$*?[]/.test(char) || (char === "~" && (word === undefined || /[=:]$/.test(word)))
      word = (word ?? "") + char
    }
  }
  end()
  return { commands: found, redirects, expands }
}

/**
 * Whether shell text reads as only reading, lexically, run from `base`
 * inside the workspace `root` (both real): every command in it is a known
 * reader called with allowed options, or runs a script file inside `root`
 * or the workspace's tests (`runs`), with no expansion, command
 * substitution, here-document, or output redirection except `N>&M` or to
 * `/dev/null`. It is a check of the declaration, not a sandbox; `Memory`
 * stops trusting declarations once one changed a file or could not be checked.
 */
export const readOnly = (shell: string, root: string, base = root): Reading => {
  if (/`|<\(|>\(/.test(shell)) return false
  const parsed = parse(shell)
  if (parsed.redirects || parsed.expands) return false
  let found: Reading = "reads"
  for (const command of parsed.commands) {
    const one = reading(command, root, base)
    if (one === false) return false
    if (one === "runs") found = one
  }
  return found
}

/** How a shell call reads for `Memory`; see `Command`. */
const command = (flow: string, input: unknown, cwd: string): Command | undefined => {
  if (flow !== "bash" || typeof input !== "object" || input === null) return undefined
  const value = input as Record<string, unknown>
  const strings = (each: unknown): ReadonlyArray<string> =>
    typeof each === "string"
      ? [each]
      : Array.isArray(each)
      ? each.flatMap(strings)
      : typeof each === "object" && each !== null
      ? Object.values(each).flatMap(strings)
      : []
  const text = ["command", "script", "stdin", "args", "interpreter", "env"].flatMap((key) => strings(value[key])).join(
    "\n"
  )
  const root = real(cwd)
  const base = real(typeof value.cwd === "string" ? (isAbsolute(value.cwd) ? value.cwd : join(cwd, value.cwd)) : cwd)
  const inside = base === root || base.startsWith(`${root.replace(/\/+$/, "")}/`)
  const writes = value.mode === "hermetic" && Array.isArray(value.writes)
    ? (value.writes as ReadonlyArray<unknown>).map((glob) =>
      isAbsolute(String(glob)) ? String(glob) : join(base, String(glob))
    )
    : undefined
  return {
    text,
    base,
    writes,
    readOnly: writes !== undefined && writes.length === 0 && typeof value.command === "string" && inside &&
        ["container", "env", "script", "stdin", "interpreter", "args"].every((key) => value[key] === undefined)
      ? readOnly(value.command, root, base)
      : false
  }
}

/**
 * Flows that spawn a process for some inputs only: the command a call runs,
 * or `undefined` when it runs none. A shell-sourced monitor runs its command
 * on every tick, so creating one is asked like running it.
 */
const spawns: Readonly<Record<string, (input: unknown) => string | undefined>> = {
  "monitor.create": (input) => {
    const source = typeof input === "object" && input !== null ? (input as { source?: unknown }).source : undefined
    if (typeof source !== "object" || source === null) return undefined
    const { kind, command } = source as { kind?: unknown; command?: unknown }
    return kind === "shell" ? String(command) : undefined
  }
}

/**
 * The request a restored shell monitor waits on before it runs again: the one
 * `monitor.create` asked, so an `a` for that flow covers both.
 */
export const monitorRequest = (command: string, source = "chat"): Request => {
  const capability = Capability.make("proc:spawn", "monitor.create")
  return {
    capability,
    meta: {
      flow: "monitor.create",
      subject: command,
      source,
      identity: identity("monitor.create", command, capability)
    }
  }
}

/**
 * `Monitors.Ports.authorize` over a host's `authorize`: a restored shell
 * monitor asks under this session's mode, whatever the session that created
 * it allowed. Other sources run nothing and ask nothing.
 */
export const restored =
  (authorize: (requests: ReadonlyArray<Request>) => Promise<void>) =>
  (monitor: Pick<Monitors.Monitor, "source">): Promise<void> =>
    authorize(monitor.source.kind === "shell" ? [monitorRequest(monitor.source.command)] : [])

/** One request per consequential capability, narrowed to what this call touches. */
export const requests = (call: Cell.Call, cwd: string, source: string): ReadonlyArray<Request> => {
  const found = new Map<string, Request>()
  const subject = shownInput(call.flowName, call.input)
  const shell = command(call.flowName, call.input, cwd)
  const add = (capability: Capability.Capability, shown: string, preview?: Preview, state?: unknown) =>
    found.set(Capability.format(capability), {
      capability,
      meta: {
        flow: call.flowName,
        subject: wellFormed(shown),
        source,
        identity: identity(call.flowName, call.input, capability, state),
        ...(preview === undefined ? {} : { preview })
      },
      ...(shell === undefined ? {} : { command: shell }),
      call: Changes.identity(call.identity)
    })
  for (const declared of call.capabilities) {
    const parsed = Capability.parse(declared)
    if (Option.isNone(parsed) || !consequential(parsed.value, cwd)) continue
    const capability = parsed.value
    if (capability.action === "fs:write") {
      // `undefined` or nothing named: ask for everything the flow declares.
      const paths = Changes.touched(call.flowName, call.input) ?? []
      if (paths.length === 0) add(capability, subject)
      const root = real(cwd)
      for (const path of paths) {
        // The store classifies lexically, so hand it the path the write reaches.
        const target = real(isAbsolute(path) ? path : `${cwd}/${path}`)
        const inside = relative(root, target)
        add(
          Capability.make("fs:write", target),
          inside !== "" && !inside.startsWith("..") && !isAbsolute(inside) ? inside : target,
          preview(call.flowName, call.input, path, cwd),
          replaced(call.flowName, call.input, path, cwd)
        )
      }
    } else if (capability.action === "proc:spawn") {
      // The flow, not the command: `a` then means this flow for the run.
      const spawned = spawns[call.flowName]
      const shown = spawned === undefined ? subject : spawned(call.input)
      if (shown === undefined) continue
      add(Capability.make("proc:spawn", call.flowName), shown)
    } else {
      add(capability, subject)
    }
  }
  return [...found.values()]
}

/** A project plan grants its declared envelope, not a built-in writer's input shape. */
export const project = (
  flow: string,
  capabilities: ReadonlyArray<string>,
  cwd: string,
  source: string,
  /** The plan's digest, which covers its input: `y` allows this launch, not the next one's. */
  digest: string
): ReadonlyArray<Request> => {
  const found = new Map<string, Request>()
  for (const declared of capabilities) {
    const parsed = Capability.parsePattern(declared)
    if (Option.isNone(parsed)) {
      throw new HarnessError({ code: "engine_failed", message: `Invalid capability: ${declared}` })
    }
    const pattern = parsed.value
    for (const action of Capability.Action.literals) {
      if (pattern.action !== "*" && pattern.action !== action && pattern.action !== `${action.split(":")[0]}:*`) {
        continue
      }
      // A glob cannot prove symlink containment. Ask for broad write authority.
      const resource = action === "fs:write"
        ? Capability.isLiteralResource(pattern.resource)
          ? real(isAbsolute(pattern.resource) ? pattern.resource : `${cwd}/${pattern.resource}`)
          : "/**"
        : action === "proc:spawn"
        ? flow
        : pattern.resource
      const capability = Capability.make(action, resource)
      if (!consequential(capability, cwd)) continue
      const subject = Capability.format(capability)
      found.set(subject, {
        capability,
        meta: { flow, subject, source, identity: identity(flow, subject, capability, digest) }
      })
    }
  }
  return [...found.values()]
}

const denyAll = new Permission.Rule({
  effect: "deny",
  pattern: new Capability.CapabilityPattern({ action: "*", resource: "**" })
})

export const layer = (cwd: string, approvals: Mode): Layer.Layer<GrantStore.GrantStore> =>
  GrantStore.layer({ attended: true, planDigest: "smithers-tui", rules: approvals === "deny" ? [denyAll] : [] }).pipe(
    // Real, like the resources `requests` asks for, so containment agrees.
    Layer.provide(Workspace.layer(real(cwd))),
    Layer.orDie
  )

/** Starts every denial message this host writes; the cell reads it as `capability_refused`. */
export const deniedPrefix = "Denied: "

/**
 * The message a denied request reaches the cell with. `path` names the file
 * whose refused change a command touches.
 */
export const refusal = (meta: Pick<Meta, "flow" | "subject">, path?: string): string =>
  `${deniedPrefix}${meta.flow} ${meta.subject}. ${
    path === undefined
      ? "The person refused this for the rest of the run; do not do it another way."
      : `It names ${path}, whose change the person refused for the rest of the run; do not change it another way.`
  }`

/** Whether a settled call is a denial this host wrote, not some other refusal. */
export const denied = (result: Cell.CallResult): boolean =>
  result.outcome === "failure" && result.code === "capability_refused" &&
  (result.message ?? "").startsWith(deniedPrefix)

/** Print mode's notice for a denied flow: one line per flow, the first time only. */
export const notices = () => {
  const seen = new Set<string>()
  return (flow: string): string | undefined => {
    if (seen.has(flow)) return undefined
    seen.add(flow)
    return `denied ${flow}; ${environmentKey}=all allows`
  }
}

/** What one run (a `source`) has answered; see `Memory`. */
interface Run {
  /** Identities allowed with `y`. */
  readonly allowed: Set<string>
  /** Identities denied with `n`. */
  readonly refused: Set<string>
  /** Real paths whose change was denied. */
  readonly paths: Set<string>
  /** What `a` allowed. */
  readonly grants: Array<Capability.CapabilityPattern>
  /** Commands asked about, by identity, so an answer can settle the waiting ones it covers. */
  readonly commands: Map<string, Command>
  /** Calls that ran unasked on a read-only declaration, until their changes are captured. */
  readonly declared: Set<string>
  /** Of `declared`, those whose changes were captured and found none. */
  readonly checked: Set<string>
  /** False once a call declared read-only changed a file or could not be checked. */
  trusted: boolean
}

/** What `Memory` answers without asking. */
export type Decision =
  | { readonly _tag: "allow" }
  | { readonly _tag: "deny"; readonly path?: string }
  /** Ask, even where an allowance covers it: it may reach a refused file. */
  | { readonly _tag: "ask" }

/**
 * How a command touches a refused file: by a word that resolves to it, or
 * only by one that could: its name from another directory, a directory
 * holding it, or a glob.
 */
const touches = (shell: Command, path: string): "names" | "may" | undefined => {
  const key = comparing(path)
  const refused = key(path)
  const name = basename(refused)
  let may = false
  for (const { words } of parse(shell.text).commands) {
    for (const word of words) {
      if (word === "") continue
      const resolved = isAbsolute(word) ? word : join(shell.base, word)
      const target = key(real(resolved))
      const named = key(basename(word)) === name
      if (named && target === refused) return "names"
      may ||= named || refused.startsWith(`${target.replace(/\/+$/, "")}/`) || (/[*?[]/.test(word) &&
        covers(key(resolved), refused))
    }
  }
  return may ? "may" : undefined
}

/** Whether a write glob covers a path. */
const covers = (glob: string, path: string): boolean =>
  Capability.matches(
    new Capability.CapabilityPattern({ action: "fs:write", resource: glob }),
    Capability.make("fs:write", path)
  )

/** Whether `path` is the same file as the refused `refused`, as their volume compares names. */
const same = (refused: string, path: string): boolean => {
  const key = comparing(refused)
  return key(refused) === key(path)
}

/**
 * Version control's own files: writing them can make a later `git status`
 * run a program, so no `a` covers them.
 */
const internal = (resource: string): boolean => /\/\.(git|jj)(\/|$)/i.test(resource)

/**
 * What each run already decided, so the person is asked once per decision.
 * A run is one `source` for one `Host.run`: `forget` starts the next.
 *
 * - `y` allows that identical request again in the run.
 * - `n` denies it again, and denies the change: any later write of the same
 *   path through edit, write or apply_patch, and any shell call with a word
 *   that resolves to the file or a declared write that covers it. A shell
 *   call with a word that only could reach it is asked, even under `a`.
 * - `a` allows every request its label names for the rest of the run,
 *   except writes to `.git` or `.jj`.
 * - A shell call that declares `writes: []` and reads as only reading
 *   (`readOnly`) runs unasked, while the run has refused nothing and every
 *   such earlier call was captured changing no file. One that runs a script
 *   or tests runs unasked only until `a` allows edits.
 *
 * A denial wins over every allowance. The host keeps one `Memory` under
 * `ask` only: `deny` must never meet an allowance.
 */
export class Memory {
  private readonly runs = new Map<string, Run>()

  constructor(
    /** Whether a shell call's changes can be captured here; without it nothing runs on a declaration. */
    private readonly checkable = true
  ) {}

  private run(source: string): Run {
    let found = this.runs.get(source)
    if (found === undefined) {
      found = {
        allowed: new Set(),
        refused: new Set(),
        paths: new Set(),
        grants: [],
        commands: new Map(),
        declared: new Set(),
        checked: new Set(),
        trusted: true
      }
      this.runs.set(source, found)
    }
    return found
  }

  /** A new run of `source` starts with nothing decided. */
  forget(source: string): void {
    this.runs.delete(source)
  }

  /**
   * What to do with `request` without asking; `ask` when the person must
   * answer. `declared` is whether a read-only declaration may run unasked
   * here: never where the call's changes are not captured, such as on a box.
   */
  decide(request: Pick<Request, "capability" | "meta" | "command" | "call">, declared = true): Decision {
    const run = this.runs.get(request.meta.source)
    const shell = request.command ?? run?.commands.get(request.meta.identity)
    if (run !== undefined) {
      if (run.refused.has(request.meta.identity)) return { _tag: "deny" }
      if (
        request.capability.action === "fs:write" &&
        [...run.paths].some((path) => same(path, request.capability.resource))
      ) {
        return { _tag: "deny" }
      }
      if (shell !== undefined) {
        let may = false
        for (const path of run.paths) {
          const key = comparing(path)
          const covered = shell.writes?.some((glob) => covers(key(glob), key(path))) === true
          const touched = touches(shell, path)
          if (covered || touched === "names") return { _tag: "deny", path: relative(shell.base, path) || path }
          may ||= touched === "may"
        }
        if (may) return this.asked(run, request, shell)
      }
      if (run.allowed.has(request.meta.identity)) return { _tag: "allow" }
      if (
        !(request.capability.action === "fs:write" && internal(request.capability.resource)) &&
        run.grants.some((pattern) => Capability.matches(pattern, request.capability))
      ) return { _tag: "allow" }
    }
    // Once `a` allows edits nobody sees, a script or test may be one of them.
    const reading = shell?.readOnly === "reads" ||
      (shell?.readOnly === "runs" && run?.grants.some((pattern) => pattern.action === "fs:write") !== true)
    if (
      reading && declared && this.checkable && request.call !== undefined &&
      (run === undefined || (run.trusted && run.paths.size === 0))
    ) {
      this.run(request.meta.source).declared.add(request.call)
      return { _tag: "allow" }
    }
    return shell === undefined ? { _tag: "ask" } : this.asked(this.run(request.meta.source), request, shell)
  }

  private asked(run: Run, request: Pick<Request, "meta">, shell: Command): Decision {
    run.commands.set(request.meta.identity, shell)
    return { _tag: "ask" }
  }

  /**
   * Records an answer. A denial holds from now on, even if the store no
   * longer lists the request; an allowance is recorded by `allowed`, once
   * the store took it.
   */
  denied(request: Pending): void {
    const run = this.run(request.source)
    run.refused.add(request.identity)
    if (request.action === "fs:write") run.paths.add(request.resource)
  }

  allowed(request: Pending, choice: "once" | "run", cwd: string): void {
    const run = this.run(request.source)
    run.allowed.add(request.identity)
    if (choice !== "run" || !request.always) return
    const pattern = request.action === "fs:write"
      ? new Capability.CapabilityPattern({ action: "fs:write", resource: `${real(cwd).replace(/\/+$/, "")}/**` })
      : Option.getOrUndefined(Capability.patternFromCapability(Capability.make(request.action, request.resource)))
    if (pattern !== undefined) run.grants.push(pattern)
  }

  /**
   * A shell call's changes were captured (`Changes.capture`): one that ran
   * unasked on `writes: []` and changed a file, or could not be checked,
   * ends that trust for the run.
   */
  changed(source: string, receipt: Changes.Receipt): void {
    const run = this.runs.get(source)
    if (run === undefined || !run.declared.has(receipt.call)) return
    if (receipt.patches.length > 0) run.trusted = false
    else run.checked.add(receipt.call)
  }

  /** A call settled: one that ran on a declaration with no captured changes could not be checked. */
  settled(source: string, call: string): void {
    const run = this.runs.get(source)
    if (run !== undefined && run.declared.has(call) && !run.checked.has(call)) run.trusted = false
  }
}

/**
 * `Agent.Options.authorize`: waits for every consequential request, in order.
 * `captured` is false where the call's changes are not captured (a box), so
 * no declaration runs unasked there.
 */
export const authorize = (
  grants: GrantStore.Service,
  options: {
    readonly cwd: string
    readonly source: string
    readonly memory?: Memory
    readonly captured?: boolean
  }
) =>
(call: Cell.Call): Effect.Effect<void, HarnessError> =>
  check(grants, requests(call, options.cwd, options.source), options.memory, options.captured)

/** Both worker calls and project launches wait on this same store. */
export const check = (
  grants: GrantStore.Service,
  requests: ReadonlyArray<Request>,
  memory?: Memory,
  captured = true
): Effect.Effect<void, HarnessError> =>
  Effect.forEach(
    requests,
    (request) => {
      const decision = memory?.decide(request, captured) ?? { _tag: "ask" as const }
      if (decision._tag === "allow") return Effect.void
      const asked = decision._tag === "deny"
        ? Effect.fail(
          new Permission.PermissionDenied({ capability: request.capability, reason: "denied earlier in this run" })
        )
        : grants.check(request.capability, { ...request.meta })
      return asked.pipe(
        Effect.mapError((cause) => {
          if (!(cause instanceof Permission.PermissionDenied)) {
            return new HarnessError({ code: "engine_failed", message: "Approval store failed", cause })
          }
          // An answer to another request may have settled this one: say why.
          const why = decision._tag === "deny" ? decision : memory?.decide(request, false)
          return new HarnessError({
            code: "engine_failed",
            message: refusal(request.meta, why?._tag === "deny" ? why.path : undefined),
            cause
          })
        })
      )
    },
    { discard: true }
  )

const order = (requestId: string): number => Number(requestId.slice(requestId.lastIndexOf("-") + 1))

const previewOf = (value: unknown): Preview | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { added, removed, lines } = value as Record<string, unknown>
  return typeof added === "number" && typeof removed === "number" && Array.isArray(lines) &&
      lines.every((line) => typeof line === "string")
    ? { added, removed, lines }
    : undefined
}

/** The store's waiting requests, oldest first. */
export const pending = (list: ReadonlyArray<GrantStore.PendingRequest>): ReadonlyArray<Pending> =>
  [...list].sort((a, b) => order(a.requestId) - order(b.requestId)).map((request) => {
    const preview = previewOf(request.meta.preview)
    return {
      requestId: request.requestId,
      flow: String(request.meta.flow ?? ""),
      subject: String(request.meta.subject ?? ""),
      source: String(request.meta.source ?? "chat"),
      identity: String(request.meta.identity ?? ""),
      ...(preview === undefined ? {} : { preview }),
      action: request.capability.action,
      resource: request.capability.resource,
      tier: request.tier,
      always: request.capability.action === "fs:write"
        ? request.tier === "compensable" && !internal(request.capability.resource)
        : Option.isSome(Capability.patternFromCapability(request.capability))
    }
  })

/**
 * Answers `request` and remembers the answer for its run, then settles every
 * other request of that run the answer now covers, so one `n` or `a` never
 * leaves a second row asking the same thing. The store itself only ever
 * answers once: what lasts is in `memory`. A denial is remembered first and
 * kept; an allowance only once the store took it.
 */
export const reply = (
  grants: GrantStore.Service,
  memory: Memory,
  request: Pending,
  choice: Choice,
  cwd: string
): Effect.Effect<void, Permission.GrantStoreError> =>
  Effect.gen(function*() {
    if (choice === "deny") memory.denied(request)
    yield* grants.reply(request.requestId, choice === "deny" ? "deny" : "once")
    if (choice !== "deny") memory.allowed(request, choice, cwd)
    for (const other of pending(yield* grants.list)) {
      if (other.source !== request.source) continue
      const decision = memory.decide({ capability: Capability.make(other.action, other.resource), meta: other })
      if (decision._tag !== "ask") {
        yield* Effect.ignore(grants.reply(other.requestId, decision._tag === "allow" ? "once" : "deny"))
      }
    }
  })

/** `reply`, settled: the store's error code when it refused the answer, else `undefined`. */
export const answer = (
  grants: GrantStore.Service,
  memory: Memory,
  request: Pending,
  choice: Choice,
  cwd: string
): Effect.Effect<Permission.GrantStoreError["code"] | undefined> =>
  reply(grants, memory, request, choice, cwd).pipe(
    Effect.match({ onFailure: (error) => error.code, onSuccess: () => undefined })
  )

/** One key a row offers. */
export interface Offer {
  readonly id: "allow" | "deny" | "allow-all"
  readonly key: "y" | "n" | "a"
  readonly label: string
}

/**
 * The keys the front row offers, as the row and the footer both show them.
 * `all` is false while the focused panel owns `a`.
 */
export const choices = (request: Pick<Pending, "action" | "flow" | "always">, all = true): ReadonlyArray<Offer> => {
  const edits = request.action === "fs:write"
  return [
    { id: "allow", key: "y", label: "Allow once" },
    { id: "deny", key: "n", label: edits ? "Deny change" : "Deny" },
    ...(request.always && all
      ? [{
        id: "allow-all" as const,
        key: "a" as const,
        label: `Allow ${edits ? "edits" : request.flow === "bash" ? "commands" : request.flow} this run`
      }]
      : [])
  ]
}

/**
 * How long a row is on screen before y, n or a answers it. Rows arrive on a
 * poll, so without this a person typing "add tests" as one appeared would
 * grant the session with the `a`.
 */
export const armMs = 400

/** How often the UI reads the store while work runs; well under `armMs`, far above the 100 ms clock. */
export const pollMs = 250

/**
 * Calls `read` now and every `ms` until stopped, never while the last call is
 * still in flight: a slow store is not asked again before it answers.
 */
export const poll = (read: () => Promise<unknown>, ms = pollMs): () => void => {
  let busy = false
  const tick = () => {
    if (busy) return
    busy = true
    read().then(() => {
      busy = false
    }, () => {
      busy = false
    })
  }
  tick()
  const timer = setInterval(tick, ms)
  return () => clearInterval(timer)
}

/**
 * Whether the front row takes keys yet.
 *
 * `requestId` is the row whose delay runs since `since`. `waiting` is the
 * request last answered while the store still lists it: nothing arms until a
 * poll shows it gone, so a double-tapped `y` never answers the next row.
 */
export interface Arming {
  readonly requestId: string | undefined
  readonly since: number
  readonly waiting: string | undefined
}

export const idle: Arming = { requestId: undefined, since: 0, waiting: undefined }

/**
 * After each poll. `listed` is everything the store holds; `skip` is what the
 * UI already answered and so does not show. The front row's delay starts the
 * first poll it is shown on.
 */
export const shown = (
  arming: Arming,
  listed: ReadonlyArray<Pending>,
  now: number,
  skip: ReadonlySet<string> = new Set()
): Arming => {
  if (arming.waiting !== undefined && listed.some((request) => request.requestId === arming.waiting)) return arming
  const front = listed.find((request) => !skip.has(request.requestId))?.requestId
  if (front === undefined) return idle
  if (front === arming.requestId && arming.waiting === undefined) return arming
  return { requestId: front, since: now, waiting: undefined }
}

/**
 * The editor changed: sending, clearing or typing restarts the front row's
 * delay, so the first letters of the next message are never an answer.
 */
export const edited = (arming: Arming, now: number): Arming =>
  arming.requestId === undefined || arming.waiting !== undefined ? arming : { ...arming, since: now }

/** A key answered `requestId`; the next row waits for a poll without it. */
export const answered = (requestId: string): Arming => ({ requestId: undefined, since: 0, waiting: requestId })

/** The store refused the answer to `requestId`; its row shows and arms again. */
export const failed = (arming: Arming, requestId: string): Arming => arming.waiting === requestId ? idle : arming

export const armed = (arming: Arming, front: string | undefined, now: number): boolean =>
  front !== undefined && arming.waiting === undefined && arming.requestId === front && now - arming.since >= armMs

/** Whether the front row shows its keys: exactly when `key` would take one. */
export const ready = (arming: Arming, front: string | undefined, now: number, draft: string): boolean =>
  draft === "" && armed(arming, front, now)

/** The answer a key gives, or `undefined` so the key reaches the editor. */
export const key = (
  name: string,
  state: {
    readonly draft: string
    readonly shift: boolean
    readonly ctrl: boolean
    readonly meta: boolean
    /** See `armed`. */
    readonly armed: boolean
    readonly pending: ReadonlyArray<Pending>
    /** Keys the focused panel acts on; they reach the panel, never an approval. */
    readonly reserved?: ReadonlyArray<string>
  }
): Choice | undefined => {
  const first = state.pending[0]
  if (first === undefined || !state.armed || state.draft !== "" || state.shift || state.ctrl || state.meta) {
    return undefined
  }
  if (state.reserved?.includes(name) === true) return undefined
  if (name === "y") return "once"
  if (name === "n") return "deny"
  if (name === "a" && first.always) return "run"
  return undefined
}
