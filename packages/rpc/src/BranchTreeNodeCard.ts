/**
 * BranchTreeNode data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks } from "./CardAction.ts"
import { ActorSchema, TodoStateSchema } from "./CardPrimitives.ts"

/**
 * BranchTreeNode projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const BranchTreeNodeCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["main", "item", "scratch", "earlier"]),
  todo: z.number().int().positive().optional(),
  state: TodoStateSchema.optional(),
  present: z.array(ActorSchema),
  get children() {
    return z.array(BranchTreeNodeCardSchema)
  }
})

/**
 * The value decoded by {@link BranchTreeNodeCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type BranchTreeNodeCard = z.infer<typeof BranchTreeNodeCardSchema>

/**
 * Typed catalog callbacks for BranchTreeNode.
 * @since 1.0.0
 * @category models
 */
export type BranchTreeNodeCardCallbacks = CardCallbacks<"branch">
