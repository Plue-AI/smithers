/**
 * The stable code vocabulary a grant-store failure carries.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"

/**
 * Stable grant-store failure codes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const GrantStoreErrorCode = Schema.Literals([
  "duplicate_request",
  "request_not_found",
  "journal_failed",
  "store_closed",
  "invalid_resolution"
])

/**
 * Stable grant-store failure codes.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type GrantStoreErrorCode = typeof GrantStoreErrorCode.Type
