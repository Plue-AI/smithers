/**
 * Branch data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks } from "./CardAction.ts"
import { ActorSchema, ContextItemSchema, TodoStateSchema, ToneSchema } from "./CardPrimitives.ts"

/**
 * Branch projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const BranchCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  item: z.object({
    n: z.number().int().positive(),
    place: z.number().int().positive(),
    title: z.string(),
    state: TodoStateSchema,
    step: z.string().optional()
  }).optional(),
  scratch: z.boolean(),
  machine: z.object({
    state: z.enum(["asleep", "waking", "awake", "sleeping", "waiting", "closed"]),
    wait_position: z.number().int().positive().optional()
  }),
  rebase_pending: z.object({ onto: z.union([z.literal("main"), z.number().int().positive()]) }).optional(),
  moved_off: z.object({ by: ActorSchema, item: z.number().int().positive() }).optional(),
  presence: z.array(
    z.object({
      actor: ActorSchema,
      where: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("file"), path: z.string(), line: z.number().int().positive().optional() }),
        z.object({ kind: z.literal("reading"), label: z.string() }),
        z.object({ kind: z.literal("terminal"), id: z.string(), title: z.string(), command: z.string().optional() }),
        z.object({ kind: z.literal("step"), step: z.string() }),
        z.object({ kind: z.literal("branch") })
      ]).optional(),
      watching: z.string().optional()
    })
  ),
  terminals: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      owner: ActorSchema,
      watchers: z.array(ActorSchema),
      command: z.string().optional()
    })
  ),
  activity: z.array(z.object({
    id: z.string(),
    actor: ActorSchema,
    asked_by: ActorSchema.optional(),
    kind: z.enum(["step", "steer", "question", "answer", "edit", "change", "rebase", "read", "context"]),
    text: z.string(),
    items: z.array(ContextItemSchema).optional(),
    files: z.number().int().nonnegative().optional(),
    tone: ToneSchema.optional(),
    github: z.boolean().optional(),
    at: z.string()
  })),
  changed_files: z.array(
    z.object({
      path: z.string(),
      authors: z.array(ActorSchema),
      change: z.enum(["added", "modified", "deleted", "renamed"]),
      renamed_to: z.string().optional()
    })
  ),
  ssh_line: z.string()
})

/**
 * The value decoded by {@link BranchCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type BranchCard = z.infer<typeof BranchCardSchema>

/**
 * Typed catalog callbacks for Branch.
 * @since 1.0.0
 * @category models
 */
export type BranchCardCallbacks = CardCallbacks<
  | "branch"
  | "branch.fork"
  | "branch.rebase"
  | "branch.rebase-now"
  | "branch.add-to-stack"
  | "branch.bring-in"
  | "branch.discard-foreign"
  | "todo.return-to-item"
  | "todo.keep-moved"
  | "ssh"
>
