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
 * declarations are listed in `versionedSources` and rewritten in the same pass,
 * as are the documentation lines that quote a message naming the release.
 *
 * A package changelog listed in `versionedChangelogs` gains a section for the
 * version in the same pass: its package's own tests require one, and the cut
 * writes only the root changelog.
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
  },
  {
    path: "packages/smithers/flows/database/src/internal/ReleasePolicy.ts",
    declaration: "releaseVersion",
    pattern: /(export const releaseVersion = ")([^"]*)(")/
  },
  // The storage package's docs quote the refusals and the notice that
  // `ReleasePolicy.releaseVersion` names, and the site page is their copy.
  ...[
    "packages/smithers/flows/database/docs/api.md",
    "apps/site/src/content/docs/docs/reference/api/database.mdx"
  ].flatMap((path) => [
    {
      path,
      package: "packages/smithers/flows/database",
      declaration: "the ignored-setting notice",
      pattern: /(has no effect in )(\S+)( \(use SMITHERS_POSTGRES_URL)/
    },
    {
      path,
      package: "packages/smithers/flows/database",
      declaration: "the durable database refusal",
      pattern: /(A refusal to open a durable database in )([^\s,]+)(, raised as a defect)/
    },
    {
      path,
      package: "packages/smithers/flows/database",
      declaration: "the unsupported_database_file message",
      pattern: /(is not a Smithers 1\.0 database \()(\S+)( does not load a 0\.x smithers\.db\))/
    }
  ]),
  {
    path: "packages/smithers/flows/database/docs/troubleshooting.md",
    package: "packages/smithers/flows/database",
    declaration: "the runtime refusal heading",
    pattern: /(### `)(\S+)( runs the durable engine on Node\.js)/
  },
  {
    path: "packages/smithers/flows/database/docs/troubleshooting.md",
    package: "packages/smithers/flows/database",
    declaration: "the unsupported_database_file heading",
    pattern: /(is not a Smithers 1\.0 database \()(\S+)( does not load a 0\.x smithers\.db\))/
  }
]

/**
 * Package changelogs that must carry a `## [<version>]` section for the
 * version their manifest declares.
 *
 * `scripts/generate-changelog.mjs` writes the root changelog only. A package
 * whose tests tie its own changelog to its manifest (`@smthrs/scorers`) failed
 * at the rc.2 and rc.3 cuts until someone added the heading by hand.
 */
export const versionedChangelogs = ["packages/smithers/agent/scorers/CHANGELOG.md"]

const versionHeading = (version) => new RegExp(`^## \\[${version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`, "m")

/**
 * Releases a Keep a Changelog file at `version`: the entries under
 * `## [Unreleased]` move under a dated heading for the version, and an empty
 * `[Unreleased]` records that the package rode the train unchanged. A file that
 * already has the heading is returned as it is.
 */
export const releaseChangelog = (text, version, date) => {
  if (versionHeading(version).test(text)) return text
  const unreleased = /^## \[Unreleased\][^\n]*\n/m.exec(text)
  if (unreleased === null) throw new Error("the changelog has no `## [Unreleased]` section to release")
  const start = unreleased.index + unreleased[0].length
  const next = /^## \[/m.exec(text.slice(start))
  const end = next === null ? text.length : start + next.index
  const entries = text.slice(start, end).trim()
  const body = entries === ""
    ? "### Changed\n\n- Released with the workspace package train. No change to this package since the previous release."
    : entries
  return `${text.slice(0, start)}\n## [${version}] - ${date}\n\n${body}\n\n${text.slice(end)}`
}

/**
 * Every versioned changelog without a section for `version`.
 */
export const changelogMismatches = (version, root = repoRoot, changelogs = versionedChangelogs) =>
  changelogs
    .filter((path) => !versionHeading(version).test(readFileSync(join(root, path), "utf8")))
    .map((path) => `${path}: no \`## [${version}]\` section`)

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
    const drift = [...mismatches(entries, version), ...sourceMismatches(version), ...changelogMismatches(version)]
    for (const line of drift) console.error(line)
    if (drift.length > 0) {
      console.error(`\n${drift.length} entries disagree with ${version}.`)
      process.exitCode = 1
      return
    }
    console.log(
      `${entries.length} versioned manifests, ${count(versionedSources.length, "versioned source")} and ${
        count(versionedChangelogs.length, "versioned changelog")
      } are at ${version}.`
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
  let released = 0
  const today = new Date().toISOString().slice(0, 10)
  for (const changelog of versionedChangelogs) {
    const path = join(repoRoot, changelog)
    const text = readFileSync(path, "utf8")
    const updated = releaseChangelog(text, version, today)
    if (updated === text) continue
    writeFileSync(path, updated)
    released += 1
  }
  console.log(`set ${written} of ${entries.length} versioned manifests to ${version}.`)
  console.log(`set ${rewritten} of ${count(versionedSources.length, "versioned source")} to ${version}.`)
  console.log(`released ${released} of ${count(versionedChangelogs.length, "versioned changelog")} at ${version}.`)
  console.log("run `pnpm install --lockfile-only` next: the lockfile records these specifiers.")
}

if (isMain(import.meta)) {
  main(process.argv.slice(2))
}
