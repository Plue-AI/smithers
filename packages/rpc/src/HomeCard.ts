/**
 * Home data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActionSchema } from "./CardAction.ts"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { ActorSchema, NeedsYouKindSchema, SyncHealthSchema, TodoStateSchema } from "./CardPrimitives.ts"
import { TodoCardSchema } from "./TodoCard.ts"

/**
 * One stack row: the TODO fields Home shares with the TODO card (ui-components.md T-UI-06 `Pick<TodoModel, …>`),
 * plus the row's own fields.
 * @since 1.0.0
 * @category schemas
 */
export const HomeItemSchema = TodoCardSchema.pick({
  n: true,
  title: true,
  state: true,
  owner: true,
  place: true,
  queue: true,
  step: true,
  rebase_pending: true,
  merge: true,
  approval_cleared: true,
  lessons: true
}).extend({
  needs_you: z.object({ kind: NeedsYouKindSchema, prompt: z.string() }).optional(),
  pr: z.object({ number: z.number().int().positive(), draft: z.boolean() }).optional(),
  branch: z.object({ id: z.string(), name: z.string() }),
  present: z.array(ActorSchema),
  elapsed_s: z.number().nonnegative().optional(),
  amendments: z.number().int().nonnegative(),
  actions: z.array(ActionSchema)
})

/**
 * The value decoded by {@link HomeItemSchema}.
 * @since 1.0.0
 * @category models
 */
export type HomeItem = z.infer<typeof HomeItemSchema>

/**
 * Home projection fields from spec §14.3 and ui-components.md T-UI-06.
 * @since 1.0.0
 * @category schemas
 */
export const HomeCardSchema = z.object({
  repository: z.string(),
  main: z.object({
    sha: z.string(),
    title: z.string(),
    last_success_at: z.string(),
    health: SyncHealthSchema,
    cause: z.string().optional(),
    retry_at: z.string().optional()
  }),
  attention: z.array(
    z.object({
      kind: z.enum(["order", "force_push"]),
      text: z.string(),
      todo: z.number().int().positive().optional(),
      actions: z.array(ActionSchema)
    })
  ),
  items: z.array(HomeItemSchema),
  counts: z.record(TodoStateSchema, z.number().int().nonnegative()),
  merged_since_last_look: z.array(z.number().int().positive()),
  machines: z.object({
    in_use: z.number().int().nonnegative(),
    capacity: z.number().int().nonnegative(),
    slots: z.array(z.object({ branch: z.string(), actor: ActorSchema, awake: z.boolean() }))
  }),
  parallel: z.number().int().positive().optional(),
  background_runs: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      state: z.enum(["queued", "running", "waiting", "failed"]),
      detail: z.string().optional(),
      actions: z.array(ActionSchema)
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
 * Home's own view state: whether the card is on screen.
 * @since 1.0.0
 * @category models
 */
export interface HomeViewState {
  readonly on_screen?: boolean
}

/**
 * The Home View's props (ui-components.md T-UI-06). The View reports `onView({ on_screen })` from an
 * IntersectionObserver; the Container advances last look after 2 s on screen (C-J4-01).
 * @since 1.0.0
 * @category models
 */
export type HomeViewProps = CardProps<HomeCard, HomeViewState>

/**
 * Typed catalog callbacks for Home.
 * @since 1.0.0
 * @category models
 */
export type HomeCardCallbacks = CardCallbacks<
  | "github"
  | "settings"
  | "todo.new"
  | "stack.move"
  | "todo"
  | "todo.answer"
  | "todo.retry"
  | "todo.drop"
  | "branch"
  | "merge"
  | "order.ok"
  | "background.retry"
  | "background.dismiss"
  | "main.reset-to-github"
>
