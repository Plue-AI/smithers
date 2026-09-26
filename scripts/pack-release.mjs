/**
 * Packs publishable workspace tarballs without changing the Effect-style
 * source exports used by this repository.
 *
 * pnpm preserves `package.json#exports` when packing; it does not replace it
 * with `publishConfig.exports`. Each package intentionally follows Effect's
 * source-first manifest shape, so release packing happens from a temporary
 * copy whose exports are rewritten to the already-built ESM/CJS artifacts.
 */
import { createHash } from "node:crypto"
import { integrity } from "./publish-release.mjs"
import { execFileSync, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { access, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, relative, resolve, sep } from "node:path"

import { libraryPackages, packageKey, isMain, repoRoot } from "./workspace-packages.mjs"
import { assertPackedExportTargets } from "./packed-export-targets.mjs"
import { buildRelease } from "./build-release.mjs"
import { nativeHelperFiles } from "./release-native-helpers.mjs"

/**
 * Every group a workspace manifest may declare, and the groups the 1.0 release
 * train packs. They are one set on purpose.
 *
 * 0.x shipped the engine group alone and left the agent layer for a second
 * train, so a manifest could name a known group that no train packed. Smithers
 * 1.0 gives every public first-party package one synchronized version, so all
 * known groups release together and the only thing that holds a package back
 * is the manifest's `private` flag. Splitting this into a "known" set and a
 * smaller "released" set again would reintroduce a group that validates but
 * never publishes.
 */
export const releaseGroups = new Set(["engine", "agent", "tooling"])

/**
 * The package names published by the current release candidate.
 *
 * Group membership alone would let a new or newly public package join the
 * release by declaring a group, and it would let a package leave by flipping
 * `private`. Both are release decisions, so the roster is restated here and
 * checked against what the workspace actually declares.
 */
export const publishedPackages = [
  "@smthrs/agent",
  "@smthrs/artifacts",
  "@smthrs/build",
  "@smthrs/build-cli",
  "@smthrs/canonical",
  "@smthrs/capability",
  "@smthrs/cli",
  "@smthrs/control",
  "@smthrs/core",
  "@smthrs/create-app",
  "@smthrs/crypto",
  "@smthrs/database",
  "@smthrs/engine",
  "@smthrs/engine-store",
  "@smthrs/errors",
  "@smthrs/evals",
  "@smthrs/flow",
  "@smthrs/flows",
  "@smthrs/gateway",
  "@smthrs/harness",
  "@smthrs/integrations",
  "@smthrs/jj",
  "@smthrs/journal",
  "@smthrs/kernel",
  "@smthrs/keys",
  "@smthrs/mcp",
  "@smthrs/memory",
  "@smthrs/migrate",
  "@smthrs/model",
  "@smthrs/notifications",
  "@smthrs/observability",
  "@smthrs/patterns",
  "@smthrs/plan",
  "@smthrs/plan-store",
  "@smthrs/platform-browser",
  "@smthrs/platform-bun",
  "@smthrs/platform-node",
  "@smthrs/plugin",
  "@smthrs/registry",
  "@smthrs/run-store",
  "@smthrs/sandbox",
  "@smthrs/scorers",
  "@smthrs/std",
  "@smthrs/step-cache",
  "@smthrs/sync",
  "@smthrs/targets",
  "@smthrs/testing",
  "@smthrs/time-travel",
  "@smthrs/triggers",
  "smthrs"
]

/**
 * Reads every publishable workspace under `packages/`, keyed by its
 * repository-relative directory.
 *
 * The key is a path — `packages/smithers/flows/plan`, `packages/smithers/flows/canonical` — because a
 * package's directory is where it lives and a nested package's basename is not
 * enough to find it. `scripts/workspace-packages.mjs` answers what the members
 * are, from `pnpm-workspace.yaml`, so publication and installation cannot
 * disagree about the set and nesting is decided in one place.
 *
 * Membership is derived from `smthrs.group` and `private`, then checked against
 * {@link publishedPackages}. Every manifest must declare a known group so a new
 * package cannot silently fall outside a release train.
 */
export const readWorkspaceManifests = (root = repoRoot) => {
  const manifests = new Map()
  for (const entry of libraryPackages(root)) {
    const group = entry.manifest.smthrs?.group
    if (!releaseGroups.has(group)) {
      throw new Error(`${entry.manifestPath}: smthrs.group must be one of ${[...releaseGroups].join(", ")}`)
    }
    if (entry.manifest.private) continue
    manifests.set(entry.dir, entry.manifest)
  }
  const declared = [...manifests.values()].map((manifest) => manifest.name).sort()
  const expected = [...publishedPackages].sort()
  const missing = expected.filter((name) => !declared.includes(name))
  const unexpected = declared.filter((name) => !expected.includes(name))
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      "the publishable workspace set does not match publishedPackages" +
        (missing.length > 0 ? `\n  missing: ${missing.join(", ")}` : "") +
        (unexpected.length > 0 ? `\n  unexpected: ${unexpected.join(", ")}` : "") +
        "\nEither restore the manifest's `private` flag and group or update publishedPackages in this file."
    )
  }
  return manifests
}

