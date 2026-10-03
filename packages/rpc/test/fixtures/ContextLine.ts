import type { ContextLineCard } from "../../src/ContextLineCard.ts"

export const fixtures = {
  empty: { count: 0, items: [], expanded: false },
  collapsed: {
    count: 5,
    items: [
      { kind: "file", label: "flow.ts", ref: "flows/todo/flow.ts", revision: "head" },
      { kind: "page", label: "Factory decisions", ref: "wiki/factory-decisions" },
      { kind: "issue", label: "#3474", ref: "https://github.com/smithersai/smithers/issues/3474" },
      { kind: "todo", label: "T12", ref: "12" },
      { kind: "run", label: "Implement", ref: "run-12-1" }
    ],
    expanded: false
  },
  expanded: { count: 1, items: [{ kind: "file", label: "flow.ts", ref: "flows/todo/flow.ts" }], expanded: true }
} satisfies Record<string, ContextLineCard>
