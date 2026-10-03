import type { BranchCard } from "../../src/BranchCard.ts"
import type { Action } from "../../src/CardAction.ts"
import {
  agent,
  at,
  claude_code,
  github_user,
  outside,
  person,
  ssh_person,
  reviewer,
  smithers_for_ben,
  system,
  will_person
} from "./_shared.ts"
import { type Story, story } from "./_story.ts"

const base: BranchCard = {
  id: "todo-12",
  name: "todo/12",
  item: { n: 12, title: "Card model contracts", state: "working", step: "Implement", place: 2 },
  machine: { state: "awake" },
  presence: [],
  terminals: [],
  activity: [],
  changed_files: [],
  ssh_line: "ssh -p 2222 todo-12@mac-mini.local"
}
const scratch: BranchCard = {
  ...base,
  id: "scratch-repro",
  name: "scratch/repro",
  item: undefined,
  scratch: { forked_from: { kind: "main" } },
  ssh_line: "ssh -p 2222 scratch-repro@mac-mini.local"
}
const fork: Action = { tag: "branch.fork", label: "Fork", args: { name: "todo/12" } }
const newTerminal: Action = { tag: "terminal", label: "New terminal", args: { branch: "todo/12" } }
const addToStack: Action = {
  tag: "branch.add-to-stack",
  label: "Add to stack",
  args: { branch: "scratch/repro" },
  input: [{ name: "text", label: "TODO", kind: "text", required: true }]
}
const steer: Action = {
  tag: "todo.steer",
  label: "Steer",
  args: { n: "12" },
  input: [{ name: "text", label: "Steer", kind: "text", required: true, multiline: true }]
}
const diff = (burst: string): Action => ({ tag: "diff", label: "Diff", args: { branch: "todo/12", burst } })

