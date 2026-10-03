#!/usr/bin/env node
/**
 * Fails when the repository tracks or references something that should not
 * exist. Three rules, one pass over the tracked file list:
 *
 *   dangling   A repo-relative path that PACKAGE.ts names in a `workflows:` or
 *              `paths:` array, a `Smithers.file("//...")` source, or a
 *              `.github/workflows/*.yml` argument of an actionlint step must
 *              match a tracked file. A deleted workflow file left in the
 *              actionlint list killed a CI job before it tested anything.
 *   forbidden  A tracked path with a `node_modules` segment (file or
 *              symlink), a bundler temp file `.smithers-<hex>-*.ts`, or any
 *              file the root .gitignore excludes.
 *   scaffold   Lane scaffolding in tracked source: `smithers-mvp-`,
 *              `go-build-<word>`, `/private/tmp/claude-`, `scratchpad/lanes`.
 *              `.specs/`, docs (a `docs` path segment, `.md`/`.mdx`) and this
 *              check's own files are exempt.
 *
 * File list: `--files-from-stdin` reads NUL-separated paths (CI pipes
 * `git ls-files -z`); otherwise Git's index or jj's recorded tree is read.
 * `--include-untracked` includes nonignored landing candidates (jj snapshots
 * its working copy); listing errors in a repository fail closed. With no
 * repository (the scratch copy `smthrs lint` runs in) it walks the directory
 * and skips what the root .gitignore excludes.
 * `--projected-tree` also omits the ignored root node_modules symlink that
 * Shell.Diff injects into its VCS-free scratch copy: an absolute link to an
 * existing node_modules directory. Tracked files and nested dependency
 * symlinks receive the ordinary checks.
 *
 * Usage: node scripts/check-tracked-hygiene.mjs [--files-from-stdin] [--include-untracked] [--projected-tree] [root]
 * Exits 0 when clean, 1 on a finding, 2 when the check itself failed.
 */
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, statSync } from "node:fs"
import { basename, dirname, isAbsolute, join, posix } from "node:path"
import { fileURLToPath } from "node:url"

// ---------------------------------------------------------------- gitignore