/**
 * Maps each workspace directory to the workspace directories it depends on.
 *
 * Only `@smthrs/*` edges resolving to a member of `manifests` are kept, so a
 * dependency on something outside the release set cannot order the release.
 * Optional peers do not require an earlier publication; kernel's browser
 * test host uses one to keep test support out of its runtime dependency graph.
 *
 * @since 1.0.0
 * @category utilities
 */
export const workspaceDependencies = (manifests) => {
  const directoryOf = new Map(
    [...manifests].map(([directory, manifest]) => [manifest.name, directory])
  )
  return new Map([...manifests].map(([directory, manifest]) => [
    directory,
    new Set(
      Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })
        .filter((dependency) =>
          manifest.dependencies?.[dependency] !== undefined
          || manifest.peerDependenciesMeta?.[dependency]?.optional !== true
        )
        .map((dependency) => directoryOf.get(dependency))
        .filter((dependency) => dependency !== undefined)
    )
  ]))
}

/**
 * Orders workspaces so a package follows every workspace dependency it declares.
 *
 * The tiebreak among unblocked workspaces is the directory's last segment
 * rather than the whole path. Release order is a property of the packages, not
 * of where their directories sit, so nesting a granular package inside the
 * product package it belongs to publishes the same names in the same
 * order it published them from a top-level directory.
 *
 * A cycle is a release error: publication cannot satisfy both edges without a
 * package already existing in the registry, which makes a clean RC bootstrap
 * impossible.
 *
 * @since 1.0.0
 * @category utilities
 */
export const dependencyOrder = (dependencies) => {
  const byBasename = (left, right) => {
    const a = packageKey({ dir: left })
    const b = packageKey({ dir: right })
    return a < b ? -1 : a > b ? 1 : 0
  }
  const remaining = new Set([...dependencies.keys()].sort(byBasename))
  const ordered = []
  while (remaining.size > 0) {
    const unblocked = [...remaining].find((candidate) =>
      [...dependencies.get(candidate)].every((edge) => !remaining.has(edge))
    )
    if (unblocked === undefined) {
      throw new Error(`cyclic workspace dependencies among ${[...remaining].join(", ")}`)
    }
    ordered.push(unblocked)
    remaining.delete(unblocked)
  }
  return ordered
}

/**
 * Dependency order used for release packing and publication.
 *
 * This is a function, not a module-level constant, because it reads and
 * validates a workspace tree. As a constant it ran at import, so every
 * importer that only wanted a pure helper — `dependencyOrder`,
 * `workspaceDependencies`, or `readWorkspaceManifests(someOtherRoot)` — read
 * this repository's manifests and inherited the roster check's throw before it
 * could call anything.
 */
export const workspaces = (root = repoRoot) => dependencyOrder(workspaceDependencies(readWorkspaceManifests(root)))

const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

/**
 * Extracts the portable tarball name from pnpm's pack result.
 *
 * pnpm returns an absolute `filename` when `--pack-destination` is absolute,
 * while the release manifest deliberately stores names relative to its pack
 * directory so CI can move and publish that directory as one artifact.
 */
export const packResultFilename = (result, packageName) => {
  if (!isRecord(result) || typeof result.filename !== "string") {
    throw new Error(`pnpm pack returned no filename for ${String(packageName)}`)
  }
  return basename(result.filename)
}

/**
 * Produces the manifest that belongs in a registry tarball.
 */
export const publicationManifest = (manifest) => {
  if (!isRecord(manifest)) {
    throw new TypeError("package manifest must be an object")
  }
  const publishConfig = manifest.publishConfig
  if (!isRecord(publishConfig) || !isRecord(publishConfig.exports)) {
    throw new TypeError(`${String(manifest.name ?? "package")} must declare publishConfig.exports`)
  }
  const { exports, ...publishedConfig } = publishConfig
  return {
    ...manifest,
    exports,
    publishConfig: publishedConfig
  }
}

