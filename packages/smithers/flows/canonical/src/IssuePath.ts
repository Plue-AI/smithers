/** Bounded paths for schema failures at durable boundaries.
 * @since 1.0.0
 */

import type * as Schema from "effect/Schema"
import type * as SchemaIssue from "effect/SchemaIssue"

const renderPath = (segments: ReadonlyArray<PropertyKey>): string =>
  segments.reduce<string>(
    (path, segment) => path + (typeof segment === "number" ? `[${segment}]` : `.${String(segment)}`),
    "$"
  )

/**
 * Finds the first rejected field in an Effect schema error without rendering
 * the value stored at that field.
 *
 * @category formatting
 * @since 0.1.0
 */
export const firstPath = (error: Schema.SchemaError): string => {
  const segments: Array<PropertyKey> = []
  let issue: SchemaIssue.Issue = error.issue
  for (let depth = 0; depth < 64; depth++) {
    switch (issue._tag) {
      case "Pointer":
        segments.push(...issue.path)
        issue = issue.issue
        continue
      case "Filter":
      case "Encoding":
        issue = issue.issue
        continue
      case "Composite":
      case "AnyOf": {
        const first = issue.issues[0]
        if (first === undefined) return renderPath(segments)
        issue = first
        continue
      }
      default:
        return renderPath(segments)
    }
  }
  return renderPath(segments)
}
