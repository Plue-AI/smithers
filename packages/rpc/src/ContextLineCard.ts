/**
 * ContextLine data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ContextItemSchema } from "./CardPrimitives.ts"

/**
 * ContextLine projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const ContextLineCardSchema = z.object({
  count: z.number().int().nonnegative(),
  items: z.array(ContextItemSchema),
  expanded: z.boolean()
})

/**
 * The value decoded by {@link ContextLineCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type ContextLineCard = z.infer<typeof ContextLineCardSchema>
