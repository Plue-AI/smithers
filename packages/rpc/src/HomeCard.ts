/**
 * Home data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActionSchema } from "./CardAction.ts"
import type { CardCallbacks } from "./CardAction.ts"
import {
  ActorSchema,
  BranchRefSchema,
  MergeSchema,
  NeedsYouKindSchema,
  PersonRefSchema,
  QueueSchema,
  RebasePendingSchema,
  TodoStateSchema
} from "./CardPrimitives.ts"

/**
 * Home projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const HomeCardSchema = z.object({
  repository: z.string(),
  main: z.object({
    sha: z.string(),
    title: z.string(),
    last_success_at: z.string(),
    health: z.enum(["fresh", "stale", "refused", "limited"]),
    cause: z.string().optional(),
    retry_at: z.string().optional()
  }),
  attention: z.array(
    z.object({
      kind: z.enum(["order", "force_push"]),
      text: z.string(),
      todo: z.number().int().positive().optional()
    })
  ),
  items: z.array(z.object({
    n: z.number().int().positive(),
    title: z.string(),
    state: TodoStateSchema,
    place: z.number().int().positive(),
    queue: QueueSchema.optional(),
    step: z.string().optional(),
    needs_you: z.object({ kind: NeedsYouKindSchema }).optional(),
    merge: MergeSchema,
    rebase_pending: RebasePendingSchema.optional(),
    pr: z.object({ number: z.number().int().positive(), draft: z.boolean() }).optional(),
    approval_cleared: z.boolean().optional(),
    amendments: z.number().int().nonnegative(),
    branch: BranchRefSchema,
    present: z.array(ActorSchema),
    elapsed_s: z.number().nonnegative(),
    actions: z.array(ActionSchema)
  })),
  counts: z.record(TodoStateSchema, z.number().int().nonnegative()),
  merged_since_last_look: z.array(z.number().int().positive()),
  machines: z.object({
    in_use: z.number().int().nonnegative(),
    capacity: z.number().int().nonnegative(),
    slots: z.array(z.object({ branch: z.string(), actor: ActorSchema, awake: z.boolean() }))
  }),
  background_runs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      state: z.enum(["queued", "running", "waiting", "failed"]),
      detail: z.string().optional()
    })
  )
})

/**
 * The value decoded by {@link HomeCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type HomeCard = z.infer<typeof HomeCardSchema>

/**
 * Typed catalog callbacks for Home.
 * @since 1.0.0
 * @category models
 */
export type HomeCardCallbacks = CardCallbacks<
  | "github"
  | "stack.move"
  | "todo"
  | "todo.answer"
  | "todo.retry"
  | "merge"
  | "order.ok"
  | "background.retry"
  | "background.dismiss"
  | "main.reset-to-github"
>
