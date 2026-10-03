/**
 * Terminal data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks } from "./CardAction.ts"
import { ActorSchema, PersonRefSchema } from "./CardPrimitives.ts"

/**
 * Terminal projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const TerminalCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  branch: z.string(),
  offer: z.string().optional(),
  owner: ActorSchema,
  watchers: z.array(PersonRefSchema),
  command: z.string().optional(),
  viewer_is_owner: z.boolean()
})

/**
 * The value decoded by {@link TerminalCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type TerminalCard = z.infer<typeof TerminalCardSchema>

/**
 * Typed catalog callbacks for Terminal.
 * @since 1.0.0
 * @category models
 */
export type TerminalCardCallbacks = CardCallbacks<"terminal" | "terminal.watch">