const sourceFiles = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory()
      ? sourceFiles(path)
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") || entry.name.endsWith(".js") ? [path]
      : []
  }))
  return nested.flat()
}

/**
 * The modules a manifest publishes as ESM only: every `publishConfig.exports`
 * entry that names a concrete `dist/esm` file under `import` and declares no
 * `require` condition. `@smthrs/testing/Vitest` is one: `vitest` refuses to
 * load through `require()`, so the package's build program emits no
 * `dist/cjs/Vitest.js` and the export map is what tells consumers so. The
 * built-output check below reads the same map, so the two cannot disagree.
 */
export const esmOnlyModules = (manifest) => {
  const modules = new Set()
  for (const conditions of Object.values(manifest.publishConfig?.exports ?? {})) {
    if (typeof conditions !== "object" || conditions === null || "require" in conditions) continue
    const match = /^\.\/dist\/esm\/([^*]+)\.js$/.exec(conditions.import ?? "")
    if (match !== null) modules.add(match[1])
  }
  return modules
}

/**
 * Replaces every comment and template literal in `source` with spaces, one per
 * character, so a line-anchored regex sees only declarations and every offset
 * and line number still points at the original text. Quoted strings are kept,
 * because an import declaration's module specifier is one, but they are
 * tracked so a backtick inside `"```ts"` does not open a template.
 *
 * The scanner knows five states and nothing else: a `'` or `"` string ends at
 * its closing quote or at the end of its line, a template literal ends at its
 * closing backtick and nests through `${ }`, and a comment ends at the end of
 * its line or at the closing star-slash. Regular-expression literals are not
 * recognised, so an unescaped quote inside one costs at most the rest of its
 * own line and an unescaped backtick opens a template; neither occurs in a
 * published package today, and dprint escapes both.
 */
const declarationText = (source) => {
  const out = []
  // Brace depth inside each open `${ }` hole, innermost last. While a hole is
  // open the scanner is back in code, and the hole's closing brace returns it
  // to the template.
  const holes = []
  let state = "code"
  let i = 0
  const keep = (ch) => out.push(ch)
  const blank = (ch) => out.push(ch === "\n" ? "\n" : " ")
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    switch (state) {
      case "code": {
        if (ch === "/" && next === "/") {
          state = "line"
          blank(ch)
          blank(next)
          i += 2
        } else if (ch === "/" && next === "*") {
          state = "block"
          blank(ch)
          blank(next)
          i += 2
        } else if (ch === "'" || ch === "\"") {
          state = ch
          keep(ch)
          i += 1
        } else if (ch === "`") {
          state = "template"
          blank(ch)
          i += 1
        } else if (holes.length > 0 && ch === "{") {
          holes[holes.length - 1] += 1
          keep(ch)
          i += 1
        } else if (holes.length > 0 && ch === "}" && holes[holes.length - 1] === 0) {
          holes.pop()
          state = "template"
          blank(ch)
          i += 1
        } else if (holes.length > 0 && ch === "}") {
          holes[holes.length - 1] -= 1
          keep(ch)
          i += 1
        } else {
          keep(ch)
          i += 1
        }
        break
      }
      case "line": {
        if (ch === "\n") state = "code"
        blank(ch)
        i += 1
        break
      }
      case "block": {
        if (ch === "*" && next === "/") {
          state = "code"
          blank(ch)
          blank(next)
          i += 2
        } else {
          blank(ch)
          i += 1
        }
        break
      }
      case "'":
      case "\"": {
        if (ch === "\\" && next !== undefined) {
          keep(ch)
          keep(next)
          i += 2
        } else {
          if (ch === state || ch === "\n") state = "code"
          keep(ch)
          i += 1
        }
        break
      }
      case "template": {
        if (ch === "\\" && next !== undefined) {
          blank(ch)
          blank(next)
          i += 2
        } else if (ch === "`") {
          state = "code"
          blank(ch)
          i += 1
        } else if (ch === "$" && next === "{") {
          holes.push(0)
          state = "code"
          blank(ch)
          blank(next)
          i += 2
        } else {
          blank(ch)
          i += 1
        }
        break
      }
    }
  }
  return out.join("")
}