/** Compile one .gitignore line to `{ negate, dirOnly, regex }`, or null for a blank or comment. */
export const compileIgnore = (rawLine) => {
  let line = rawLine.replace(/\r$/, "").replace(/(?<!\\)\s+$/, "")
  if (line === "" || line.startsWith("#")) return null
  let negate = false
  if (line.startsWith("!")) {
    negate = true
    line = line.slice(1)
  }
  if (line.startsWith("\\")) line = line.slice(1)
  let dirOnly = false
  if (line.endsWith("/")) {
    dirOnly = true
    line = line.slice(0, -1)
  }
  const anchored = line.includes("/")
  if (line.startsWith("/")) line = line.slice(1)
  let source = ""
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "*") {
      if (line[i + 1] === "*") {
        const leading = i === 0 || line[i - 1] === "/"
        if (leading && line[i + 2] === "/") {
          source += "(?:.*/)?"
          i += 2
        } else if (leading && i + 2 === line.length) {
          source += ".*"
          i += 1
        } else {
          source += "[^/]*"
          i += 1
        }
      } else source += "[^/]*"
    } else if (ch === "?") source += "[^/]"
    else if (ch === "[") {
      const end = line.indexOf("]", i + 2)
      if (end === -1) source += "\\["
      else {
        source += `[${line.slice(i + 1, end).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`
        i = end
      }
    } else source += ch.replace(/[.+^${}()|\\]/g, "\\$&")
  }
  return { negate, dirOnly, regex: new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`) }
}

/** Whether `path` (a repo-relative file, or a directory when `isDir`) is excluded by `rules`. */
const matchesRules = (rules, path, isDir) => {
  let ignored = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    if (rule.regex.test(path)) ignored = !rule.negate
  }
  return ignored
}

/** Whether git would ignore `path`: it or any parent directory is excluded. */
export const isIgnored = (rules, path) => {
  const parts = path.split("/")
  for (let i = 1; i < parts.length; i++) if (matchesRules(rules, parts.slice(0, i).join("/"), true)) return true
  return matchesRules(rules, path, false)
}

export const parseIgnore = (text) => text.split("\n").map(compileIgnore).filter((rule) => rule !== null)

// -------------------------------------------------------------- file lists

/** The files under `root` that the root .gitignore does not exclude, as git ls-files would list them. Symlinks count as files. */
export const walkFiles = (root, rules, { projectedTree = false } = {}) => {
  const out = []
  const visit = (relative) => {
    for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
      const path = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (path === ".git" || path === ".jj") continue
      if (projectedTree && path === "node_modules" && entry.isSymbolicLink() && matchesRules(rules, path, true)) {
        const target = readlinkSync(join(root, path))
        if (isAbsolute(target) && basename(target) === "node_modules") {
          try {
            if (statSync(target).isDirectory()) continue
          } catch (error) {
            if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error
          }
        }
      }
      if (entry.isDirectory()) {
        if (!matchesRules(rules, path, true)) visit(path)
      } else if (!matchesRules(rules, path, false)) out.push(path)
    }
  }
  visit("")
  return out.sort()
}

const readIgnore = (root) => {
  try {
    return parseIgnore(readFileSync(join(root, ".gitignore"), "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return []
    throw error
  }
}

/** Tracked files, optionally including nonignored landing candidates. VCS errors fail closed. */
export const listFiles = (root, { includeUntracked = false, projectedTree = false } = {}) => {
  let command
  let args
  if (existsSync(join(root, ".git"))) {
    command = "git"
    args = ["ls-files", "--cached", ...(includeUntracked ? ["--others", "--exclude-standard"] : []), "-z"]
  } else if (existsSync(join(root, ".jj"))) {
    command = "jj"
    args = [...(includeUntracked ? [] : ["--ignore-working-copy"]), "file", "list", "-T", 'path ++ "\\0"']
  } else return walkFiles(root, readIgnore(root), { projectedTree })
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${command} file listing failed: ${result.error?.message ?? result.stderr.trim()}`)
  }
  return [...new Set(result.stdout.split("\0").filter((p) => p !== ""))].filter((path) => {
    if (!includeUntracked) return true
    try {
      lstatSync(join(root, path))
      return true
    } catch (error) {
      if (error.code === "ENOENT") return false
      throw error
    }
  }).sort()
}

// ------------------------------------------------------------------ rules

const globRegex = (glob) => {
  let source = ""
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === "*" && glob[i + 1] === "*") {
      source += ".*"
      i += glob[i + 2] === "/" ? 2 : 1
    } else if (ch === "*") source += "[^/]*"
    else if (ch === "?") source += "[^/]"
    else if (ch === "{") {
      const end = glob.indexOf("}", i)
      if (end === -1) source += "\\{"
      else {
        source += `(?:${glob.slice(i + 1, end).split(",").map((alt) => alt.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")).join("|")})`
        i = end
      }
    } else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&")
  }
  return new RegExp(`^${source}$`)
}

