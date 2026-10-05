/**
 * Flow data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"

/**
 * Flow projection fields from spec §14.3 and ui-components.md T-UI-10. The TODO flow's trailing merge wait carries
 * its signals: rebase → check, steer → implement (spec §10.4.1). `system` is separate from `source`: the install's
 * built-in TODO flow is overridable, and only a system flow (spec §11.1.1) refuses Edit and Source.
 * @since 1.0.0
 * @category schemas
 */
export const FlowCardSchema = z.object({
  name: z.string(),
  source: z.union([z.object({ builtin: z.literal(true) }), z.object({ path: z.string() })]),
  system: z.boolean(),
  versions: z.array(z.object({
    id: z.string(),
    state: z.enum(["active", "proposed", "merged-syncing", "merged-failed", "previous"]),
    todo: z.number().int().positive().optional(),
    error: z.string().optional(),
    steps: z.array(
      z.union([
        z.object({
          id: z.string().refine((id) => id !== "merge"),
          label: z.string(),
          detail: z.string().optional(),
          agent: z.string().optional(),
          added: z.boolean().optional()
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
 * The Flow View's props (ui-components.md T-UI-10).
 * @since 1.0.0
 * @category models
 */
export type FlowViewProps = CardProps<FlowCard>

/**
 * Typed catalog callbacks for Flow.
 * @since 1.0.0
 * @category models
 */
export type FlowCardCallbacks = CardCallbacks<"flow.source" | "flow.plan" | "flow.run" | "flow.edit">
