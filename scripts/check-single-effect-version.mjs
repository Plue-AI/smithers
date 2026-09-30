/** Exact Effect-family declarations, locked versions, and live package resolution.
 * Physical identity is a necessary check, not proof against arbitrary loader
 * namespaces. The executable loading contract has separate instance tests.
 */
import { createRequire } from "node:module"
import { readFileSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"

import { workspacePackages, isMain, repoRoot } from "./workspace-packages.mjs"
import { readWorkspaceManifests } from "./pack-release.mjs"

// Update the family atomically with manifests and both package-manager locks.
export const EXPECTED_EFFECT_VERSION = "4.0.0-rc.115"
const family = new Set(["effect", "@effect/opentelemetry", "@effect/platform-bun",
  "@effect/platform-node", "@effect/platform-node-shared", "@effect/sql-sqlite-node", "@effect/vitest"])
const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
const isFamily = (name, version) => family.has(name) || name.startsWith("@effect/") && /-rc\./.test(String(version))

export const effectDeclarations = (manifest, source) => sections.flatMap((section) =>
  Object.entries(manifest[section] ?? {}).filter(([name, range]) => isFamily(name, range))
    .map(([name, version]) => ({ name, version, source: `${source} (${section})` })))

/** Read resolved package entries, including quoted scoped pnpm keys. */
export const effectLockVersions = (text, format) => {
  const pattern = format === "pnpm"
    ? /^ {2}['"]?(@effect\/[^@\s]+|effect)@([^:'"\s(]+)(?:\([^\n]*\))?['"]?:$/gm
    : /"[^"\n]+"\s*:\s*\[\s*"(@effect\/[^@"\s]+|effect)@([^"\s]+)"/g
  return [...text.matchAll(pattern)].filter((match) => isFamily(match[1], match[2]))
    .map((match) => ({ name: match[1], version: match[2], source: format === "pnpm" ? "pnpm-lock.yaml" : "bun.lock" }))
}

export const assertEffectPins = (records) => {
  const wrong = records.filter(({ version }) => version !== EXPECTED_EFFECT_VERSION)
  if (wrong.length > 0) throw new Error(`Expected exact Effect-family RC ${EXPECTED_EFFECT_VERSION}:\n` +
    wrong.map(({ name, version, source }) => `  ${source}: ${name}@${version}`).join("\n"))
}

/**
 * `@effect/platform-bun` and `@effect/platform-node` ask for
 * `@effect/platform-node-shared` with a caret range, so a fresh consumer
 * resolves its newest release candidate, which imports Effect modules the
 * pinned `effect` lacks: `smithers-orchestrator@0.32.0` exited before MCP
 * `initialize` that way (#2398). A published package that declares either
 * platform must therefore declare `@effect/platform-node-shared` exactly
 * itself: in `dependencies` when the platform is a dependency, and in
 * `dependencies` or `peerDependencies` when the platform is a peer.
 */
const platformsNeedingShared = ["@effect/platform-bun", "@effect/platform-node"]
export const nodeSharedPinProblems = (manifests) => {
  const problems = []
  for (const [directory, manifest] of manifests) {
    for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      const platforms = platformsNeedingShared.filter((name) => Object.hasOwn(manifest[section] ?? {}, name))
      if (platforms.length === 0) continue
      const allowed = section === "peerDependencies" ? ["dependencies", "peerDependencies"] : ["dependencies"]
      const pinned = allowed.some((where) => manifest[where]?.["@effect/platform-node-shared"] === EXPECTED_EFFECT_VERSION)
      if (!pinned) {
        problems.push(`${directory} (${manifest.name}): ${section} declares ${platforms.join(" and ")} without an exact ` +
          `@effect/platform-node-shared@${EXPECTED_EFFECT_VERSION} in ${allowed.join(" or ")}`)
      }
    }
  }
  return problems
}

export const assertNodeSharedPins = (manifests) => {
  const problems = nodeSharedPinProblems(manifests)
  if (problems.length > 0) throw new Error(`Published packages leave @effect/platform-node-shared to a caret range:\n  ${problems.join("\n  ")}`)
}

/** Missing and malformed installs fail closed; same-version private Effect copies fail too. */
export const installedEffectResolutions = (root, manifests) => {
  const rootEffect = realpathSync(createRequire(join(root, "package.json")).resolve("effect/package.json"))
  const records = []
  for (const [directory, manifest] of manifests) {
    const require = createRequire(join(root, directory, "package.json"))
    const declarations = effectDeclarations(manifest, directory)
    for (const name of new Set(declarations.map((entry) => entry.name))) {
      const path = realpathSync(require.resolve(`${name}/package.json`))
      const installed = JSON.parse(readFileSync(path, "utf8"))
      if (installed.name !== name) throw new Error(`${directory}: ${name} resolves to ${installed.name} at ${path}`)
      records.push({ name, version: installed.version, source: `${directory} resolves ${path}` })
      if (name === "effect" && path !== rootEffect) {
        throw new Error(`${directory}: a different physical Effect instance resolves at ${path}; root uses ${rootEffect}`)
      }
      if (name !== "effect") {
        const adapterEffect = realpathSync(createRequire(path).resolve("effect/package.json"))
        if (adapterEffect !== rootEffect) throw new Error(`${directory}: ${name} resolves a different physical Effect instance at ${adapterEffect}`)
      }
    }
  }
  return records
}

export const checkEffectVersions = (root = repoRoot) => {
  const manifestRecords = [
    ...effectDeclarations(JSON.parse(readFileSync(join(root, "package.json"), "utf8")), "package.json"),
    ...workspacePackages(root).flatMap((entry) => effectDeclarations(entry.manifest, `${entry.dir}/package.json`))
  ]
  const locked = [
    ...effectLockVersions(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"), "pnpm"),
    ...effectLockVersions(readFileSync(join(root, "bun.lock"), "utf8"), "bun")
  ]
  for (const format of ["pnpm-lock.yaml", "bun.lock"]) {
    if (!locked.some((entry) => entry.source === format && entry.name === "effect")) throw new Error(`${format}: no resolved Effect package`)
  }
  assertEffectPins([...manifestRecords, ...locked])
  const published = readWorkspaceManifests(root)
  assertNodeSharedPins(published)
  const installed = installedEffectResolutions(root, published)
  assertEffectPins(installed)
  return { declarations: manifestRecords.length, locked: locked.length, resolutions: installed.length, packages: published.size }
}

if (isMain(import.meta)) {
  const result = checkEffectVersions()
  console.log(`check-single-effect-version: exact RC ${EXPECTED_EFFECT_VERSION}; ${result.declarations} declarations, ` +
    `${result.locked} locked entries, ${result.resolutions} installed resolutions across ${result.packages} published packages; one physical Effect`)
}
