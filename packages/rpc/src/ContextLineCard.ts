/**
 * ContextLine data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ContextItemSchema } from "./CardPrimitives.ts"

/**
 * The Context line of an entry (ui-components.md T-UI-07, spec §15.1.2): the count, the items and whether this
 * member expanded it.
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

/**
 * The ContextLine View's props: expanding is `onView({ expanded })` (ui-components.md T-UI-07).
 * @since 1.0.0
 * @category models
 */
export type ContextLineProps = ContextLineCard & { readonly onView: (patch: { readonly expanded: boolean }) => void }
