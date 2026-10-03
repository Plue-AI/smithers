/**
 * Commands data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { CatalogTagSchema } from "./catalog/index.ts"

/**
 * Commands projection fields from spec §14.3 and ui-components.md v0.4 (T-UI-14): the `/help` groups filtered for
 * the viewer's role. `synopsis` and `description` are the Appendix A command and its line; `agent` is whether an
 * agent may run it, must confirm it, or never may.
 * @since 1.0.0
 * @category schemas
 */
export const CommandsCardSchema = z.object({
  groups: z.array(
    z.object({
      label: z.string(),
      advanced: z.boolean(),
      commands: z.array(
        z.object({
          tag: CatalogTagSchema,
          synopsis: z.string(),
          description: z.string(),
          agent: z.enum(["run", "confirm", "never"])
        })
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
 * The Commands View's props (ui-components.md T-UI-14).
 * @since 1.0.0
 * @category models
 */
export type CommandsViewProps = CardProps<CommandsCard>

/**
 * Typed catalog callbacks for Commands.
 * @since 1.0.0
 * @category models
 */
export type CommandsCardCallbacks = CardCallbacks<"help">
