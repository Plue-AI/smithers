/**
 * Stable trigger failures.
 *
 * @see packages/smithers/agent/triggers/docs/api.md
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Stable trigger failure codes.
 *
 * Each code names one refusal a caller can branch on. `store` covers only a
 * persistence failure the store itself raised; a Control or runner failure is
 * `runner`, a malformed scheduler option is `invalid_options`, and a claim
 * refused by the durable declaration is `unknown_trigger`, `trigger_disabled`,
 * or `revision_mismatch`.
 *
 * @category models
 * @since 0.1.0
 */
export const TriggerErrorCode = Schema.Literals([
  "unknown_trigger",
  "trigger_disabled",
  "revision_mismatch",
  "stale_owner",
  "invalid_schedule",
  "invalid_trigger",
  "invalid_options",
  "invalid_cron",
  "unsatisfiable_cron",
  "verification_failed",
  "catch_up_bound_exceeded",
  "runner",
  "runner_timeout",
  "store"
])

/**
 * Stable trigger failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type TriggerErrorCode = typeof TriggerErrorCode.Type

/**
 * A typed schedule, verification, or persistence failure.
 *
 * `path` is the dotted field path a declaration failure belongs to, so a
 * caller reads the offending field structurally instead of parsing `message`.
 *
 * @category errors
 * @since 0.1.0
 */
export class TriggerError extends Schema.TaggedError<TriggerError>()("flows/triggers/TriggerError", {
  code: TriggerErrorCode,
  message: Schema.String,
  path: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * Walks a schema issue tree for the path of the first offending value.
 *
 * The tree is read defensively: only `path`, `issue`, and `issues` are
 * consulted, so an issue shape this function does not recognize degrades to
 * "no path" rather than throwing inside an error constructor.
 */
const issuePath = (issue: unknown): ReadonlyArray<string> | undefined => {
  if (typeof issue !== "object" || issue === null) return undefined
  const node = issue as {
    readonly path?: unknown
    readonly issue?: unknown
    readonly issues?: unknown
  }
  const segments = Array.isArray(node.path) ? node.path.map((segment) => String(segment)) : []
  const children = Array.isArray(node.issues)
    ? node.issues
    : node.issue === undefined
    ? []
    : [node.issue]
  for (const child of children) {
    const nested = issuePath(child)
    if (nested !== undefined) return [...segments, ...nested]
  }
  return segments.length === 0 ? undefined : segments
}

/**
 * Renders a schema decode failure as one line, without the offending value.
 *
 * The rendered issue tree names the expectation and the path only, which is
 * what makes it safe to keep in `message` and in `cause`: a secret submitted
 * in the declaration never reaches either.
 */
const summarize = (error: unknown): string =>
  String(error)
    .replace(/^SchemaError\(/, "")
    .replace(/\)$/, "")
    .replace(/\s*\n\s*/g, " ")
    .trim()

/**
 * Builds a declaration failure that names the offending field.
 *
 * The whole `SchemaError` is deliberately not kept as the cause: serializing
 * one costs about five kilobytes of schema AST per failure, and every byte of
 * it past the rendered issue tree repeats what the tree already says.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromSchemaError = (
  code: TriggerErrorCode,
  summary: string,
  error: unknown
): TriggerError => {
  const path = issuePath((error as { readonly issue?: unknown } | null)?.issue)
  const detail = summarize(error)
  const field = path === undefined ? undefined : path.join(".")
  return new TriggerError({
    code,
    message: field === undefined ? `${summary}: ${detail}` : `${summary} at ${field}: ${detail}`,
    ...(field === undefined ? {} : { path: field }),
    cause: detail
  })
}
