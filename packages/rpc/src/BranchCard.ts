/** Props-only Branch contract; HTTP/storage decoding belongs to T-APP-10. */
import { z } from "zod"
import type { Action, CardCallbacks, CardProps } from "./CardAction.ts"
import type { Actor, MachineState, TodoState } from "./CardPrimitives.ts"

/**
 * Branch facts supplied by the container (spec §14.3).
 * @since 1.0.0
 * @category models
 */
export interface BranchCard {
  id: string
  name: string
  item?: { n: number; title: string; state: TodoState; step?: string; place: number }
  scratch?: { forked_from: { kind: "main" } | { kind: "item"; n: number; title: string } | { kind: "branch"; name: string } }
  machine: MachineState
  rebase?:
    | { state: "pending"; onto: string; waiting_for?: { actor: Actor; terminal: string } }
    | { state: "rebasing"; onto: string }
    | { state: "conflict"; onto: string; paths: string[] }
  moved_off?: { by: Actor; item: number }
  presence: { actor: Actor; where:
    | { kind: "file"; path: string; line?: number }
    | { kind: "terminal"; id: string }
    | { kind: "step"; label: string }
    | { kind: "branch" }; watching?: string }[]
  terminals: { id: string; title: string; owner: Actor; agents: Actor[]; watchers: Actor[]; command?: string; frozen: boolean }[]
  activity: {
    id: string
    actor: Actor
    asked_by?: Actor
    kind: "step" | "steer" | "question" | "answer" | "edit" | "change" | "github" | "rebase" | "read" | "context"
    text: string
    items?: string[]
    files?: number
    github?: boolean
    at: string
    actions: Action[]
  }[]
  changed_files: { path: string; change: "added" | "modified" | "deleted" | "renamed"; renamed_to?: string; authors: Actor[] }[]
  ssh_line: string
}

/**
 * Supplied actions and per-member tabs; no runtime or presence state.
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

/**
 * Authenticated participant attribution; identity never grants permission.
 * @since 1.0.0
 * @category schemas
 */
export const BranchParticipant = z.strictObject({
  id: z.string().min(1),
  kind: z.enum(["person", "smithers", "coding", "claude-code", "codex", "reviewer", "outside"]),
  member_id: z.string().min(1).optional(),
  for_member: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  via: z.enum(["app", "ssh", "terminal", "tool"])
})
/** @since 1.0.0 @category models */
export type BranchParticipant = z.infer<typeof BranchParticipant>

/** Branch subscription names on the shared live channel.
 * @since 1.0.0
 * @category schemas
 */
export const BranchTopic = z.string().regex(/^branch:[^:\s/\\\u0000]+(?::(?:files|activity))?$/)

/** Durable change entry, separate from the card's rendered conversation activity.
 * @since 1.0.0
 * @category schemas
 */
export const BranchActivityEntry = z.strictObject({
  id: z.string().min(1),
  at: z.iso.datetime(),
  kind: z.enum(["write", "burst", "doc_edit", "rebase", "moved_off"]),
  actor: BranchParticipant,
  files: z.array(z.strictObject({
    path: z.string().min(1).refine(value =>
      !/[\\\u0000]/.test(value) && value.split("/").every(part => part !== "" && part !== "." && part !== "..")),
    change: z.enum(["added", "modified", "deleted", "renamed"]),
    before_blob: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional(),
    after_blob: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional()
  })),
  versions: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/).optional()
})
/** @since 1.0.0 @category models */
export type BranchActivityEntry = z.infer<typeof BranchActivityEntry>
