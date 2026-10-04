/**
 * Run (monitor and Inspect) data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { ActorSchema, PhaseToneSchema } from "./CardPrimitives.ts"

/**
 * A run's or an attempt's state; `held` is the trailing wait for merge.
 * @since 1.0.0
 * @category schemas
 */
export const RunStateSchema = z.enum(["running", "waiting", "held", "failed", "done", "interrupted"])

/**
 * A graph node's state.
 * @since 1.0.0
 * @category schemas
 */
export const RunGraphStateSchema = z.enum(["done", "current", "waiting", "failed", "next", "held"])

/**
 * What a monitor cell records.
 * @since 1.0.0
 * @category schemas
 */
export const RunCellKindSchema = z.enum([
  "context",
  "read",
  "edit",
  "run",
  "think",
  "ask",
  "answer",
  "steer",
  "reviewer",
  "rebase"
])

/**
 * Why a run waits (spec §14.3 Run).
 * @since 1.0.0
 * @category schemas
 */
export const RunWaitKindSchema = z.enum(["question", "approval", "pause", "sleep", "signal", "external_job"])

/**
 * One execution of a flow step: the `k`-th run of step `id` in its attempt, keyed `"<step id>#<k>"`.
 * Usage is absent for a step with no model call (C-J11-01).
 * @since 1.0.0
 * @category schemas
 */
export const RunStepSchema = z.object({
  key: z.string(),
  id: z.string(),
  k: z.number().int().positive(),
  label: z.string(),
  state: z.string(),
  started_at: z.string().optional(),
  ended_at: z.string().optional(),
  took_s: z.number().nonnegative().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  agent: ActorSchema.optional(),
  usage: z.object({ tokens: z.number().int().nonnegative(), cost_usd: z.number().nonnegative() }).optional()
}).refine((step) => step.key === `${step.id}#${step.k}`, { message: "key must be <step id>#<k>", path: ["key"] })

/**
 * Run projection fields from spec §14.3 and ui-components.md T-UI-12. Phase titles and cell labels are
 * deterministic; `summary` and `explain` are optional `agent:fast` lines (§11.6.3). The journal is loaded when
 * `view.tab` is "journal"; `replay` re-projects the run at journal seq `at` and writes nothing (§11.6.2).
 * @since 1.0.0
 * @category schemas
 */
export const MonitorCardSchema = z.object({
  id: z.string(),
  flow: z.string(),
  version: z.string(),
  title: z.string(),
  todo: z.number().int().positive().optional(),
  branch: z.string().optional(),
  state: RunStateSchema,
  held: z.object({ since: z.string() }).optional(),
  attempts: z.array(z.object({
    n: z.number().int().positive(),
    run_id: z.string(),
    state: RunStateSchema,
    graph: z.array(
      z.object({ id: z.string(), label: z.string(), state: RunGraphStateSchema, deps: z.array(z.string()) })
    ),
    steps: z.array(RunStepSchema),
    phases: z.array(z.object({
      id: z.string(),
      step: z.string(),
      title: z.string(),
      summary: z.string().optional(),
      took_s: z.number().nonnegative(),
      tone: PhaseToneSchema,
      indicator: z.string().optional(),
      cells: z.array(z.object({
        id: z.string(),
        kind: RunCellKindSchema,
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
    }))
  })),
  waits: z.array(z.object({
    id: z.string(),
    kind: RunWaitKindSchema,
    label: z.string(),
    since: z.string(),
    settled: z.object({ by: ActorSchema, at: z.string() }).optional()
  })),
  tokens: z.number().int().nonnegative(),
  time_s: z.number().nonnegative(),
  cost_usd: z.number().nonnegative(),
  engine: z.array(z.object({ label: z.string(), detail: z.string() })),
  journal: z.array(z.object({
    seq: z.number().int().nonnegative(),
    at: z.string(),
    type: z.string(),
    step: z.string().optional(),
    text: z.string()
  })).optional(),
  replay: z.object({ at: z.number().int().nonnegative(), last: z.number().int().nonnegative() })
    .refine((replay) => replay.at <= replay.last, { message: "replay.at is at most replay.last", path: ["at"] })
    .optional()
})

/**
 * The value decoded by {@link MonitorCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type MonitorCard = z.infer<typeof MonitorCardSchema>

/**
 * The Run card's per-member view state: the selected cell id and the scrubber position.
 * @since 1.0.0
 * @category models
 */
export interface RunView {
  readonly selected?: string
  readonly at?: number
}

/**
 * The Run View's props. The flow's declared custom view (§11.6.2) is a separate rendered React slot, `custom`,
 * that the Container passes beside these props; it is not data and has no schema.
 * @since 1.0.0
 * @category models
 */
export type RunViewProps = CardProps<MonitorCard, RunView>

/**
 * Typed catalog callbacks for Run: Inspect, Steer, Stop and Retry.
 * @since 1.0.0
 * @category models
 */
export type MonitorCardCallbacks = CardCallbacks<
  "run" | "run.inspect" | "monitor" | "todo.steer" | "todo.stop" | "todo.retry" | "background.retry"
>
