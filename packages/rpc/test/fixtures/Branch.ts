import type { BranchCard } from "../../src/BranchCard.ts"
import { agent, at, outside, person, system } from "./_shared.ts"

const base: BranchCard = {
  id: "todo-12",
  name: "todo/12",
  item: { n: 12, place: 2, title: "Card model contracts", state: "working", step: "Implement" },
  scratch: false,
  machine: { state: "awake" },
  presence: [],
  terminals: [],
  activity: [],
  changed_files: [],
  ssh_line: "ssh -p 2222 todo-12@mac-mini.local"
}
export const fixtures = {
  awake: base,
  asleep: { ...base, machine: { state: "asleep" } },
  waking: { ...base, machine: { state: "waking" } },
  waiting: { ...base, machine: { state: "waiting", wait_position: 2 } },
  sleeping: { ...base, machine: { state: "sleeping" } },
  closed: { ...base, machine: { state: "closed" } },
  scratch: { ...base, id: "scratch-repro", name: "scratch/repro", item: undefined, scratch: true },
  rebase_main: { ...base, rebase_pending: { onto: "main" } },
  moved_off: { ...base, rebase_pending: { onto: 8 }, moved_off: { by: person, item: 15 } },
  active: {
    ...base,
    presence: [
      { actor: person, where: { kind: "file", path: "flows/todo/flow.ts", line: 12 }, watching: "terminal-1" },
      { actor: agent, where: { kind: "file", path: "packages/rpc/src/TodoCard.ts" } },
      { actor: system, where: { kind: "reading", label: "Factory decisions" } },
      { actor: person, where: { kind: "terminal", id: "terminal-1", title: "Checks", command: "pnpm check" } },
      { actor: agent, where: { kind: "step", step: "Implement" } },
      { actor: outside, where: { kind: "branch" } },
      { actor: system }
    ],
    terminals: [
      { id: "terminal-1", title: "Checks", owner: person, watchers: [agent], command: "pnpm check" },
      { id: "terminal-2", title: "Implement", owner: agent, watchers: [] }
    ],
    activity: [
      {
        id: "a1",
        actor: agent,
        asked_by: person,
        kind: "step",
        text: "Implement card projections",
        files: 2,
        github: false,
        tone: "live",
        at
      },
      { id: "a2", actor: person, kind: "steer", text: "Include held merge steps", at },
      { id: "a3", actor: agent, kind: "question", text: "Include S3 fields?", at },
      { id: "a4", actor: person, kind: "answer", text: "Include them as optional", at },
      { id: "a5", actor: agent, kind: "edit", text: "Updated TodoCard.ts", files: 1, at },
      { id: "a6", actor: outside, kind: "change", text: "Changed outside Smithers", files: 1, at },
      {
        id: "a7",
        actor: { kind: "github", login: "ben", color_index: 3 },
        kind: "change",
        text: "Pushed a commit",
        files: 2,
        github: true,
        at
      },
      { id: "a8", actor: system, kind: "rebase", text: "Rebased on T8", files: 2, at },
      {
        id: "a9",
        actor: person,
        kind: "read",
        text: "Read card contracts",
        items: [{ kind: "file", label: "TodoCard.ts", ref: "packages/rpc/src/TodoCard.ts", revision: "head" }],
        at
      },
      {
        id: "a10",
        actor: person,
        kind: "context",
        text: "Added acceptance",
        items: [{ kind: "issue", label: "#3474", ref: "https://github.com/smithersai/smithers/issues/3474" }],
        at
      }
    ],
    changed_files: [
      { path: "packages/rpc/src/TodoCard.ts", authors: [agent], change: "added" },
      { path: "apps/app/src/mainview/cards/TodoView.tsx", authors: [person], change: "modified" },
      { path: "apps/app/src/mainview/cards/LegacyTodo.tsx", authors: [outside], change: "deleted" },
      {
        path: "flows/todo/prompt.md",
        authors: [person, agent],
        change: "renamed",
        renamed_to: "flows/todo/instructions/implementer.md"
      }
    ]
  }
} satisfies Record<string, BranchCard>
