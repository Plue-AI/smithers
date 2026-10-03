/**
 * Agent data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { ModelRoleIdSchema } from "./CardPrimitives.ts"

/**
 * Agent projection fields from spec §14.3 and ui-components.md v0.4 (T-UI-13): a factory agent's instructions,
 * model role (shown as "Fast model", "Coding model" or "Decisions", mvp.md §6.5), model and the owner's choices, and the
 * runs it took part in.
 * @since 1.0.0
 * @category schemas
 */
export const AgentCardSchema = z.object({
  name: z.string(),
  instructions_path: z.string(),
  role: ModelRoleIdSchema,
  model: z.string(),
  provider: z.string(),
  available: z.array(z.string()),
  runs: z.array(z.object({ id: z.string(), title: z.string(), state: z.string(), at: z.string() })),
  owner: z.boolean()
})

/**
 * The value decoded by {@link AgentCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type AgentCard = z.infer<typeof AgentCardSchema>

/**
 * The Agent View's props (ui-components.md T-UI-13).
 * @since 1.0.0
 * @category models
 */
export type AgentViewProps = CardProps<AgentCard>

/**
 * Typed catalog callbacks for Agent.
 * @since 1.0.0
 * @category models
 */
export type AgentCardCallbacks = CardCallbacks<"settings.model.set" | "run">
