/**
 * Sets one version across every workspace manifest, including the exact
 * `@smthrs/*` ranges the workspaces use for each other.
 *
 * The release workflow refuses a tag whose version does not match every engine
 * manifest, and the published packages depend on their siblings by exact
 * version. So a release bump is not `version` alone: an engine package
 * published as 0.1.0-next.0 that still depends on `@smthrs/kernel@0.1.0`
 * installs to a version nobody published. This rewrites both halves in one
 * pass, across every group, so the workspace stays resolvable afterwards.
 *
 * A few published sources also carry the release version as a literal, because
 * a package cannot read its own manifest on every runtime it supports. Those
 * declarations are listed in `versionedSources` and rewritten in the same pass.
 *
 * usage:
 *   node scripts/set-release-version.mjs <version>     rewrite manifests
 *   node scripts/set-release-version.mjs --check <version>
 *                                                      report drift, exit 1
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { workspacePackages, isMain, repoRoot } from "./workspace-packages.mjs"

const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]

/** Shipped consumer manifests are not workspace members, but their pins ship. */
export const versionedTemplates = []

/**
 * Source declarations that repeat the release version as a literal.
 *
 * Each entry names a file, the declaration to rewrite, and a `RegExp` with
 * three capture groups: everything before the version, the version itself, and
 * everything after it. Add a row whenever a published source hard-codes the
 * version; the bump and the `--check` mode then cover it for free.
 */
