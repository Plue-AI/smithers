/**
 * TODOs (spec §2, §4.1, §6.3, §14.3): one stack item with its own number
 * `T<n>`, append-only prompt revisions and a stored state. The backend's
 * `/api/todos` routes and the `todo:<n>` and `home` live topics carry the
 * {@link TodoSchema} REST API resource. A create answers `202` with
 * `{state: "requested"}`: the request is persisted, and the TODO's states
 * arrive afterwards, each only once its event is committed.
 *
 * @since 1.0.0
 */

import { z } from "zod"
import { NeedsYouKindSchema, QueueSchema, TodoStateSchema } from "./CardPrimitives.ts"
export { TodoStateSchema } from "./CardPrimitives.ts"

/**
 * The TODO routes. An install serves one repository, so they name none; a
 * server with several stacks takes `?repo=owner/name` on the list and the
 * create.
 *
 * @since 1.0.0
 * @category constants
 */
export const TODO_ROUTES = {
  /** `GET`: {@link TodoListSchema}. `POST`: {@link TodoCreateSchema} with an `Idempotency-Key` header; answers {@link TodoCreateAnswerSchema}. */
  todos: "/api/todos",
  /** `GET`: one {@link TodoSchema} with its revisions; `{n}` is `12` or `T12`. */
  todo: "/api/todos/{n}",
  /** `GET`: {@link BranchActivityListSchema}, the branch's newest entries, oldest first. */
  activity: "/api/branches/{b}/activity"
} as const

/**
 * The decoded value accepted by {@link TodoStateSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TodoState = z.infer<typeof TodoStateSchema>

/**
 * Who caused a change (spec §2): a member, optionally through an agent
 * (`via`); the coding agent of a run; or the stack engine (`system`).
 *
 * @since 1.0.0
 * @category schemas
 */
export const ActorRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("person"),
    id: z.number().int(),
    via: z.string().optional(),
    session: z.string().optional()
  }).strict(),
  z.object({
    kind: z.literal("agent"),
    agent: z.string(),
    run: z.string(),
    todo: z.number().int().positive().optional()
  }).strict(),
  z.object({ kind: z.literal("system"), name: z.string() }).strict()
])

/**
 * A failed TODO's typed failure.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TodoFailureSchema = z.object({
  step: z.string(),
  class: z.string(),
  message: z.string(),
  retryable: z.boolean()
})

/**
 * One prompt revision; revision 1 is the original, each amend appends one.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TodoRevisionSchema = z.object({
  rev: z.number().int().positive(),
  prompt: z.string(),
  acceptance: z.string().optional(),
  reason: z.enum(["create", "amend", "from-issue"]),
  author: ActorRefSchema,
  at: z.string()
})

/**
 * The REST /todos API resource, distinct from TodoCard (spec §14.3). `place` is the 1-based position among
 * the unmerged TODOs; `seq` is the TODO's last committed event.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TodoSchema = z.object({
  n: z.number().int().positive(),
  title: z.string(),
  state: TodoStateSchema,
  state_reason: z.string().optional(),
  owner: z.number().int().optional(),
  place: z.number().int().positive().optional(),
  queue: QueueSchema.optional(),
  step: z.string().optional(),
  needs_you: z.object({
    kind: NeedsYouKindSchema,
    prompt: z.string().optional(),
    since: z.string().optional(),
    run_wait_id: z.string().optional()
  })
    .optional(),
  failure: TodoFailureSchema.optional(),
  pr: z.object({ number: z.number().int().positive() }).optional(),
  amendments: z.number().int().nonnegative(),
  lessons: z.number().int().nonnegative(),
  branch: z.object({ id: z.string(), name: z.string() }),
  issue: z.object({ number: z.number().int().positive(), fixes: z.boolean() }).optional(),
  created_by: ActorRefSchema,
  seq: z.number().int().nonnegative(),
  revisions: z.array(TodoRevisionSchema).optional(),
  created_at: z.string(),
  updated_at: z.string()
})

/**
 * The decoded value accepted by {@link TodoSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Todo = z.infer<typeof TodoSchema>

/**
 * `POST /api/todos`: a TODO placed at the end of the stack. `prompt` defaults
 * to the title; `place` is `append` until before and amend arrive.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TodoCreateSchema = z.object({
  title: z.string().min(1).max(256),
  prompt: z.string().optional(),
  acceptance: z.string().optional(),
  place: z.literal("append").optional()
})

/**
 * The decoded value accepted by {@link TodoCreateSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TodoCreate = z.infer<typeof TodoCreateSchema>

/**
 * `POST /api/todos`'s answer: persisted, not started (spec §6.2.2).
 *
 * @since 1.0.0
 * @category schemas
 */
export const TodoCreateAnswerSchema = z.object({
  state: z.literal("requested"),
  todo: TodoSchema
})

/**
 * `GET /api/todos`'s answer: the stack in order, then merged and dropped.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TodoListSchema = z.object({
  todos: z.array(TodoSchema)
})

/**
 * One branch activity entry (spec §3, §7.2).
 *
 * @since 1.0.0
 * @category schemas
 */
export const ActivityEntrySchema = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  actor: ActorRefSchema,
  asked_by: ActorRefSchema.optional(),
  kind: z.enum(["step", "steer", "question", "answer", "edit", "change", "github", "rebase"]),
  summary: z.record(z.string(), z.unknown()),
  github: z.boolean().optional()
})

/**
 * `GET /api/branches/{b}/activity`'s answer.
 *
 * @since 1.0.0
 * @category schemas
 */
export const BranchActivityListSchema = z.object({
  entries: z.array(ActivityEntrySchema)
})

/**
 * A TODO's name in product words: `T12`.
 *
 * @since 1.0.0
 * @category accessors
 */
export const todoName = (n: number): string => `T${n}`

/**
 * Reads a TODO reference, `12` or `T12`, as its number.
 *
 * @since 1.0.0
 * @category accessors
 */
export const parseTodoRef = (ref: string): number | undefined => {
  const match = /^[Tt]?([1-9][0-9]*)$/.exec(ref.trim())
  if (match === null) return undefined
  const n = Number(match[1])
  return Number.isSafeInteger(n) ? n : undefined
}

/**
 * The route of one TODO.
 *
 * @since 1.0.0
 * @category accessors
 */
export const todoRoute = (n: number): string => TODO_ROUTES.todo.replace("{n}", String(n))
