/**
 * Agent data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"

import type { CardCallbacks } from "./CardAction.ts"
import { ActorSchema } from "./CardPrimitives.ts"

/**
 * Agent projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const AgentCardSchema = z.object({
  name: z.string(),
  instructions_path: z.string(),
  role: z.enum(["fast", "coding", "jev"]),
  model: z.string(),
  available: z.array(
    z.object({ model: z.string(), price_in: z.number().nonnegative(), price_out: z.number().nonnegative() })
  ),
  runs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      state: z.enum(["queued", "running", "waiting", "held", "done", "failed", "cancelled"]),
      at: z.string()
    })
  ),
  changed: z.object({ from: z.string(), by: ActorSchema, at: z.string() }).optional()
})

/**
 * The value decoded by {@link AgentCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type AgentCard = z.infer<typeof AgentCardSchema>

/**
 * Typed catalog callbacks for Agent.
 * @since 1.0.0
 * @category models
 */
export type AgentCardCallbacks = CardCallbacks<"agent" | "file" | "todo.new">
