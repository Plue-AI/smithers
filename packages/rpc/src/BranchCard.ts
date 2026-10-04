/** Props-only Branch contract; HTTP/storage decoding belongs to T-APP-10. */
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
