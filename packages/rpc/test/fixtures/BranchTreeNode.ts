import type { BranchTreeNodeCard } from "../../src/BranchTreeNodeCard.ts"
import { agent, claude_code, person, smithers } from "./_shared.ts"
import { type Story, story } from "./_story.ts"

const scratch: BranchTreeNodeCard = {
  id: "scratch-repro",
  name: "scratch/repro",
  kind: "scratch",
  present: [claude_code],
  children: [],
  // A node with an action opens through it (data-flow); one without emits onView({ selected_branch }).
  action: { tag: "branch", label: "Open", args: { name: "scratch/repro" } }
}
// "Earlier · N": the read-only archive node carries its archive count (C-UI-12).
const earlier: BranchTreeNodeCard = {
  id: "earlier",
  name: "Earlier",
  kind: "earlier",
  present: [],
  children: [],
  archive_count: 3
}
const item: BranchTreeNodeCard = {
  id: "todo-12",
  name: "todo/12",
  kind: "item",
  todo: 12,
  state: "working",
  present: [person, agent],
  children: [scratch]
}
export const fixtures = {
  main: story(
    "main with an item, a scratch branch and Earlier",
    { id: "main", name: "main", kind: "main", present: [smithers], children: [item, earlier] },
    { expect: ["main", "todo/12", "scratch/repro", "Earlier"] }
  ),
  item: story("An item in review", { ...item, state: "in_review", present: [person], children: [] }, {
    expect: ["todo/12"]
  }),
  scratch: story("A scratch branch", scratch, { expect: ["scratch/repro"] }),
  earlier: story("Earlier", earlier, { expect: ["Earlier", "3"] })
} satisfies Record<string, Story<BranchTreeNodeCard>>
