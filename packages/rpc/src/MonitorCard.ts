/**
 * Monitor data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks } from "./CardAction.ts"
import { ActorSchema, PhaseToneSchema } from "./CardPrimitives.ts"

const RunStateSchema = z.enum(["running", "waiting", "held", "failed", "done", "interrupted"])
const GraphStateSchema = z.enum(["done", "current", "waiting", "failed", "next", "held"])
/**
 * Monitor projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const MonitorCardSchema = z.object({
  id: z.string(),
  title: z.string(),
  todo: z.number().int().positive().optional(),
  branch: z.string().optional(),
  flow: z.string(),
  version: z.string(),
  state: RunStateSchema,
  held: z.object({ since: z.string() }).optional(),
  attempts: z.array(z.object({
    n: z.number().int().positive(),
    state: RunStateSchema,
    graph: z.array(z.object({ id: z.string(), label: z.string(), state: GraphStateSchema, deps: z.array(z.string()) })),
    steps: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        state: GraphStateSchema,
        started_at: z.string().optional(),
        ended_at: z.string().optional(),
        input: z.array(z.object({ name: z.string(), value: z.unknown() })).optional(),
        output: z.array(z.object({ name: z.string(), value: z.unknown() })).optional(),
        agent: z.object({ name: z.string(), model: z.string() }).optional()
      })
    ),
    phases: z.array(
      z.object({
        id: z.string(),
        step: z.string(),
        title: z.string(),
        summary: z.string().optional(),
        took_s: z.number().nonnegative(),
        tone: PhaseToneSchema,
        indicator: z.string().optional(),
        cells: z.array(z.object({
          id: z.string(),
          kind: z.enum(["context", "read", "edit", "run", "think", "ask", "answer", "steer", "reviewer", "rebase"]),
          label: z.string(),
          explain: z.string().optional(),
          code: z.string().optional(),
          output: z.string().optional(),
          quote: z.string().optional(),
          tone: PhaseToneSchema.optional(),
          took_s: z.number().nonnegative().optional(),
          tokens: z.number().int().nonnegative().optional(),
          actor: ActorSchema.optional()
        }))
      })
    )
  })),
  waits: z.array(z.object({ id: z.string(), label: z.string(), since: z.string() })),
  tokens: z.number().int().nonnegative(),
  time_s: z.number().nonnegative(),
  cost_usd: z.number().nonnegative()
})

/**
 * The value decoded by {@link MonitorCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type MonitorCard = z.infer<typeof MonitorCardSchema>

/**
 * Typed catalog callbacks for Monitor.
 * @since 1.0.0
 * @category models
 */
export type MonitorCardCallbacks = CardCallbacks<"run" | "run.inspect" | "monitor">