export const versionedSources = [
  {
    package: "packages/smithers",
    path: "distribution/README.md",
    declaration: "SMITHERS_IMAGE",
    pattern: /(export SMITHERS_IMAGE=ghcr\.io\/smithersai\/smithers:)([^\s]+)(\n)/
  },
  {
    package: "packages/smithers",
    path: "distribution/version.env",
    declaration: "SMITHERS_DISTRIBUTION_VERSION",
    pattern: /(SMITHERS_DISTRIBUTION_VERSION=)([^\n]+)(\n)/
  },
  {
    package: "packages/smithers",
    path: "distribution/Dockerfile",
    declaration: "SMITHERS_DISTRIBUTION_VERSION",
    pattern: /(ARG SMITHERS_DISTRIBUTION_VERSION=)([^\n]+)(\n)/
  },
  {
    path: "packages/smithers/flows/observability/src/Otlp.ts",
    declaration: "defaultServiceVersion",
    pattern: /(export const defaultServiceVersion = ")([^"]*)(")/
  },
  {
    path: "packages/smithers/migrate/src/flow/Cli.ts",
    declaration: "version",
    pattern: /(export const version = ")([^"]*)(")/
  },
  {
    path: "packages/smithers/migrate/src/Report.ts",
    declaration: "tool.version",
    pattern: /(export const tool = \{ name: "@smthrs\/migrate", version: ")([^"]*)(" \} as const)/
  },
  {
    path: "packages/smithers/mcp/src/McpClient.ts",
    declaration: "clientInfo.version",
    pattern: /(name: "smithers",\s*version: ")([^"]*)(")/
  }
]

/**
 * Rewrites one versioned source declaration, or throws when the declaration is
 * gone. A silent miss would let the literal drift, which is the whole failure
 * this table exists to stop.
 */
export const retargetSource = (text, version, { path, declaration, pattern }) => {
  if (!pattern.test(text)) throw new Error(`${path} no longer declares ${declaration}`)
  return text.replace(pattern, `$1${version}$3`)
}

/**
 * Every versioned source declaration that disagrees with `version`.
 */
export const sourceMismatches = (version, root = repoRoot, sources = versionedSources) => {
  const found = []
  for (const { declaration, path, pattern } of sources) {
    const match = pattern.exec(readFileSync(join(root, path), "utf8"))
    if (match === null) {
      found.push(`${path}: ${declaration} is missing, expected ${version}`)
    } else if (match[2] !== version) {
      found.push(`${path}: ${declaration} is ${match[2]}, expected ${version}`)
    }
  }
  return found
}

/**
 * Reads every manifest selected by `pnpm-workspace.yaml`, keyed by its path
 * relative to the repository root.
 *
 * The membership reading is `scripts/workspace-packages.mjs`, the one place
 * that knows where packages live, so a package nested inside the product
 * package it belongs to is bumped like any other.
 */
export const readManifests = (root = repoRoot) =>
  workspacePackages(root).map((entry) => ({
    directory: entry.dir,
    path: entry.manifestPath,
    manifest: entry.manifest
  }))

export const readVersionedManifests = (root = repoRoot) => [
  ...readManifests(root),
  ...versionedTemplates.map((directory) => ({
    directory,
    path: join(root, directory),
    manifest: JSON.parse(readFileSync(join(root, directory), "utf8")),
    registryDependencies: true
  }))
]

/**
 * Retargets one manifest at `version`.
 *
 * Published manifests always receive a concrete sibling version: package
 * managers rewrite `workspace:` during packing, but the checked-in release
 * contract must already describe what a registry consumer can resolve.
 * Private manifests retain workspace/catalog protocols and only have concrete
 * sibling versions retargeted.
 */
export const retarget = (manifest, version, workspaceNames, { registryDependencies = false } = {}) => {
  const updated = manifest.private === true ? { ...manifest } : { ...manifest, version }
  for (const field of dependencyFields) {
    if (manifest[field] === undefined) continue
    updated[field] = Object.fromEntries(
      Object.entries(manifest[field]).map(([name, range]) => {
        if (!workspaceNames.has(name)) return [name, range]
        if (registryDependencies || manifest.private !== true || !range.includes(":")) return [name, version]
        return [name, range]
      })
    )
  }
  return updated
}

const count = (total, noun) => `${total} ${noun}${total === 1 ? "" : "s"}`

/**
 * Every place a manifest still disagrees with `version`.
 */
export const mismatches = (entries, version) => {
  const workspaceNames = new Set(entries.map(({ manifest }) => manifest.name))
  const found = []
  for (const { directory, manifest, registryDependencies = false } of entries) {
    const manifestPath = directory.endsWith("package.json") ? directory : `${directory}/package.json`
    if (manifest.private !== true && manifest.version !== version) {
      found.push(`${manifestPath}: version is ${manifest.version}, expected ${version}`)
    }
    for (const field of dependencyFields) {
      for (const [name, range] of Object.entries(manifest[field] ?? {})) {
        if (!workspaceNames.has(name) || range === version) continue
        if (!registryDependencies && manifest.private === true && range.includes(":")) continue
        found.push(`${manifestPath}: ${field}.${name} is ${range}, expected ${version}`)
      }
    }
  }
  return found
}

export const main = (argv) => {
  const check = argv[0] === "--check"
  const version = check ? argv[1] : argv[0]
  if (version === undefined || version.startsWith("-")) {
    throw new Error("usage: node scripts/set-release-version.mjs [--check] <version>")
  }
  if (version.startsWith("v")) {
    throw new Error(`pass the version, not the tag: ${version.slice(1)}`)
  }
  const entries = readVersionedManifests()
  if (check) {
    const drift = [...mismatches(entries, version), ...sourceMismatches(version)]
    for (const line of drift) console.error(line)
    if (drift.length > 0) {
      console.error(`\n${drift.length} entries disagree with ${version}.`)
      process.exitCode = 1
      return
    }
    console.log(
      `${entries.length} versioned manifests and ${count(versionedSources.length, "versioned source")} are at ${version}.`
    )
    return
  }
  const workspaceNames = new Set(entries.map(({ manifest }) => manifest.name))
  let written = 0
  for (const { manifest, path, registryDependencies } of entries) {
    const updated = retarget(manifest, version, workspaceNames, { registryDependencies })
    const text = `${JSON.stringify(updated, null, 2)}\n`
    if (text === `${JSON.stringify(manifest, null, 2)}\n`) continue
    writeFileSync(path, text)
    written += 1
  }
  let rewritten = 0
  for (const source of versionedSources) {
    const path = join(repoRoot, source.path)
    const text = readFileSync(path, "utf8")
    const updated = retargetSource(text, version, source)
    if (updated === text) continue
    writeFileSync(path, updated)
    rewritten += 1
  }
  console.log(`set ${written} of ${entries.length} versioned manifests to ${version}.`)
  console.log(`set ${rewritten} of ${count(versionedSources.length, "versioned source")} to ${version}.`)
  console.log("run `pnpm install --lockfile-only` next: the lockfile records these specifiers.")
}

if (isMain(import.meta)) {
  main(process.argv.slice(2))
}
