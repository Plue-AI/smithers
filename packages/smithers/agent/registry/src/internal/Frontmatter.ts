/**
 * YAML frontmatter parsing for markdown flow sources. Split out so the
 * fence handling for BOM, CRLF, and an unterminated document is stated once and
 * tested directly.
 *
 * @since 0.1.0
 */

import { splitFrontmatter as split } from "@smthrs/core/Markdown"
import type * as Schema from "effect/Schema"
import * as Yaml from "yaml"
import type { DiscoveryWarning } from "../Descriptor.ts"

const openingFence = /^(?:\uFEFF)?---(?:\r?\n|$)/
const maximumParseIssues = 3

const emptyFields = (): Record<string, Schema.Json> => Object.freeze(Object.create(null) as Record<string, Schema.Json>)

/**
 * Separates a leading YAML frontmatter document from its markdown body.
 *
 * @since 0.1.0
 * @category parsing
 */
export { splitFrontmatter as split } from "@smthrs/core/Markdown"

/**
 * Returns whether a source prefix contains all leading frontmatter metadata.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isMetadataComplete = (text: string): boolean => {
  const source = text.replace(/^\uFEFF/, "")
  if (source.length < 3) {
    return false
  }
  if (!source.startsWith("---")) {
    return true
  }
  const opening = openingFence.exec(source)
  if (opening === null) {
    return source.includes("\n")
  }
  return split(source).frontmatter !== undefined
}

/**
 * Parses a leading YAML frontmatter document without allowing malformed input
 * to interrupt discovery. The returned record has a null prototype, and every
 * object and array in its graph is frozen. An inherited field can therefore
 * never be observed as frontmatter metadata.
 *
 * @since 0.1.0
 * @category parsing
 */
export const parse = (
  options: { readonly text: string; readonly path: string }
): { readonly fields: Record<string, Schema.Json>; readonly warnings: ReadonlyArray<DiscoveryWarning> } => {
  const { frontmatter } = split(options.text)
  if (frontmatter === undefined || frontmatter.trim() === "") {
    return { fields: emptyFields(), warnings: [] }
  }

  try {
    const parsed = Yaml.parseDocument(frontmatter, { schema: "failsafe" })
    if (parsed.errors.length > 0) {
      return {
        fields: emptyFields(),
        warnings: parsed.errors
          .slice(0, maximumParseIssues)
          .map((issue) => frontmatterIssue(options.path, issue))
      }
    }
    const document = parsed.toJS() as unknown
    if (typeof document !== "object" || document === null || Array.isArray(document)) {
      return {
        fields: emptyFields(),
        warnings: [frontmatterParseError(options.path, "Frontmatter must be a YAML object")]
      }
    }
    const sanitized = sanitizeJson(document, new WeakSet())
    return {
      fields: sanitized.value as Record<string, Schema.Json>,
      warnings: sanitized.changed
        ? [{
          code: "non_serializable_frontmatter",
          path: options.path,
          message: "Non-serializable frontmatter values were replaced with null"
        }]
        : []
    }
  } catch {
    return {
      fields: emptyFields(),
      warnings: [frontmatterParseError(
        options.path,
        "Could not parse frontmatter (YAML_PARSE_ERROR) at line 1, column 1"
      )]
    }
  }
}

const sanitizeJson = (
  value: unknown,
  ancestors: WeakSet<object>
): { readonly value: Schema.Json; readonly changed: boolean } => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return { value, changed: false }
  }
  if (typeof value !== "object") {
    return { value: null, changed: true }
  }
  if (ancestors.has(value)) {
    return { value: null, changed: true }
  }

  ancestors.add(value)
  let changed = false
  if (Array.isArray(value)) {
    const result = value.map((item) => {
      const sanitized = sanitizeJson(item, ancestors)
      changed ||= sanitized.changed
      return sanitized.value
    })
    ancestors.delete(value)
    return { value: Object.freeze(result), changed }
  }

  const result = Object.create(null) as Record<string, Schema.Json>
  for (const [key, item] of Object.entries(value)) {
    const sanitized = sanitizeJson(item, ancestors)
    changed ||= sanitized.changed
    Object.defineProperty(result, key, {
      value: sanitized.value,
      writable: true,
      enumerable: true,
      configurable: true
    })
  }
  ancestors.delete(value)
  return { value: Object.freeze(result), changed }
}

const frontmatterIssue = (
  path: string,
  issue: { readonly linePos?: ReadonlyArray<{ readonly line: number; readonly col: number }> }
): DiscoveryWarning => {
  const position = issue.linePos![0]!
  const line = Math.max(1, Math.min(999_999, position.line))
  const column = Math.max(1, Math.min(999_999, position.col))
  return frontmatterParseError(
    path,
    `Could not parse frontmatter at line ${line}, column ${column}`
  )
}

const frontmatterParseError = (path: string, message: string): DiscoveryWarning => ({
  code: "frontmatter_parse_error",
  path,
  message
})
