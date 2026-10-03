/**
 * ActorChip data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActorSchema } from "./CardPrimitives.ts"

/**
 * ActorChip props from ui-components.md T-UI-01: the actor, the chip size, and `live` while the agent works now.
 * @since 1.0.0
 * @category schemas
 */
export const ActorChipCardSchema = z.object({
  actor: ActorSchema,
  size: z.enum(["s", "m"]),
  live: z.boolean().optional()
})

/**
 * The value decoded by {@link ActorChipCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type ActorChipCard = z.infer<typeof ActorChipCardSchema>