const defaultImportPattern =
  /^[ \t]*import\s+([A-Za-z_$][\w$]*)(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*)\s*|\s+)from\s+["'](\.\.?\/[^"'\n]*)["']/gm
const defaultExportPattern = /^[ \t]*export\s+default\b/gm

/**
 * The default-binding sites in one TypeScript module: every default import of
 * a relative module (`import x from "./y.ts"`, with or without named or
 * namespace bindings beside it) and every `export default` declaration. Each
 * site carries the one-based `line`, its `kind`, and the original line `text`.
 *
 * Both are forbidden in a published package's `src`. `scripts/build.mjs`
 * converts every source file to CommonJS with esbuild (`bundle: false`) inside
 * a `"type": "module"` package, and for a default import of a sibling esbuild
 * emits Node-style interop: `__toESM(require("./y.js"), 1)` and then reads
 * `.default`, which in Node mode is the whole exports object
 * `{ __esModule, default }` rather than the exported value. A migration module
 * imported that way reached `initial.pipe(...)` at module init and threw in
 * the CommonJS entries of `@smthrs/control`, `@smthrs/gateway`, and
 * `@smthrs/cli`. `export default` alone is harmless to `require()`, but it is
 * the only thing a default import can bind to, so it is refused as well.
 *
 * Type-only imports (`import type x from "./y.ts"`) erase before the build and
 * are not reported. Bare and scoped specifiers (`import React from "react"`)
 * cross a package boundary where the interop is the consumer's, not ours, and
 * are not reported either. Comments and template literals are blanked before
 * matching, so a flow skeleton spelled inside a template string is not a site.
 */
export const defaultBindings = (source) => {
  const text = declarationText(source)
  const lines = source.split("\n")
  const lineAt = (index) => text.slice(0, index).split("\n").length
  const sites = []
  for (const match of text.matchAll(defaultImportPattern)) {
    const line = lineAt(match.index)
    sites.push({ line, kind: "import", text: lines[line - 1].trim() })
  }
  for (const match of text.matchAll(defaultExportPattern)) {
    const line = lineAt(match.index)
    sites.push({ line, kind: "export", text: lines[line - 1].trim() })
  }
  return sites.sort((a, b) => a.line - b.line)
}

/** Rebuild before packing: existing export targets do not prove source freshness. */
export const assertBuilt = async (packageRoot, manifest) => {
  // Use the release builder's clean, fail-closed invocation of the package's
  // own build program. This also covers packing outside the release workflow.
  buildRelease(packageRoot, new Map([[".", manifest]]))
  const sourceRoot = join(packageRoot, "src")
  const esmOnly = esmOnlyModules(manifest)
  for (const source of await sourceFiles(sourceRoot)) {
    const modulePath = relative(sourceRoot, source).slice(0, -3)
    await Promise.all([
      access(join(packageRoot, "dist", "esm", `${modulePath}.js`)),
      access(join(packageRoot, "dist", "esm", `${modulePath}.d.ts`)),
      ...(esmOnly.has(modulePath) ? [] : [access(join(packageRoot, "dist", "cjs", `${modulePath}.js`))])
    ])
  }
}

/** Package-declared template trees are authored input, even when configuration is hidden. */
export const copyFilter = (packageRoot, manifest) => (source) => {
  const path = relative(packageRoot, source)
  if (path === "") return true
  const segments = path.split(sep)
  if (segments.some((segment) => segment === "node_modules" || segment === "coverage" || segment === ".flows") || basename(path).endsWith(".tsbuildinfo")) return false
  const configAt = segments.indexOf(".smithers")
  if (configAt === -1) return true
  const prefix = segments.slice(0, configAt).join("/")
  const authoredTemplate = (manifest.files ?? []).some((entry) => entry === `${prefix}/**` && prefix.startsWith("template/"))
  if (!authoredTemplate) return false
  // These are the template's authored configuration files. Runtime caches,
  // databases and credentials under a same-named directory are never shipped.
  const tail = segments.slice(configAt + 1)
  return tail.length === 0 || (tail.length === 1 && ["WORKSPACE.ts", "agents.ts", "sandbox.ts"].includes(tail[0]))
}

