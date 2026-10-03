/**
 * Branch data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import { ActionSchema } from "./CardAction.ts"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { ActorSchema, MachineStateSchema, TodoStateSchema } from "./CardPrimitives.ts"

/**
 * Branch projection fields from spec §14.3 and ui-components.md T-UI-15. Presence, terminals and activity hold
 * people and agents alike (M-34).
 * @since 1.0.0
 * @category schemas
 */
export const BranchCardSchema = z.object({
  id: z.string(),
  name: z.string(),
  item: z.object({
    n: z.number().int().positive(),
    title: z.string(),
    state: TodoStateSchema,
    step: z.string().optional(),
    place: z.number().int().positive()
  }).optional(),
  scratch: z.object({
    forked_from: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("main") }),
      z.object({ kind: z.literal("item"), n: z.number().int().positive(), title: z.string() }),
      z.object({ kind: z.literal("branch"), name: z.string() })
    ])
  }).optional(),
  machine: MachineStateSchema,
  rebase: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("pending"),
      onto: z.string(),
      waiting_for: z.object({ actor: ActorSchema, terminal: z.string() }).optional()
    }),
    z.object({ state: z.literal("rebasing"), onto: z.string() }),
    z.object({ state: z.literal("conflict"), onto: z.string(), paths: z.array(z.string()) })
  ]).optional(),
  moved_off: z.object({ by: ActorSchema, item: z.number().int().positive() }).optional(),
  presence: z.array(
    z.object({
      actor: ActorSchema,
      where: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("file"), path: z.string(), line: z.number().int().positive().optional() }),
        z.object({ kind: z.literal("terminal"), id: z.string() }),
        z.object({ kind: z.literal("step"), label: z.string() }),
        z.object({ kind: z.literal("branch") })
      ]),
      watching: z.string().optional()
    })
  ),
  terminals: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      owner: ActorSchema,
      agents: z.array(ActorSchema),
      watchers: z.array(ActorSchema),
      command: z.string().optional(),
      frozen: z.boolean()
    })
  ),
  activity: z.array(z.object({
    id: z.string(),
    actor: ActorSchema,
    asked_by: ActorSchema.optional(),
    kind: z.enum(["step", "steer", "question", "answer", "edit", "change", "github", "rebase", "read", "context"]),
    text: z.string(),
    items: z.array(z.string()).optional(),
    files: z.number().int().nonnegative().optional(),
    github: z.boolean().optional(),
    at: z.string(),
    actions: z.array(ActionSchema)
  })),
  changed_files: z.array(
    z.object({
      path: z.string(),
      change: z.enum(["added", "modified", "deleted", "renamed"]),
      renamed_to: z.string().optional(),
      authors: z.array(ActorSchema)
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
 * The Branch View's props (ui-components.md T-UI-15).
 * @since 1.0.0
 * @category models
 */
export type BranchViewProps = CardProps<BranchCard, {}, "item" | "file" | "terminal">

/**
 * Typed catalog callbacks for Branch.
 * @since 1.0.0
 * @category models
 */
export type BranchCardCallbacks = CardCallbacks<
  | "box.suspend"
  | "box.resume"
  | "branch"
  | "branch.fork"
  | "branch.rebase"
  | "branch.rebase-now"
  | "branch.add-to-stack"
  | "branch.bring-in"
  | "branch.discard-foreign"
  | "todo.return-to-item"
  | "todo.keep-moved"
  | "todo.steer"
  | "todo.answer"
  | "terminal"
  | "terminal.watch"
  | "diff"
  | "ssh"
>
