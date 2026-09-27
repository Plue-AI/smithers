/**
 * Shared catalog failure vocabulary.
 *
 * @since 1.0.0
 */

import * as Schema from "effect/Schema"

/**
 * Catalog failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export const RunCatalogErrorCode = Schema.Literals([
  "invalid_options",
  "list_failed",
  "invalid_cursor",
  "source_changed"
])
/**
 * Catalog failure codes.
 *
 * @category models
 * @since 0.1.0
 */
export type RunCatalogErrorCode = typeof RunCatalogErrorCode.Type
/**
 * Catalog read failure retaining its original cause.
 *
 * @category errors
 * @since 0.1.0
 */
export class RunCatalogError extends Schema.TaggedError<RunCatalogError>()(
  "@smthrs/engine-store/RunCatalogError",
  { code: RunCatalogErrorCode, message: Schema.String, cause: Schema.optional(Schema.Unknown) }
) {}
