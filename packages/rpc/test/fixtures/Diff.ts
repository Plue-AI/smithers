import type { DiffCard } from "../../src/DiffCard.ts"
import { agent, person, sha } from "./_shared.ts"

export const fixtures = {
  unchanged: { path: "flows/todo/flow.ts", branch: "todo/12", base: sha, hunks: [] },
  changed: {
    path: "flows/todo/flow.ts",
    branch: "todo/12",
    base: sha,
    hunks: [{
      header: "@@ -2,3 +2,3 @@",
      authors: [person, agent],
      lines: [
        { op: " ", text: "export default Flow.make(\"todo\", {" },
        { op: "-", text: "  description: \"Build\"," },
        { op: "+", text: "  description: \"Complete one TODO\"," }
      ]
    }]
  }
} satisfies Record<string, DiffCard>
