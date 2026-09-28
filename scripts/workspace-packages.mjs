/**
 * The one reading of workspace membership every gate and release script shares.
 *
 * A package's directory is not its identity. `@smthrs/canonical` publishes that
 * name from `packages/smithers/flows/canonical`, nested inside the product package it
 * belongs to so the relationship is visible in the tree, and publishes exactly
 * what it published from a top-level directory. Every script that used to answer
 * "what are the workspace's packages?" with `readdirSync("packages")` answered
 * it one directory deep, and each one would have to learn about nesting
 * separately. They read this module instead, so nesting is decided once.
 *
 * Membership comes from `pnpm-workspace.yaml`, which is what pnpm itself
 * installs from, rather than from the filesystem shape. A directory that is not
 * a declared member is not a package here even if it holds a `package.json`
 * (a scaffolding template, a generated `dist/cjs/package.json`), and a declared
 * member is a package wherever it lives.
 */
import { readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { createRequire } from "node:module"

/** The repository root, resolved from this file rather than `process.cwd()`. */
export const repoRoot = resolve(import.meta.dirname, "..")

/**
 * Whether the module that owns `meta` is the process entry point.
 *
 * Both sides are real paths, so a symlinked, relative, or space-containing
 * invocation still matches. Comparing a percent-encoded URL against the raw
 * `argv[1]` does not, and the script then exits 0 without running.
 */
export const isMain = (meta) => {
  if (process.argv[1] === undefined) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(meta.filename)
  } catch {
    return false
  }
}

/**
 * The membership globs `pnpm-workspace.yaml` declares, in file order.
 *
 * The parser is deliberately small: a `packages:` heading, then one `- pattern`
 * item per line, quoted or bare, until the indentation returns. Comment and
 * blank lines inside the block are skipped, so the rationale for the shape of
 * this list can live beside it.
 */
export const readWorkspacePatterns = (path = join(repoRoot, "pnpm-workspace.yaml")) => {
  const lines = readFileSync(path, "utf8").split(/\r?\n/)
  const heading = lines.findIndex((line) => /^\s*packages\s*:\s*(?:#.*)?$/.test(line))
  if (heading < 0) throw new Error(`${path} has no packages list`)
  const indentation = lines[heading].match(/^\s*/)[0].length
  const patterns = []
  for (const line of lines.slice(heading + 1)) {
    if (/^\s*(?:#.*)?$/.test(line)) continue
    const currentIndentation = line.match(/^\s*/)[0].length
    if (currentIndentation <= indentation) break
    const item = line.match(/^\s*-\s*(?:"([^"]+)"|'([^']+)'|([^#\s]+))\s*(?:#.*)?$/)
    if (item === null) throw new Error(`unsupported packages entry in ${path}: ${line.trim()}`)
    patterns.push(item[1] ?? item[2] ?? item[3])
  }
  if (patterns.length === 0) throw new Error(`${path} has an empty packages list`)
  return patterns
}

/**
 * Every workspace member, as `{ dir, name, manifestPath, manifest }`.
 *
 * `dir` is the member's repository-relative posix directory — `packages/smithers/flows/flow`,
 * `packages/smithers/flows/canonical`, `apps/app` — and it is the key every caller should
 * use to reach the package on disk. `name` is the npm name, which is what the
 * registry, the lockfiles, and every dependency edge speak.
 *
 * The result is sorted by `dir` and deduplicated: overlapping globs (a nested
 * member also matched by a wider pattern) name one package once.
 */
export const workspacePackages = (root = repoRoot) => {
  // Keep root/entry-point utilities usable before dependencies are installed.
  // Membership uses the same pinned matcher as pnpm, including its negations.
  const { globSync } = createRequire(import.meta.url)("tinyglobby")
  const patterns = readWorkspacePatterns(join(root, "pnpm-workspace.yaml"))
    .map((pattern) => `${pattern.replace(/\/$/, "")}/package.json`)
  const found = new Map()
  for (const manifestPath of globSync(patterns, {
    cwd: root,
    expandDirectories: false,
    ignore: ["**/node_modules/**", "**/bower_components/**"]
  })) {
    const relativePath = manifestPath.split(/[\\/]/).join("/")
    if (found.has(relativePath)) continue
    const manifest = JSON.parse(readFileSync(join(root, relativePath), "utf8"))
    found.set(relativePath, {
      dir: dirname(relativePath),
      name: manifest.name,
      manifestPath: join(root, relativePath),
      manifest
    })
  }
  return [...found.values()].sort((left, right) => left.dir < right.dir ? -1 : left.dir > right.dir ? 1 : 0)
}

/**
 * The members that live under `packages/`, at any depth.
 *
 * This is the publication and package-contract universe: `apps/*`, `examples`,
 * and `evals/*` are workspace members so their own suites run under the root
 * fan-out, and none of them is a library this repository publishes.
 */
export const libraryPackages = (root = repoRoot) =>
  workspacePackages(root).filter((entry) => entry.dir.startsWith("packages/"))

/**
 * The stable sort key for one member: its directory's last segment.
 *
 * Release order is a property of the packages, not of where their directories
 * sit, so moving a package into its product's directory must not reorder the
 * publish. Basenames are unique across the workspace and {@link workspacePackages}
 * would have collapsed a collision into one entry, so this is a total order.
 */
export const packageKey = (entry) => entry.dir.slice(entry.dir.lastIndexOf("/") + 1)

/**
 * Prints one member directory per line, for a shell that has to walk them.
 *
 * `--library-dirs` narrows to the members under `packages/`, which is what the
 * release workflow group-checks. A shell glob cannot do this job: a built
 * package writes a generated `dist/cjs/package.json`, so a three-deep glob
 * would hand the loop a build artifact and fail on its missing group.
 */
if (isMain(import.meta)) {
  const dirs = process.argv.includes("--library-dirs") ? libraryPackages() : workspacePackages()
  console.log(dirs.map((entry) => entry.dir).join("\n"))
}
