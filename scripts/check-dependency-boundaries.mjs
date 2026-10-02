#!/usr/bin/env node
/**
 * Every import a workspace source makes must be declared by that workspace.
 *
 * pnpm links the whole workspace under one `node_modules`, so a package can
 * import a sibling it never declared and still resolve locally. A consumer who
 * installs the published tarball gets a module-not-found error instead. This
 * This gate prevents package imports through unpublished workspace-relative
 * paths: a bare specifier must name a declared dependency, and a relative
 * specifier must not resolve into another workspace package's `src/`, which
 * a tarball consumer can only reach through that package's export map.
 *
 * Test files, config files, and anything under a `scripts/` directory may use
 * `devDependencies`; everything else may use only runtime, peer, and optional
 * dependencies, or validated private adapters vendored into the distribution.
 *
 * Run it with `pnpm exec smithers-build test '//scripts:dependencyBoundaries'`, or
 * directly with `node scripts/check-dependency-boundaries.mjs`.
 */
import { builtinModules } from "node:module"
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs"
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path"

import ts from "typescript"
import { workspacePackages, isMain, repoRoot } from "./workspace-packages.mjs"
import { privateEffectAdapters } from "../packages/repo-targets/scripts/private-effect-adapters.mjs"

// Resolved from this file, not from `process.cwd()`: the build system runs a
// target from the directory that owns it, and this gate is about the whole
// workspace.
// Membership comes from `pnpm-workspace.yaml` through the shared reader, so a
// package nested inside the product package it belongs to
// (`packages/smithers/flows/canonical`) is checked like any other. This gate scans
// `packages/` and `apps/`; the remaining members (`examples`,
// `packages/smithers/build/infra` is one of them and needs no separate row now the
// reader finds it) are named, and `evals/*` stays out.
const scannedRoots = ["packages/", "apps/"]
const directWorkspaceDirs = ["examples"]
const sourceExtensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"])
const ignoredDirs = new Set([
  ".alchemy",
  ".flows",
  ".git",
  ".jj",
  ".claude",
  ".smithers",
  ".turbo",
  ".worktrees",
  "worktrees",
  "coverage",
  "dist",
  "eval-runs",
  "node_modules",
  "target",
  "tmp",
])
const builtinPackages = new Set(["bun", ...builtinModules, ...builtinModules.map((mod) => `node:${mod}`)])
// Reach-throughs that predate the rule, as `file -> specifier`. Each is a
// debt: the target is either an `internal/*` module its package deliberately
// does not export, or an app source no export map covers. Remove the entry
// when the import moves to a package name; the gate fails on a stale entry so
// the list only shrinks.
const knownReachThroughs = new Set([
  "PACKAGE.ts -> ./apps/site/src/data/project.json",
  "apps/site/src/AppIsland.tsx -> ../../app/src/mainview/AppIsland",
  "apps/site/src/components/repoStats.ts -> ../../../server/src/publicRepoCatalog",
  "apps/app/src/mainview/cards/EngineTrace.test.ts -> ../../../../../packages/smithers/flows/engine-store/src/internal/JournalRecords.ts",
  "apps/app/src/mainview/cards/fixtures/CodingJournal.ts -> ../../../../../../packages/smithers/flows/engine-store/src/internal/JournalRecords.ts",
  "packages/smithers/build/infra/worker/test/action-cache.test.ts -> ../../../../flows/step-cache/src/CacheStore.ts",
])

/** @typedef {{ dir: string; name: string; manifestPath: string; manifest: Record<string, unknown> }} WorkspacePackage */

/** @param {string} path */
function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"))
}

/** @param {string} path */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** @param {string} dir */
function readPackage(dir) {
  const manifestPath = join(repoRoot, dir, "package.json")
  if (!existsSync(manifestPath)) return null
  const manifest = readJson(manifestPath)
  if (!manifest?.name || typeof manifest.name !== "string") return null
  return { dir, name: manifest.name, manifestPath, manifest }
}

/** @returns {WorkspacePackage[]} */
function findWorkspacePackages() {
  /** @type {WorkspacePackage[]} */
  const packages = []
  for (const member of workspacePackages(repoRoot)) {
    if (!scannedRoots.some((root) => member.dir.startsWith(root))) continue
    const pkg = readPackage(member.dir.split("/").join(sep))
    if (pkg) packages.push(pkg)
  }
  for (const dir of directWorkspaceDirs) {
    const pkg = readPackage(dir)
    if (pkg) packages.push(pkg)
  }
  const rootPackage = readPackage(".")
  if (rootPackage) packages.push(rootPackage)
  return packages.sort((a, b) => a.dir.localeCompare(b.dir))
}

