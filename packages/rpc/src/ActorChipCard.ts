/**
 * ActorChip data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActorSchema } from "./CardPrimitives.ts"

/**
 * ActorChip projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const ActorChipCardSchema = z.object({ actor: ActorSchema, size: z.enum(["s", "m"]), live: z.boolean() })

/**
 * The value decoded by {@link ActorChipCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type ActorChipCard = z.infer<typeof ActorChipCardSchema>
