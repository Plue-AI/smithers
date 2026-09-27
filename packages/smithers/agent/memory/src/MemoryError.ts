/**
 * Stable memory failures.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Stable codes returned by memory operations.
 *
 * @category models
 * @since 0.1.0
 */
export const MemoryErrorCode = Schema.Literals([
  "not_found",
  "fts_not_enabled",
  "invalid_namespace",
  "invalid_tag",
  "invalid_argument",
  "supersede_conflict",
  "idempotency_conflict",
  "compaction_conflict",
  "embedding_unavailable",
  "vector_model_mismatch",
  "store"
])

/**
 * Stable memory failure code.
 *
 * @category models
 * @since 0.1.0
 */
export type MemoryErrorCode = typeof MemoryErrorCode.Type

/**
 * Error raised by memory validation, storage, search, or projection.
 *
 * @category errors
 * @since 0.1.0
 */
export class MemoryError extends Schema.TaggedError<MemoryError>()("flows/memory/MemoryError", {
  code: MemoryErrorCode,
  message: Schema.String,
  path: Schema.optional(Schema.Array(Schema.String)),
  cause: Schema.optional(Schema.Defect())
}) {}