/** @param {string} dir @param {string[]} out @param {string[]} [nestedPackageDirs] */
export function collectSourceFiles(dir, out, nestedPackageDirs) {
  const absDir = join(repoRoot, dir)
  if (!isDirectory(absDir)) return
  for (const entry of readdirSync(absDir)) {
    if (ignoredDirs.has(entry)) continue
    const child = join(dir, entry)
    const absChild = join(repoRoot, child)
    // Skip symlinks before stat-following can recurse through workspace cycles
    // or crash on dangling local artifacts left by workflow runs.
    let stats
    try {
      stats = lstatSync(absChild)
    } catch {
      continue
    }
    if (stats.isSymbolicLink()) continue
    if (stats.isDirectory()) {
      // A nested package.json with a name marks a standalone package (a
      // template, fixture, or shipped plugin). Its files are checked against
      // its own manifest, not the enclosing workspace's.
      if (nestedPackageDirs && readPackage(child)) {
        nestedPackageDirs.push(child)
        continue
      }
      collectSourceFiles(child, out, nestedPackageDirs)
      continue
    }
    if (!stats.isFile()) continue
    // Build-graph declarations belong to the root workspace, not the package
    // they sit in: the build CLI loads them from the repository root against
    // the root install. `collectGraphFiles` gives them to the root package.
    if (entry === "legacy declaration" || entry === "PACKAGE.ts") continue
    if (sourceExtensions.has(extname(entry))) out.push(child)
  }
}

/**
 * Collects every build-graph declaration in the tree, so the root workspace
 * checks them against the root manifest.
 *
 * The build CLI loads every `legacy declaration` from the repository root against the
 * root install, which is why `apps/server/legacy declaration` may import
 * `@smthrs/targets` without `apps/server` declaring it. Declarations inside a
 * scaffolding template describe the app the template generates, not this
 * repository, so a directory holding a manifest that is not a workspace member
 * is not descended into.
 *
 * @param {string} dir Repo-relative POSIX path, or "" for the repository root.
 * @param {Set<string>} memberDirs Repo-relative directories of workspace members.
 * @param {string[]} out
 */
export function collectGraphFiles(dir, memberDirs, out) {
  const absDir = join(repoRoot, dir === "" ? "." : dir)
  if (!isDirectory(absDir)) return
  for (const entry of readdirSync(absDir)) {
    if (ignoredDirs.has(entry)) continue
    const child = dir === "" ? entry : join(dir, entry)
    const absChild = join(repoRoot, child)
    let stats
    try {
      stats = lstatSync(absChild)
    } catch {
      continue
    }
    if (stats.isSymbolicLink()) continue
    if (stats.isDirectory()) {
      const foreignProject = existsSync(join(absChild, "package.json")) &&
        !memberDirs.has(child) &&
        ![...memberDirs].some((member) => member.startsWith(`${child}${sep}`))
      if (foreignProject) continue
      collectGraphFiles(child, memberDirs, out)
      continue
    }
    if (entry === "legacy declaration" || entry === "PACKAGE.ts") out.push(child)
  }
}

/** @param {WorkspacePackage} pkg @param {Set<string>} [memberDirs] @returns {{ files: string[]; nestedPackageDirs: string[] }} */
function filesForPackage(pkg, memberDirs = new Set()) {
  /** @type {string[]} */
  const files = []
  /** @type {string[]} */
  const nestedPackageDirs = []
  if (pkg.dir === ".") {
    // The root workspace's own sources live under scripts/ and factory/ (the
    // dogfood harness has no manifest and runs against the root install),
    // and it owns every build-graph declaration in the tree.
    collectSourceFiles("scripts", files, nestedPackageDirs)
    collectSourceFiles("factory", files, nestedPackageDirs)
    collectGraphFiles("", memberDirs, files)
  } else if (isDirectory(join(repoRoot, pkg.dir, "src"))) {
    collectSourceFiles(join(pkg.dir, "src"), files, nestedPackageDirs)
  } else {
    // Some workspaces have no src/ and keep their sources at the package root.
    // Scan the whole package dir; the recursive collector already skips
    // node_modules, dist, and coverage.
    collectSourceFiles(pkg.dir, files, nestedPackageDirs)
  }
  return { files: files.sort(), nestedPackageDirs: nestedPackageDirs.sort() }
}

/** @param {string} specifier */
function packageNameForSpecifier(specifier) {
  if (
    !specifier ||
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("~/") ||
    specifier.startsWith("node:") ||
    specifier.startsWith("astro:") ||
    specifier.startsWith("bun:")
  ) {
    return null
  }
  if (builtinPackages.has(specifier)) return null
  const parts = specifier.split("/")
  if (specifier.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier
  }
  return parts[0] ?? null
}

