/**
 * Data fields accepted at the permission-error boundary.
 *
 * @since 1.0.0-rc.0
 */

import type { Capability } from "./Capability.ts"
import type { GrantStoreErrorCode, PermissionDenied, PermissionRequired } from "./Permission.ts"

/**
 * A structural permission failure, without Error, Effect, or schema-class
 * operations. Nested capabilities carry data only. The grant-store cause is
 * opaque operation context and is not validated recursively.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type PermissionErrorPayload =
  | (Pick<PermissionRequired, "_tag" | "code" | "requestId" | "runId" | "tier" | "meta"> & {
    readonly capability: Pick<Capability, "action" | "resource">
  })
  | (Pick<PermissionDenied, "_tag" | "code" | "reason"> & {
    readonly capability: Pick<Capability, "action" | "resource">
  })
  | {
    readonly _tag: "@smthrs/capability/GrantStoreError"
    readonly code: GrantStoreErrorCode
    readonly message?: string | undefined
    readonly cause?: unknown
  }
