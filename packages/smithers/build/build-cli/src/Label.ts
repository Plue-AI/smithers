/**
 * Bazel-style target labels and patterns.
 *
 * @since 0.1.0
 */

import * as Path from "./internal/Path.ts"

/**
 * A parsed exact label or recursive package pattern.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Pattern =
  | {
    readonly _tag: "Exact"
    readonly packagePath: string
    readonly target: string | undefined
  }
  | {
    readonly _tag: "Subtree"
    readonly packagePath: string
    /**
     * The one target name the subtree selects, `//packages/...:bunTest`, or
     * undefined for every target under the subtree.
     *
     * This is the Bazel-natural spelling of a matrix that one package at a
     * time opts into: the packages declare the target under a shared key and
     * the pattern names that key, instead of a central declaration file
     * listing which packages are in.
     */
    readonly target: string | undefined
  }

const normalizePackage = (value: string): string => {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "")
  if (normalized === "" || normalized === ".") return ""
  if (normalized.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`invalid package path: ${value}`)
  }
  return normalized
}

/**
 * Parses the supported Bazel label grammar: `:name`, `//pkg`, `//pkg:name`,
 * `//pkg/...`, and `//pkg/...:name`.
 *
 * @category parsing
 * @since 0.1.0
 * @slop
 */
export const parse = (value: string, currentPackage: string): Pattern => {
  if (value.startsWith(":")) {
    const target = value.slice(1)
    if (target.length === 0 || target.includes(":")) throw new Error(`invalid target label: ${value}`)
    return { _tag: "Exact", packagePath: normalizePackage(currentPackage), target }
  }
  if (!value.startsWith("//")) throw new Error(`label must start with // or : ${value}`)
  const body = value.slice(2)
  // The target suffix is split off before the `...` test, so one grammar
  // covers `//pkg:name`, `//pkg/...`, and `//pkg/...:name` rather than the
  // last spelling parsing as a package literally named `pkg/...`.
  const colon = body.indexOf(":")
  if (colon >= 0 && body.indexOf(":", colon + 1) >= 0) throw new Error(`invalid target label: ${value}`)
  const head = colon < 0 ? body : body.slice(0, colon)
  const target = colon < 0 ? undefined : body.slice(colon + 1)
  if (target !== undefined && target.length === 0) throw new Error(`target name is empty: ${value}`)
  if (head === "...") return { _tag: "Subtree", packagePath: "", target }
  if (head.endsWith("/...")) {
    return { _tag: "Subtree", packagePath: normalizePackage(head.slice(0, -4)), target }
  }
  return { _tag: "Exact", packagePath: normalizePackage(head), target }
}

/**
 * Formats a path-derived target label.
 *
 * @category formatting
 * @since 0.1.0
 * @slop
 */
export const format = (packagePath: string, target: string): string => `//${normalizePackage(packagePath)}:${target}`

/**
 * Computes the current package path, or undefined for a directory outside
 * the workspace.
 *
 * Absolute `//...` labels and patterns never need a current package, so an
 * outside directory is not an error here; only resolving a `:name`-relative
 * label requires one, and the caller reports that case.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const currentPackageOrUndefined = (workspaceRoot: string, cwd: string): string | undefined => {
  const relative = Path.containedRelative(workspaceRoot, cwd)
  if (relative === undefined) return undefined
  if (relative === "" || relative === ".") return ""
  return normalizePackage(relative)
}

/**
 * Computes the current package path and refuses directories outside the
 * workspace.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const currentPackage = (workspaceRoot: string, cwd: string): string => {
  const found = currentPackageOrUndefined(workspaceRoot, cwd)
  if (found === undefined) {
    throw new Error(`current directory is outside workspace: ${cwd}`)
  }
  return found
}