/** Stages the exact publication tree; exported for tarball-level regression fixtures. */
export const stagePackage = async (packageRoot, stagedPackage, manifest, nativeHelpersRoot = process.env.SMITHERS_NATIVE_HELPERS_DIR) => {
  await cp(packageRoot, stagedPackage, { recursive: true, filter: copyFilter(packageRoot, manifest) })
  if (manifest.name === "@smthrs/platform-node" && nativeHelpersRoot) {
    for (const [platform, filename] of nativeHelperFiles) {
      const source = join(nativeHelpersRoot, platform, filename)
      await access(source)
      const destination = join(stagedPackage, "bin", platform)
      await mkdir(destination, { recursive: true })
      await cp(source, join(destination, filename))
    }
  }
  await writeFile(join(stagedPackage, "package.json"), `${JSON.stringify(publicationManifest(manifest), null, 2)}\n`)
}

const run = (command, args, options = {}) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "inherit"],
      ...options
    })
    let stdout = ""
    child.stdout?.setEncoding("utf8")
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveRun(stdout)
      } else {
        reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`))
      }
    })
  })

const packWorkspace = async (directory, outputDirectory, stagingRoot) => {
  const packageRoot = join(repoRoot, directory)
  const manifestPath = join(packageRoot, "package.json")
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
  await assertBuilt(packageRoot, manifest)

  // The staging directory is flat: a tarball is named from the manifest, so a
  // nested package stages beside its siblings under its own basename.
  const stagedPackage = join(stagingRoot, packageKey({ dir: directory }))
  await stagePackage(packageRoot, stagedPackage, manifest)

  const output = await run(
    "pnpm",
    [
      "--dir",
      stagedPackage,
      "pack",
      "--json",
      "--config.ignore-scripts=true",
      "--pack-destination",
      outputDirectory
    ]
  )
  const result = JSON.parse(output)
  const filename = packResultFilename(Array.isArray(result) ? result[0] : result, manifest.name)
  assertPackedExportTargets(join(outputDirectory, filename))
  return { name: manifest.name, version: manifest.version, filename,
    integrity: integrity(await readFile(join(outputDirectory, filename))) }

}

export const main = async (args) => {
  const destination = args[0]
  if (destination === "--help") {
    console.log(
      [
        "usage: node scripts/pack-release.mjs <output-directory>",
        "       node scripts/pack-release.mjs --list    workspace directories, in publication order",
        "       node scripts/pack-release.mjs --names   package names, in publication order"
      ].join("\n")
    )
    return
  }
  if (destination === "--list") {
    console.log(workspaces().join("\n"))
    return
  }
  if (destination === "--names") {
    const manifests = readWorkspaceManifests()
    console.log(dependencyOrder(workspaceDependencies(manifests)).map((directory) => manifests.get(directory).name).join("\n"))
    return
  }
  if (destination === undefined) {
    throw new Error("usage: node scripts/pack-release.mjs <output-directory> (or --list or --names)")
  }
  const outputDirectory = resolve(repoRoot, destination)
  await mkdir(outputDirectory, { recursive: true })
  // A pack directory is the whole release artifact, not an accumulator.
  // Leaving an earlier version's tarballs beside this one makes the directory
  // disagree with manifest.json, which is what scripts/smoke-release.mjs
  // checks before it trusts the set. CI packs into a fresh runner.temp, so the
  // stale files only ever appeared in a local `dist/release-packs`.
  for (const entry of await readdir(outputDirectory)) {
    if (entry.endsWith(".tgz") || ["manifest.json", "release-manifest.json", "smoke-evidence.json", "publish-receipt.json", "restore-evidence.json"].includes(entry)) {
      await rm(join(outputDirectory, entry), { force: true })
    }
  }
  const stagingRoot = await mkdtemp(join(tmpdir(), "smthrs-release-pack-"))
  try {
    const packed = []
    for (const directory of workspaces()) {
      packed.push(await packWorkspace(directory, outputDirectory, stagingRoot))
    }
    await writeFile(
      join(outputDirectory, "manifest.json"),
      `${JSON.stringify(packed, null, 2)}\n`
    )
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim()
    const changed = execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: repoRoot, encoding: "utf8" }).trim()
    await writeFile(join(outputDirectory, "release-manifest.json"), JSON.stringify({
      schemaVersion: 1,
      source: { sha: sourceSha, tag: process.env.RELEASE_TAG ?? null, dirty: changed.length > 0 },
      toolchain: { node: process.version, lockfileSha256: createHash("sha256").update(await readFile(join(repoRoot, "pnpm-lock.yaml"))).digest("hex") },
      packages: packed
    }, null, 2) + "\n")
  } finally {
    await rm(stagingRoot, { recursive: true, force: true })
  }
}


if (isMain(import.meta)) {
  await main(process.argv.slice(2))
}
