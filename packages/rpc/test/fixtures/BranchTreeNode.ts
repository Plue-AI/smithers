import type { BranchTreeNodeCard } from "../../src/BranchTreeNodeCard.ts"
import { agent, person, system } from "./_shared.ts"

export const fixtures = {
  main: {
    id: "main",
    name: "main",
    kind: "main",
    present: [system],
    children: [{
      id: "todo-12",
      name: "todo/12",
      kind: "item",
      todo: 12,
      state: "working",
      present: [person, agent],
      children: [{ id: "scratch-repro", name: "scratch/repro", kind: "scratch", present: [], children: [] }]
    }, { id: "earlier", name: "Earlier", kind: "earlier", present: [], children: [] }]
  },
  item: { id: "todo-12", name: "todo/12", kind: "item", todo: 12, state: "in_review", present: [person], children: [] },
  scratch: { id: "scratch-repro", name: "scratch/repro", kind: "scratch", present: [], children: [] },
  earlier: { id: "earlier", name: "Earlier", kind: "earlier", present: [], children: [] }
} satisfies Record<string, BranchTreeNodeCard>