/**
 * The workspace package whose `src/` a relative specifier resolves into, or
 * null when it stays outside every package source tree.
 *
 * `../../packages/smithers/flows/plan/src/Plan.ts` from `scripts/bench/corpus.mjs`
 * names `packages/smithers/flows/plan`; `../plan/PACKAGE.ts` from a sibling
 * build-graph declaration names nothing, because declarations are root-owned
 * and sit outside `src/`. The caller decides whether the importing package is
 * the same one; only a different owner is a reach-through.
 *
 * @param {string} file Repo-relative path of the importing file.
 * @param {string} specifier
 * @param {Iterable<string>} packageDirs Repo-relative workspace package directories.
 * @returns {string | null}
 */
export function packageSourceReachedBy(file, specifier, packageDirs) {
  if (!specifier.startsWith(".")) return null
  const target = relative(repoRoot, resolve(repoRoot, dirname(file), specifier))
  if (target.startsWith("..")) return null
  let owner = null
  for (const dir of packageDirs) {
    if (target.startsWith(`${dir}${sep}src${sep}`) && (owner === null || dir.length > owner.length)) owner = dir
  }
  return owner
}

/** @param {string} path */
function scriptKindForPath(path) {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return ts.ScriptKind.TSX
  if (path.endsWith(".ts")) return ts.ScriptKind.TS
  return ts.ScriptKind.JS
}

/**
 * Replaces every character inside any of `ranges` with a space, in one pass.
 *
 * Ranges may nest or overlap: a template expression's range contains the
 * ranges of the literals in its substitutions. Walking them by start and
 * clamping each to the cursor blanks their union once and keeps the length.
 * The cost stays at the file's size rather than literals times size, which a
 * reduce that rebuilt the whole string per literal paid (135 MB of copies for
 * one 109 KB source).
 *
 * @param {string} text
 * @param {readonly (readonly [number, number])[]} ranges
 */
export function blankLiteralRanges(text, ranges) {
  /** @type {string[]} */
  const parts = []
  let cursor = 0
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (end <= cursor) continue
    const from = Math.max(start, cursor)
    parts.push(text.slice(cursor, from), " ".repeat(end - from))
    cursor = end
  }
  parts.push(text.slice(cursor))
  return parts.join("")
}

/** @param {string} file */
function importSpecifiersForFile(file) {
  const absFile = join(repoRoot, file)
  const text = readFileSync(absFile, "utf8")
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindForPath(file))
  /** @type {Set<string>} */
  const specifiers = new Set()
  /** Character ranges of string/template literals, so the regex sweep below skips their contents. @type {[number, number][]} */
  const literalRanges = []

  /** @param {ts.Node} node */
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteral(node)) {
      literalRanges.push([node.getStart(sourceFile), node.getEnd()])
    }
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.add(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      specifiers.add(node.moduleReference.expression.text)
    } else if (ts.isCallExpression(node)) {
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        specifiers.add(node.arguments[0].text)
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        node.arguments.length === 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        specifiers.add(node.arguments[0].text)
      }
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteralLike(node.argument.literal)
    ) {
      specifiers.add(node.argument.literal.text)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)

  // Belt-and-braces sweep for dynamic imports the AST walk can miss, run over a
  // copy with string and template literals blanked out. Without that, a dynamic
  // import quoted *inside* a string literal (a doc assertion needle, or the
  // workflow sources embedded in the generated pack) reads as a real import.
  const outsideLiterals = blankLiteralRanges(text, literalRanges)
  for (const match of outsideLiterals.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
    specifiers.add(match[1])
  }
  return [...specifiers].sort()
}

/** @param {Record<string, unknown>} manifest @param {string} section */
function dependencyNames(manifest, section) {
  const deps = manifest[section]
  return deps && typeof deps === "object" && !Array.isArray(deps) ? new Set(Object.keys(deps)) : new Set()
}

/**
 * True for a file that only ever runs from a workspace install: tests, configs,
 * package scripts, and build-graph declarations. Such a file may use
 * `devDependencies`; a shipped source file may not.
 *
 * `legacy declaration` is a declaration the build CLI loads with the root install, and
 * no tarball contains one.
 *
 * @param {string} file
 */
