/**
 * Read-only public entrypoint inventory. Explicit manifest entries are the
 * allowlist: creating another source module never adds an import contract.
 */
import { existsSync, globSync } from "node:fs"
import { join } from "node:path"

import { libraryPackages, repoRoot, isMain } from "./workspace-packages.mjs"

/** Keep condition order and ESM-only branches when substituting a pattern. */
const substitute = (target, capture) => {
  if (typeof target === "string") return target.replaceAll("*", capture)
  if (target === null || target === undefined) return target
  if (Array.isArray(target)) return target.map((entry) => substitute(entry, capture))
  return Object.fromEntries(Object.entries(target).map(([condition, entry]) => [condition, substitute(entry, capture)]))
}

/** Select a manifest target without evaluating modules or choosing a condition. */
export const exportTarget = (map, subpath) => {
  if (Object.hasOwn(map, subpath)) return map[subpath]
  const patterns = Object.keys(map).filter((key) => {
    const star = key.indexOf("*")
    return star >= 0 && subpath.length >= key.length &&
      subpath.startsWith(key.slice(0, star)) && subpath.endsWith(key.slice(star + 1))
  }).sort((left, right) => right.indexOf("*") - left.indexOf("*") || right.length - left.length)
  const pattern = patterns[0]
  if (pattern === undefined) return undefined
  const star = pattern.indexOf("*")
  const suffix = pattern.length - star - 1
  return substitute(map[pattern], subpath.slice(star, suffix === 0 ? undefined : -suffix))
}

/** Existing source-addressable paths, including deliberately exposed nested modules. */
export const sourceSubpaths = (directory) =>
  globSync("src/**/*.ts", { cwd: directory })
    .filter((file) => !/\.d\.[cm]?ts$/.test(file))
    .map((file) => "./" + file.replaceAll("\\", "/").slice(4, -3)).sort()

/** Enumerate contracts from the old map before replacing its positive wildcard. */
export const publicSubpaths = (map, directory) =>
  [
    ...new Set([
      ...Object.entries(map).filter(([key, target]) => !key.includes("*") && target !== null).map(([key]) => key),
      ...sourceSubpaths(directory).filter((key) => exportTarget(map, key) != null)
    ])
  ].sort()

/** Produce a reviewable equivalent map; this helper never writes a manifest. */
export const explicitMap = (map, subpaths, denied = []) => {
  const entries = Object.entries(map).filter(([key, target]) => !key.includes("*") || target === null)
  const result = Object.fromEntries(entries)
  for (const subpath of subpaths) {
    if (denied.includes(subpath)) continue
    const target = exportTarget(map, subpath)
    if (target != null && !Object.hasOwn(result, subpath)) result[subpath] = target
  }
  for (const subpath of denied) result[subpath] = null
  return result
}

const leaves = (target) =>
  typeof target === "string" ? [target] : target === null ?
    [] :
    Object.values(target).flatMap(leaves)

const runtimeLeaves = (target) =>
  typeof target === "string" ? [target] : target === null ?
    [] :
    Object.entries(target).flatMap(([condition, value]) => condition === "types" ? [] : runtimeLeaves(value))

/** Check current manifests, not a generated list that could silently expose new files. */
export const auditPublicExports = (root = repoRoot) =>
  libraryPackages(root)
    .filter((entry) => entry.manifest.private !== true)
    .map((entry) => {
      const errors = []
      const inspectMap = (label, map) => {
        if (map === undefined) {
          errors.push(`${label}: missing export map`)
          return undefined
        }
        if (map === null || typeof map !== "object" || Array.isArray(map)) {
          errors.push(`${label}: export map must be an object`)
          return undefined
        }
        const entries = Object.entries(map)
        for (const [key, target] of entries) {
          if (key.includes("*") && target !== null) errors.push(`${label}: positive wildcard ${key}`)
        }
        return entries
      }
      const development = inspectMap("development", entry.manifest.exports)
      const published = inspectMap("published", entry.manifest.publishConfig?.exports)
      if (
        development !== undefined && published !== undefined &&
        JSON.stringify(development.map(([key]) => key).sort()) !== JSON.stringify(published.map(([key]) => key).sort())
      ) {
        errors.push("development/published keys differ")
      }
      const developmentEntries = development ?? []
      for (const [key, target] of developmentEntries) {
        if (key.includes("*") || target === null) continue
        for (const file of runtimeLeaves(target)) {
          if (/\.d\.[cm]?ts$/.test(file)) errors.push(`declaration-only runtime target ${key}: ${file}`)
        }
        for (const file of leaves(target)) {
          if (!existsSync(join(root, entry.dir, file))) errors.push(`missing source target ${key}: ${file}`)
        }
      }
      const subpaths = developmentEntries.filter(([key, target]) => !key.includes("*") && target !== null).map(
        ([key]) => key
      )
      return { name: entry.name, directory: entry.dir, subpaths, errors }
    })

if (isMain(import.meta)) {
  const rows = auditPublicExports()
  console.log(JSON.stringify(rows, null, 2))
  if (rows.some((row) => row.errors.length > 0)) process.exitCode = 1
}
