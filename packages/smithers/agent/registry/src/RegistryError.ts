/**
 * Typed registry failures, shaped after `effect/PlatformError`.
 *
 * Codes are a stable public contract: callers branch on them and UIs map them
 * to remediation. Never repurpose a code; add one.
 *
 * Governing contract: `packages/smithers/agent/registry/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/registry.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"

/**
 * Stable reasons a source scan can fail.
 *
 * @category models
 * @since 0.1.0
 */
export const DiscoveryErrorCode = Schema.Literals(["root_missing", "read_failed", "invalid_root", "unknown"])

/**
 * Stable reasons a source scan can fail.
 *
 * @category models
 * @since 0.1.0
 */
export type DiscoveryErrorCode = typeof DiscoveryErrorCode.Type

/**
 * A failure while discovering entries in one registry source.
 *
 * @category errors
 * @since 0.1.0
 */
export class DiscoveryError extends Schema.TaggedError<DiscoveryError>()("flows/registry/DiscoveryError", {
  code: DiscoveryErrorCode,
  module: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * Stable reasons registry construction, lookup, or prompt rendering can fail.
 *
 * @category models
 * @since 0.1.0
 */
export const RegistryErrorCode = Schema.Literals([
  "not_found",
  "system_collision",
  "body_unavailable",
  "execution_changed",
  "not_prompt_flow",
  "invalid_pack",
  "incompatible_pack",
  "unreadable_pack_range",
  "unknown"
])

/**
 * Stable reasons registry construction, lookup, or prompt rendering can fail.
 *
 * @category models
 * @since 0.1.0
 */
export type RegistryErrorCode = typeof RegistryErrorCode.Type

/**
 * A failure while constructing, looking up, loading, or rendering a registry
 * entry.
 *
 * @category errors
 * @since 0.1.0
 */
export class RegistryError extends Schema.TaggedError<RegistryError>()("flows/registry/RegistryError", {
  code: RegistryErrorCode,
  module: Schema.optional(Schema.String),
  method: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * Every failure the Registry layer is allowed to surface.
 *
 * @category models
 * @since 0.1.0
 */
export type RegistryFailure = DiscoveryError | RegistryError

const format = (code: string, module: string, method: string, description?: string): string =>
  `${code}: ${module}.${method}${description ? `: ${description}` : ""}`

/**
 * Creates a `DiscoveryError` from a failed source-discovery operation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const discoveryError = (options: {
  readonly code: DiscoveryErrorCode
  readonly module?: string | undefined
  readonly method: string
  readonly path?: string | undefined
  readonly description?: string | undefined
  readonly cause?: unknown
}): DiscoveryError => {
  const module = options.module ?? "Discovery"
  const reason = typeof options.cause === "object" && options.cause !== null && "reason" in options.cause
    ? options.cause.reason
    : undefined
  const detail = typeof reason === "object" && reason !== null && "description" in reason &&
      typeof reason.description === "string" && /smithers-jj-export is (?:missing|unusable)/.test(reason.description)
    ? reason.description
    : undefined
  return new DiscoveryError({
    code: options.code,
    module,
    method: options.method,
    path: options.path,
    message: `${format(options.code, module, options.method, options.description)}${
      detail === undefined ? "" : `: ${detail}`
    }`,
    cause: options.cause
  })
}

/**
 * Creates a `RegistryError` from a failed registry operation.
 *
 * @category constructors
 * @since 0.1.0
 */
export const registryError = (options: {
  readonly code: RegistryErrorCode
  readonly module?: string | undefined
  readonly method: string
  readonly path?: string | undefined
  readonly description?: string | undefined
  readonly cause?: unknown
}): RegistryError => {
  const module = options.module ?? "Registry"
  return new RegistryError({
    code: options.code,
    module,
    method: options.method,
    path: options.path,
    message: format(options.code, module, options.method, options.description),
    cause: options.cause
  })
}