function isDevOnlyFile(file) {
  const base = basename(file)
  const parts = file.split(sep)
  return (
    parts.includes("test") ||
    parts.includes("tests") ||
    parts.includes("__tests__") ||
    parts.includes("__type-tests__") ||
    parts.includes("scripts") ||
    base === "legacy declaration" ||
    base.includes(".test.") ||
    base.includes(".spec.") ||
    base.endsWith(".config.ts") ||
    base.endsWith(".config.js")
  )
}

/**
 * The dependency names a package's files may import.
 *
 * The runtime/dev split exists so a published tarball never imports something
 * a consumer's install does not fetch. A `private: true` workspace publishes no
 * tarball and always runs from the workspace install, so for one of those the
 * split carries no meaning and every declared section counts as runtime.
 * Private Effect adapters are pinned build inputs whose emitted imports are
 * relocated into the tarball, so their validated declarations count too.
 *
 * @param {WorkspacePackage} pkg
 */
export function dependencySets(pkg) {
  const declared = new Set([
    ...dependencyNames(pkg.manifest, "dependencies"),
    ...dependencyNames(pkg.manifest, "peerDependencies"),
    ...dependencyNames(pkg.manifest, "optionalDependencies"),
    ...privateEffectAdapters(pkg.manifest),
  ])
  const dev = new Set([...declared, ...dependencyNames(pkg.manifest, "devDependencies")])
  const runtime = pkg.manifest.private === true ? dev : declared
  return { runtime, dev }
}

function main() {
  const workspacePackages = findWorkspacePackages()
  const workspaceNames = new Set(workspacePackages.map((pkg) => pkg.name))
  const memberDirs = new Set(workspacePackages.map((pkg) => pkg.dir).filter((dir) => dir !== "."))
  /** @type {Array<{ file: string; specifier: string; packageName: string; section: "dependencies" | "devDependencies" }>} */
  const violations = []
  /** @type {Array<{ file: string; specifier: string; packageDir: string }>} */
  const reachThroughs = []
  /** @type {Set<string>} */
  const seenReachThroughs = new Set()

  const packageQueue = [...workspacePackages]
  let checkedPackageCount = 0
  while (packageQueue.length > 0) {
    const pkg = packageQueue.shift()
    checkedPackageCount += 1
    const { files, nestedPackageDirs } = filesForPackage(pkg, memberDirs)
    for (const nestedDir of nestedPackageDirs) {
      const nestedPkg = readPackage(nestedDir)
      if (nestedPkg) packageQueue.push(nestedPkg)
    }
    const deps = dependencySets(pkg)
    for (const file of files) {
      const devOnly = isDevOnlyFile(file)
      const allowed = devOnly ? deps.dev : deps.runtime
      const expectedSection = devOnly ? "devDependencies" : "dependencies"
      for (const specifier of importSpecifiersForFile(file)) {
        const reached = packageSourceReachedBy(file, specifier, memberDirs)
        if (reached !== null && reached !== pkg.dir) {
          const key = `${file.split(sep).join("/")} -> ${specifier}`
          if (knownReachThroughs.has(key)) seenReachThroughs.add(key)
          else reachThroughs.push({ file, specifier, packageDir: reached })
          continue
        }
        const packageName = packageNameForSpecifier(specifier)
        if (!packageName || packageName === pkg.name) continue
        if (allowed.has(packageName)) continue
        violations.push({ file, specifier, packageName, section: expectedSection })
      }
    }
  }

  const staleReachThroughs = [...knownReachThroughs].filter((key) => !seenReachThroughs.has(key))
  if (violations.length > 0 || reachThroughs.length > 0 || staleReachThroughs.length > 0) {
    console.error("Dependency boundary check failed: undeclared imports found.\n")
    for (const violation of violations) {
      const workspaceHint = workspaceNames.has(violation.packageName) ? "workspace dependency" : "dependency"
      console.error(
        `- ${relative(repoRoot, join(repoRoot, violation.file))} imports ${violation.specifier}; ` +
          `declare ${violation.packageName} as a ${workspaceHint} in ${violation.section}.`,
      )
    }
    for (const reach of reachThroughs) {
      const name = readPackage(reach.packageDir)?.name ?? reach.packageDir
      console.error(
        `- ${relative(repoRoot, join(repoRoot, reach.file))} imports ${reach.specifier}, ` +
          `which resolves inside ${reach.packageDir}/src; import ${name} by package name through its export map.`,
      )
    }
    for (const key of staleReachThroughs) {
      console.error(`- knownReachThroughs entry "${key}" no longer matches an import; remove it from the gate.`)
    }
    process.exitCode = 1
  } else {
    console.log(`Dependency boundary check passed for ${checkedPackageCount} package(s).`)
  }
}

if (isMain(import.meta)) {
  main()
}
