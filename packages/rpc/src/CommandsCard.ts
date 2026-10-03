/**
 * Commands data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks } from "./CardAction.ts"
import { CatalogTagSchema } from "./catalog/index.ts"

/**
 * Commands projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const CommandsCardSchema = z.object({
  groups: z.array(
    z.object({
      label: z.string(),
      advanced: z.boolean(),
      commands: z.array(
        z.object({ tag: CatalogTagSchema, title: z.string() })
      )
    })
  )
})

/**
 * The value decoded by {@link CommandsCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type CommandsCard = z.infer<typeof CommandsCardSchema>

/**
 * Typed catalog callbacks for Commands.
 * @since 1.0.0
 * @category models
 */
export type CommandsCardCallbacks = CardCallbacks<"help">
