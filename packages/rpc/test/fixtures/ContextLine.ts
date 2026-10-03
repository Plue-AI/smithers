import type { ContextLineCard } from "../../src/ContextLineCard.ts"
import { type Story, story } from "./_story.ts"

const items: ContextLineCard["items"] = [
  { kind: "file", label: "flow.ts", ref: "flows/todo/flow.ts", revision: "head" },
  { kind: "page", label: "Factory decisions", ref: "wiki/factory-decisions" },
  { kind: "issue", label: "#3474", ref: "https://github.com/smithersai/smithers/issues/3474" },
  { kind: "todo", label: "T12", ref: "12" },
  { kind: "run", label: "Implement", ref: "run-12-1" }
]
export const fixtures = {
  collapsed: story("Five items, collapsed", { count: 5, items, expanded: false }, { expect: ["5"] }),
  expanded: story("Five items, expanded", { count: 5, items, expanded: true }, {
    expect: ["flow.ts", "Factory decisions", "#3474", "T12", "Implement"]
  }),
  one: story("One file, expanded", { count: 1, items: [items[0]!], expanded: true }, { expect: ["flow.ts"] })
} satisfies Record<string, Story<ContextLineCard>>
