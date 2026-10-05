/**
 * Todo data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActionSchema } from "./CardAction.ts"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import {
  ActorSchema,
  EvidenceSchema,
  MachineStateSchema,
  MergeSchema,
  NeedsYouKindSchema,
  PersonRefSchema,
  QueueSchema,
  RebasePendingSchema,
  TodoStateSchema
} from "./CardPrimitives.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * One open wait for a person (spec §10.8.0). Waits are independent: settling one never settles another, and each
 * carries its own action (§4.1.0a).
 * @since 1.0.0
 * @category schemas
 */
export const TodoWaitSchema = z.object({
  id: z.string(),
  kind: NeedsYouKindSchema,
  prompt: z.string(),
  since: z.string(),
  paths: z.array(z.string()).optional(),
  ssh_line: z.string().optional(),
  by: ActorSchema.optional(),
  sha: z.string().optional(),
  actions: z.array(ActionSchema)
})

/**
 * The value decoded by {@link TodoWaitSchema}.
 * @since 1.0.0
 * @category models
 */
export type TodoWait = z.infer<typeof TodoWaitSchema>

/**
 * Todo projection fields from spec §14.3 and ui-components.md. `owner_removed` offers Take over (§5.6);
 * `failure.missing_tool` offers Add to machine image (§8.6.2). `pause` says why a paused TODO waits: a person's
 * Stop, or the daily token budget with the install owner ("Paused · daily token budget · <owner>", §15.2.2).
 * @since 1.0.0
 * @category schemas
 */
export const TodoCardSchema = z.object({
  n: z.number().int().positive(),
  title: z.string(),
  state: TodoStateSchema,
  owner: PersonRefSchema,
  owner_removed: z.boolean().optional(),
  place: z.number().int().positive().optional(),
  queue: QueueSchema.optional(),
  pause: z.object({
    reason: z.enum(["person", "daily_token_budget"]),
    owner: PersonRefSchema.optional(),
    since: z.string(),
    resume_at: z.string().optional()
  }).optional(),
  rebase_pending: RebasePendingSchema.optional(),
  step: z.string().optional(),
  prompt_revisions: z.array(
    z.object({ text: z.string(), acceptance: z.array(z.string()), context: z.string().optional(), by: ActorSchema, at: z.string() })
  ),
  issue: z.object({ number: z.number().int().positive(), url: HttpUrlSchema, fixes: z.boolean() }).optional(),
  branch: z.object({ id: z.string(), name: z.string(), machine: MachineStateSchema }).optional(),
  steps: z.array(
    z.union([
      z.object({
        id: z.string().refine((id) => id !== "merge"),
        label: z.string(),
        detail: z.string().optional(),
        state: z.enum(["done", "current", "next", "failed", "waiting", "paused"])
      }),
      z.object({
        id: z.literal("merge"),
        kind: z.literal("wait"),
        state: z.enum(["held", "done", "next"]),
        since: z.string().optional()
      })
    ])
  ),
  run: z.object({
    id: z.string(),
    attempt: z.number().int().positive(),
    indicators: z.array(z.object({ tone: z.enum(["wait", "thrash"]), text: z.string() }))
  }).optional(),
  waits: z.array(TodoWaitSchema),
  first_answer: z.object({ by: ActorSchema, text: z.string(), at: z.string() }).optional(),
  steers: z.array(z.object({ text: z.string(), by: ActorSchema, at: z.string() })),
  failure: z.object({
    step: z.string(),
    class: z.string(),
    message: z.string(),
    retryable: z.boolean(),
    missing_tool: z.object({ name: z.string(), file: z.string() }).optional()
  }).optional(),
  evidence: z.array(EvidenceSchema),
  pr: z.object({
    number: z.number().int().positive(),
    url: HttpUrlSchema,
    head: z.string(),
    draft: z.boolean(),
    draft_after: z.number().int().positive().optional(),
    included_items: z.array(z.number().int().positive())
  }).optional(),
  merged_via: z.number().int().positive().optional(),
  merge: MergeSchema,
  lessons: z.number().int().nonnegative().optional(),
  approval_cleared: z.boolean().optional(),
  present: z.array(ActorSchema)
})

/**
 * The value decoded by {@link TodoCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type TodoCard = z.infer<typeof TodoCardSchema>

/**
 * The TODO View's props (ui-components.md T-UI-04).
 * @since 1.0.0
 * @category models
 */
export type TodoViewProps = CardProps<TodoCard>

/**
 * Typed catalog callbacks for Todo.
 * @since 1.0.0
 * @category models
 */
export type TodoCardCallbacks = CardCallbacks<
  | "todo.answer"
  | "todo.steer"
  | "todo.stop"
  | "todo.resume"
  | "todo.retry"
  | "todo.drop"
  | "todo.amend"
  | "merge"
  | "branch"
  | "branch.fork"
  | "branch.add-to-stack"
  | "branch.rebase"
  | "branch.bring-in"
  | "branch.discard-foreign"
  | "todo.return-to-item"
  | "todo.keep-moved"
  | "todo.retry-current-flow"
  | "todo.takeover"
  | "order.ok"
>
