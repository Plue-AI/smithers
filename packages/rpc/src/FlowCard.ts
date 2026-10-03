/**
 * Flow data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"

import type { CardCallbacks } from "./CardAction.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * Flow projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const FlowCardSchema = z.object({
  name: z.string(),
  system: z.boolean().optional(),
  source: z.union([z.object({ builtin: z.literal(true) }), z.object({ path: z.string() })]),
  versions: z.array(z.object({
    id: z.string(),
    state: z.enum(["active", "proposed", "merged_syncing", "merged_failed", "previous"]),
    todo: z.number().int().positive().optional(),
    error: z.string().optional(),
    pr: z.object({ number: z.number().int().positive(), url: HttpUrlSchema }).optional(),
    steps: z.array(
      z.union([
        z.object({
          id: z.string().refine((id) => id !== "merge"),
          label: z.string(),
          detail: z.string().optional(),
          agent: z.object({ name: z.string(), model: z.string() }).optional()
        }),
        z.object({
          id: z.literal("merge"),
          wait: z.literal(true),
          signals: z.array(z.object({ on: z.enum(["rebase", "steer"]), to: z.string() }))
        })
      ])
    )
  }))
})

/**
 * The value decoded by {@link FlowCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type FlowCard = z.infer<typeof FlowCardSchema>

/**
 * Typed catalog callbacks for Flow.
 * @since 1.0.0
 * @category models
 */
export type FlowCardCallbacks = CardCallbacks<"flow.source" | "flow.plan" | "flow.run" | "flow.edit">
