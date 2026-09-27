/**
 * Flow naming: how a discovered source path becomes the owned flow name a
 * registry entry is addressed by.
 *
 * @since 0.1.0
 */

import * as Markdown from "@smthrs/core/Markdown"
import * as Option from "effect/Option"
import type { DiscoveryWarning } from "../Descriptor.ts"

/**
 * Derives an owned flow name from directory segments relative to its source root.
 *
 * @since 0.1.0
 * @category naming
 */
export const deriveFromPath = (segments: ReadonlyArray<string>): Option.Option<string> =>
  segments.length === 0 ? Option.none() : Option.some(segments.join("/"))

/**
 * Derives a foreign skill name from frontmatter, with the directory name as a
 * compatibility fallback.
 *
 * @since 0.1.0
 * @category naming
 */
export const deriveFromFrontmatter = (
  options: { readonly fields: Record<string, unknown>; readonly dirBasename: string; readonly path: string }
): { readonly name: string; readonly warnings: ReadonlyArray<DiscoveryWarning> } => {
  if (!Object.hasOwn(options.fields, "name")) {
    return {
      name: options.dirBasename,
      warnings: [{
        code: "missing_name",
        path: options.path,
        name: options.dirBasename,
        message: "Frontmatter name is missing; using the directory name instead"
      }]
    }
  }

  const value = options.fields.name
  if (typeof value === "string" && value.trim().length > 0) {
    const name = value.trim()
    const warnings: Array<DiscoveryWarning> = []
    if (!Markdown.isSkillName(name)) {
      warnings.push({
        code: "invalid_name",
        path: options.path,
        name,
        message:
          "Frontmatter name must be 1-64 lowercase ASCII letters, numbers, or single hyphens with no edge hyphens"
      })
    }
    if (name !== options.dirBasename) {
      warnings.push({
        code: "directory_name_mismatch",
        path: options.path,
        name,
        message: `Frontmatter name "${name}" does not match skill directory "${options.dirBasename}"`
      })
    }
    return { name, warnings }
  }

  return {
    name: options.dirBasename,
    warnings: [{
      code: "invalid_name",
      path: options.path,
      name: options.dirBasename,
      message: "Ignoring an invalid frontmatter name; using the directory name instead"
    }]
  }
}