/** Whether a repo-relative path names a tracked file, a tracked directory, or (as a glob) at least one tracked file. */
const resolves = (fileSet, files, path) => {
  const clean = posix.normalize(path).replace(/\/$/, "")
  if (/[*?{]/.test(clean)) {
    const regex = globRegex(clean)
    return files.some((file) => regex.test(file) || regex.test(dirname(file)))
  }
  if (fileSet.has(clean)) return true
  return files.some((file) => file.startsWith(`${clean}/`))
}

const strings = (source) => [...source.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'/g)].map((m) => m[1] ?? m[2])

const lineOf = (text, index) => text.slice(0, index).split("\n").length

/**
 * The repo-relative path references one PACKAGE.ts holds, as `{ path, line, field }`.
 * `workflows`/`paths` arrays resolve against the package directory, then the
 * repository root; `Smithers.file("//x")` resolves against the root.
 */
export const packageReferences = (text) => {
  const found = []
  for (const m of text.matchAll(/\b(workflows|paths)\s*:\s*\[([^\]]*)\]/g)) {
    for (const path of strings(m[2])) found.push({ path, line: lineOf(text, m.index), field: m[1], rootOnly: false })
  }
  for (const m of text.matchAll(/Smithers\.(?:file|glob)\(\s*"\/\/([^"]+)"/g)) {
    found.push({ path: m[1], line: lineOf(text, m.index), field: "Smithers.file", rootOnly: true })
  }
  return found
}

/** The `.yml`/`.yaml` paths a workflow's actionlint `args:` names. */
export const actionlintArguments = (text) => {
  const found = []
  const lines = text.split("\n")
  lines.forEach((line, index) => {
    if (!/actionlint/.test(line)) return
    for (const next of lines.slice(index + 1, index + 6)) {
      const args = /^\s*"?args"?\s*:\s*(.*)$/.exec(next)
      if (args === null) continue
      for (const token of args[1].replace(/^["']|["']\s*$/g, "").split(/\s+/)) {
        if (/\.ya?ml$/.test(token)) found.push({ path: token, line: index + 1 + lines.slice(index + 1).indexOf(next) + 1 })
      }
      break
    }
  })
  return found
}

/**
 * `dangling` findings for a file list read through `read(path)`.
 * Every `PACKAGE.ts` and `.github/workflows/*.yml` in the list is scanned.
 */
export const danglingFindings = (files, read) => {
  const fileSet = new Set(files)
  const found = []
  for (const file of files) {
    const base = posix.basename(file)
    if (base === "PACKAGE.ts" && !fixturePackage.test(file)) {
      const text = read(file)
      const packageDir = dirname(file)
      for (const { path, line, field, rootOnly } of packageReferences(text)) {
        const local = packageDir === "." ? path : posix.join(packageDir, path)
        if (resolves(fileSet, files, path) || (!rootOnly && resolves(fileSet, files, local))) continue
        found.push({ path: file, line, rule: "dangling", message: `${field} names "${path}", which no tracked file matches` })
      }
    } else if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file)) {
      for (const { path, line } of actionlintArguments(read(file))) {
        if (!resolves(fileSet, files, path)) {
          found.push({ path: file, line, rule: "dangling", message: `actionlint is passed "${path}", which no tracked file matches` })
        }
      }
    }
  }
  return found
}

// A PACKAGE.ts under a test fixture models someone else's package; its paths describe the fixture.
const fixturePackage = /(?:^|\/)(?:test|tests|__tests__)\/fixtures?\//

const tempFile = /^\.smithers-[0-9a-f]{8,}-.*\.ts$/

/** `forbidden` findings: node_modules paths, bundler temp files, tracked-but-gitignored files. */
export const forbiddenFindings = (files, rules) => {
  const found = []
  for (const file of files) {
    const parts = file.split("/")
    if (parts.includes("node_modules")) {
      found.push({ path: file, line: 0, rule: "forbidden", message: "tracked path has a node_modules segment (file or symlink); delete it" })
    } else if (tempFile.test(parts[parts.length - 1])) {
      found.push({ path: file, line: 0, rule: "forbidden", message: "tracked bundler temp file (.smithers-<hex>-*.ts); delete it" })
    } else if (isIgnored(rules, file)) {
      found.push({ path: file, line: 0, rule: "forbidden", message: "tracked file that .gitignore excludes (build output or local state); untrack it" })
    }
  }
  return found
}

/** The scaffolding strings, each with the reason it is wrong in product code. */
export const scaffoldPatterns = [
  // `smithers-mvp-web` (the deployed worker) and `smithers-mvp-quarantine.*`
  // (browser storage keys) are product identities, so only a local filesystem
  // path through a lane directory counts.
  { regex: /(?:~|\$HOME|\$\{HOME\}|\/Users\/[^/\s"']+|\/home\/[^/\s"']+|\/private\/tmp|\/tmp)\/(?:[^\s"']*\/)?smithers-mvp-/, what: "smithers-mvp- (lane worktree path)" },
  { regex: /go-build-[A-Za-z0-9_]+/, what: "go-build-<word> (lane-private Go cache)" },
  { regex: /\/private\/tmp\/claude-/, what: "/private/tmp/claude- (agent session path)" },
  { regex: /scratchpad\/lanes/, what: "scratchpad/lanes (agent scratch path)" }
]

// The check's own files name the strings on purpose.
const selfFiles = new Set(["scripts/check-tracked-hygiene.mjs", "scripts/check-tracked-hygiene.test.mjs"])

/** Whether a tracked path is exempt from the scaffold rule: .specs/, docs, and the check itself. */
export const scaffoldExempt = (file) =>
  selfFiles.has(file) || file.startsWith(".specs/") || file.split("/").includes("docs") || /\.mdx?$/.test(file)

/**
 * Narrow allowlist of `path` -> patterns it may contain. Each entry says why.
 * (Empty: every hit on the tree at the time of writing was a finding.)
 */
export const scaffoldAllowlist = new Map()

/** `scaffold` findings; `read(path)` returns text, or null for nonfiles, binary or oversized files. Read failures propagate. */
export const scaffoldFindings = (files, read) => {
  const found = []
  for (const file of files) {
    if (scaffoldExempt(file)) continue
    const text = read(file)
    if (text === null) continue
    const allowed = scaffoldAllowlist.get(file) ?? []
    text.split("\n").forEach((line, index) => {
      for (const { regex, what } of scaffoldPatterns) {
        if (regex.test(line) && !allowed.includes(what)) {
          found.push({ path: file, line: index + 1, rule: "scaffold", message: `lane scaffolding ${what}: ${line.trim().slice(0, 120)}` })
        }
      }
    })
  }
  return found
}

/** All findings for `files` under `root`. */
export const findings = (files, root) => {
  const read = (file) => readFileSync(join(root, file), "utf8")
  const readSource = (file) => {
    if (!lstatSync(join(root, file)).isFile()) return null
    const buffer = readFileSync(join(root, file))
    if (buffer.length > 4 * 1024 * 1024 || buffer.subarray(0, 8192).includes(0)) return null
    return buffer.toString("utf8")
  }
  return [
    ...danglingFindings(files, read),
    ...forbiddenFindings(files, readIgnore(root)),
    ...scaffoldFindings(files, readSource)
  ]
}

export const formatFinding = ({ path, line, rule, message }) => `${path}${line > 0 ? `:${line}` : ""}: ${rule}: ${message}`

const readStdin = () => readFileSync(0).toString("utf8").split("\0").filter((p) => p !== "")

const main = () => {
  const args = process.argv.slice(2)
  const fromStdin = args.includes("--files-from-stdin")
  const includeUntracked = args.includes("--include-untracked")
  const projectedTree = args.includes("--projected-tree")
  const root = args.find((a) => !a.startsWith("--")) ?? fileURLToPath(new URL("../", import.meta.url))
  let found
  try {
    found = findings(fromStdin ? readStdin() : listFiles(root, { includeUntracked, projectedTree }), root)
  } catch (error) {
    console.error(`tracked hygiene: ${error.message}`)
    return 2
  }
  if (found.length === 0) {
    console.log("tracked hygiene: no dangling references, forbidden files or lane scaffolding")
    return 0
  }
  for (const finding of found) console.error(formatFinding(finding))
  console.error(`tracked hygiene: ${found.length} finding(s); fix them, do not weaken the rule`)
  return 1
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main()
