/**
 * Effect-tier classification of an exact capability, with lexical workspace
 * containment for file writes.
 *
 * @since 0.1.0
 */

import type { EffectTier } from "./EffectTier.ts"
import type { Capability } from "./ExactCapability.ts"
import type { TierOptions } from "./TierOptions.ts"

const lexicalPath = (path: string): string => {
  const absolute = path.startsWith("/")
  const prefix = absolute ? "/" : ""
  const segments: Array<string> = []
  for (const segment of path.slice(prefix.length).split("/")) {
    if (segment === "" || segment === ".") {
      continue
    }
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop()
      } else if (!absolute) {
        segments.push(segment)
      }
    } else {
      segments.push(segment)
    }
  }
  return `${prefix}${segments.join("/")}` || "."
}

const isAbsolutePath = (path: string): boolean => path.startsWith("/")

/**
 * A resource that another host's path resolver would root elsewhere: a drive
 * letter (`C:`), any backslash (`\\host\share`, `\Windows`, `a\..\..\x`), or a
 * leading `~` that a shell or adapter may expand. POSIX lexical containment
 * cannot vouch for it, so it is never inside the workspace.
 */
const isForeignRooted = (resource: string): boolean =>
  /^[A-Za-z]:/.test(resource) || resource.startsWith("~") || resource.includes("\\")

const isInsideWorkspace = (resource: string, workspaceRoot: string): boolean => {
  const root = lexicalPath(workspaceRoot)
  if (root === "." || isForeignRooted(resource)) {
    return false
  }
  const resolved = lexicalPath(
    isAbsolutePath(resource) ? resource : `${root}/${resource}`
  )
  const prefix = root.endsWith("/") ? root : `${root}/`
  if (resolved === root) {
    return true
  }
  if (!resolved.startsWith(prefix)) {
    return false
  }
  // A relative root keeps its leading `..` segments, so a textual prefix match
  // is not containment: `../../x` starts with `../` yet escapes the root `..`.
  const remainder = resolved.slice(prefix.length)
  return remainder !== ".." && !remainder.startsWith("../")
}

/**
 * Determines the effect tier for an exact capability.
 *
 * Workspace containment is lexical, so symlinks are invisible. A caller that
 * materializes workspace snapshots must resolve real paths before classifying
 * a write. A resource with a drive letter, a backslash, or a leading `~` is
 * never inside the workspace, so it classifies as `irreversible`.
 *
 * @since 0.1.0
 * @category predicates
 * @slop
 */
export const tierOf = (capability: Capability, options: TierOptions): EffectTier => {
  switch (capability.action) {
    case "memory:read":
    case "fs:read":
    case "net:get":
    case "model:call":
    case "jj:status":
    case "jj:diff":
    case "jj:root":
      return "sealed"
    case "fs:write":
      return isInsideWorkspace(capability.resource, options.workspaceRoot) ? "compensable" : "irreversible"
    case "jj:snapshot":
    case "jj:restore":
    case "jj:workspace-add":
    case "jj:workspace-forget":
    case "jj:revert":
    case "jj:op-restore":
      return "compensable"
    case "memory:write":
    case "net:post":
    case "proc:spawn":
      return "irreversible"
  }
}
