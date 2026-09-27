/**
 * The union of every failure the capability kernel adds to a guarded call.
 *
 * @since 0.1.0
 */

import { Schema } from "effect"
import { GrantStoreError } from "./GrantStoreError.ts"
import { PermissionDenied } from "./PermissionDenied.ts"
import { PermissionRequired } from "./PermissionRequired.ts"

/**
 * Every failure the capability kernel can add to a guarded Host call.
 *
 * A protected service names this union in its own interface, so a caller that
 * holds the service cannot forget that an operation may be suspended, denied,
 * or left undecided by a broken grant store.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type PermissionError = PermissionRequired | PermissionDenied | GrantStoreError

/**
 * Schema for every failure the capability kernel adds to a guarded Host call.
 *
 * @category schemas
 * @since 0.1.0
 * @slop
 */
export const PermissionError = Schema.Union([PermissionRequired, PermissionDenied, GrantStoreError])