export const fixtures = {
  awake: story("Item branch, machine awake", base, {
    actions: [{ tag: "box.suspend", label: "Sleep", args: { branch: "todo/12" } }, fork, newTerminal, steer],
    expect: ["todo/12", "Card model contracts", "ssh -p 2222 todo-12@mac-mini.local"]
  }),
  asleep: story("Machine asleep", { ...base, machine: { state: "asleep" } }, {
    actions: [{ tag: "box.resume", label: "Wake", args: { branch: "todo/12" } }, fork],
    expect: ["todo/12"]
  }),
  waking: story("Machine waking", { ...base, machine: { state: "waking" } }, { expect: ["todo/12"] }),
  waiting: story("Waiting for a machine", { ...base, machine: { state: "waiting", position: 2 } }, {
    expect: ["todo/12"]
  }),
  closed: story(
    "Machine closed",
    { ...base, item: { ...base.item!, state: "merged", step: undefined }, machine: { state: "closed" } },
    { expect: ["Card model contracts"] }
  ),
  failed: story(
    "Machine failed to start",
    { ...base, machine: { state: "failed", error: { class: "machine_start", message: "Image build failed" } } },
    { actions: [{ tag: "box.resume", label: "Retry", args: { branch: "todo/12" } }], expect: ["Image build failed"] }
  ),
  rebase_pending: story("Rebase pending onto T8", { ...base, rebase: { state: "pending", onto: "T8" } }, {
    actions: [{ tag: "branch.rebase-now", label: "Rebase now", args: { branch: "todo/12" }, primary: true }],
    expect: ["T8"]
  }),
  rebase_waiting_for: story(
    "Rebase pending, waiting for a write in Ben's terminal",
    { ...base, rebase: { state: "pending", onto: "main", waiting_for: { actor: person, terminal: "terminal-1" } } },
    { expect: ["Ben"] }
  ),
  rebasing: story("Rebasing", { ...base, rebase: { state: "rebasing", onto: "T8" } }, { expect: ["T8"] }),
  scratch_conflict: story(
    "Scratch branch with a rebase conflict",
    { ...scratch, rebase: { state: "conflict", onto: "main", paths: ["packages/rpc/src/HomeCard.ts"] } },
    { actions: [{ tag: "terminal", label: "Resolve", args: { branch: "scratch/repro" } }, { tag: "branch.rebase", label: "Done", args: { branch: "scratch/repro", conflict_change: "conflict-1", onto_revision: "main-revision" }, disabled: { reason: "Unresolved paths" } }], expect: ["scratch/repro", "packages/rpc/src/HomeCard.ts"] }
  ),
  scratch_main: story("Scratch branch forked from main", scratch, {
    actions: [addToStack],
    expect: ["scratch/repro"]
  }),
  scratch_item: story(
    "Scratch branch forked from T12",
    { ...scratch, scratch: { forked_from: { kind: "item", n: 12, title: "Card model contracts" } } },
    { actions: [addToStack], expect: ["Card model contracts"] }
  ),
  scratch_branch: story(
    "Scratch branch forked from a branch",
    { ...scratch, name: "scratch/repro-2", scratch: { forked_from: { kind: "branch", name: "scratch/repro" } } },
    { actions: [addToStack], expect: ["scratch/repro-2", "scratch/repro"] }
  ),
  moved_off: story(
    "Moved off to T15",
    { ...base, moved_off: { by: person, item: 15 } },
    {
      actions: [
        { tag: "todo.return-to-item", label: "Return to T15", args: { n: "15" }, primary: true },
        { tag: "todo.keep-moved", label: "Keep for now", args: { n: "15" } }
      ],
      expect: ["Ben"]
    }
  ),
  queued_item: story("Queued item", { ...base, item: { ...base.item!, state: "queued", step: undefined } }, { expect: ["Card model contracts"] }),
  starting_item: story("Starting item", { ...base, item: { ...base.item!, state: "starting", step: undefined } }, { expect: ["Card model contracts"] }),
  needs_you_item: story("Item needs you", { ...base, item: { ...base.item!, state: "needs_you", step: undefined } }, { expect: ["Card model contracts"] }),
  paused_item: story("Paused item", { ...base, item: { ...base.item!, state: "paused", step: undefined } }, { expect: ["Card model contracts"] }),
  failed_item: story("Failed item", { ...base, item: { ...base.item!, state: "failed", step: undefined } }, { expect: ["Card model contracts"] }),
  review_item: story("Item in review", { ...base, item: { ...base.item!, state: "in_review", step: undefined } }, { expect: ["Card model contracts"] }),
  dropped_item: story("Dropped item", { ...base, item: { ...base.item!, state: "dropped", step: undefined } }, { expect: ["Card model contracts"] }),
  scratch_ready: story("Scratch conflict ready to finish", { ...scratch, rebase: { state: "conflict", onto: "main", paths: ["packages/rpc/src/HomeCard.ts"] } }, {
    actions: [{ tag: "branch.rebase", label: "Done", args: { branch: "scratch/repro", conflict_change: "conflict-1", onto_revision: "main-revision" } }], expect: ["packages/rpc/src/HomeCard.ts"]
  }),
  answered: story("Answer the coding agent", { ...base, presence: [{ actor: person, where: { kind: "branch" } }] }, {
    actions: [{ tag: "todo.answer", label: "Answer", args: { n: "12", wait: "question-1" }, primary: true, input: [{ name: "text", label: "Answer the coding agent", kind: "text", required: true }] }, steer], expect: ["todo/12"]
  }),
  active: story(
    "People and agents working together",
    {
      ...base,
      presence: [
        { actor: ssh_person, where: { kind: "file", path: "flows/todo/flow.ts", line: 12 }, watching: "terminal-2" },
        { actor: agent, where: { kind: "file", path: "packages/rpc/src/TodoCard.ts" } },
        { actor: claude_code, where: { kind: "terminal", id: "terminal-1" } },
        { actor: reviewer, where: { kind: "step", label: "Check" } },
        { actor: will_person, where: { kind: "branch" } }
      ],
      terminals: [
        {
          id: "terminal-1",
          title: "Checks",
          owner: person,
          agents: [claude_code],
          watchers: [will_person],
          command: "pnpm check",
          frozen: false
        },
        { id: "terminal-2", title: "Implement", owner: agent, agents: [], watchers: [person], frozen: true }
      ],
      activity: [
        {
          id: "a1",
          actor: agent,
          asked_by: person,
          kind: "step",
          text: "Implement card projections",
          at,
          actions: []
        },
        { id: "a2", actor: person, kind: "steer", text: "Include held merge steps", at, actions: [] },
        { id: "a3", actor: agent, kind: "question", text: "Include S3 fields?", at, actions: [] },
        { id: "a4", actor: person, kind: "answer", text: "Include them as optional", at, actions: [] },
        {
          id: "a5",
          actor: claude_code,
          asked_by: person,
          kind: "edit",
          text: "Updated TodoCard.ts",
          files: 1,
          at,
          actions: [diff("burst-5")]
        },
        {
          id: "a6",
          actor: outside,
          kind: "change",
          text: "Changed outside Smithers",
          files: 1,
          at,
          actions: [diff("burst-6")]
        },
        {
          id: "a7",
          actor: github_user,
          kind: "github",
          text: "Pushed a commit",
          files: 2,
          github: true,
          at,
          actions: []
        },
        { id: "a8", actor: system, kind: "rebase", text: "Rebased onto T8", files: 2, at, actions: [] },
        {
          id: "a9",
          actor: smithers_for_ben,
          kind: "read",
          text: "Read card contracts",
          items: ["packages/rpc/src/TodoCard.ts", "packages/rpc/src/HomeCard.ts"],
          at,
          actions: []
        },
        {
          id: "a10",
          actor: person,
          kind: "context",
          text: "Added context",
          items: ["#3474", "Factory decisions"],
          at,
          actions: []
        }
      ],
      changed_files: [
        { path: "packages/rpc/src/TodoCard.ts", change: "added", authors: [agent] },
        { path: "apps/app/src/mainview/cards/views/TodoView.tsx", change: "modified", authors: [person, claude_code] },
        { path: "apps/app/src/mainview/cards/LegacyTodo.tsx", change: "deleted", authors: [outside] },
        {
          path: "flows/todo/prompt.md",
          change: "renamed",
          renamed_to: "flows/todo/instructions/implementer.md",
          authors: [person, agent]
        }
      ]
    },
    {
      actions: [fork, newTerminal, steer],
      gestures: { file: { tag: "file", label: "Open file", args: { branch: "todo/12" } }, terminal: { tag: "terminal.watch", label: "Open terminal" }, item: { tag: "todo", label: "Open TODO" } },
      expect: ["Implement card projections", "Pushed a commit", "Checks", "flows/todo/instructions/implementer.md"]
    }
  )
} satisfies Record<string, Story<BranchCard>>
