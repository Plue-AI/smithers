/**
 * The closed vocabulary of host operations the permission kernel authorizes.
 *
 * @since 0.1.0
 */
import { Schema } from "effect"

/**
 * Schema for host operations that the permission kernel can authorize.
 *
 * @since 0.1.0
 * @category schemas
 * @slop
 */
export const Action = Schema.Literals(
  [
    "fs:read",
    "fs:write",
    "net:get",
    "net:post",
    "model:call",
    "memory:read",
    "memory:write",
    "proc:spawn",
    "jj:status",
    "jj:diff",
    "jj:snapshot",
    "jj:restore",
    "jj:workspace-add",
    "jj:workspace-forget",
    "jj:root",
    "jj:revert",
    "jj:op-restore"
  ] as const
)

/**
 * A host operation that the permission kernel can authorize.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export type Action = typeof Action.Type
