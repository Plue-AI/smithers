/**
 * Terminal data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { ActorSchema } from "./CardPrimitives.ts"

/**
 * Terminal projection fields from spec §14.3 and ui-components.md T-UI-17. `agents` are the agents working in it,
 * such as Claude Code for Ben (M-34); `frozen` shows "Rebasing…" while a rebase freezes it (§9.4.2).
 * @since 1.0.0
 * @category schemas
 */
export const TerminalCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  branch: z.string(),
  owner: ActorSchema,
  agents: z.array(ActorSchema),
  watchers: z.array(ActorSchema),
  command: z.string().optional(),
  viewer_is_owner: z.boolean(),
  frozen: z.boolean()
})

/**
 * The value decoded by {@link TerminalCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type TerminalCard = z.infer<typeof TerminalCardSchema>

/**
 * The Terminal View's props (ui-components.md T-UI-17).
 * @since 1.0.0
 * @category models
 */
export type TerminalViewProps = CardProps<TerminalCard>

/**
 * Typed catalog callbacks for Terminal.
 * @since 1.0.0
 * @category models
 */
export type TerminalCardCallbacks = CardCallbacks<"terminal" | "terminal.watch">
