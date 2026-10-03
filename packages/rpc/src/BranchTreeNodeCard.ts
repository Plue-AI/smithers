/**
 * BranchTreeNode data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActionSchema } from "./CardAction.ts"
import type { CardCallbacks } from "./CardAction.ts"
import { ActorSchema, TodoStateSchema } from "./CardPrimitives.ts"

/**
 * One node of the branch tree (ui-components.md T-UI-07, spec §14.1.1): open branches only, plus the single
 * read-only "earlier" node for legacy per-member conversations (§14.1.5). `present` holds people and agents (M-34).
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
  archive_count: z.number().int().nonnegative().optional(),
  action: ActionSchema.optional(),
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
