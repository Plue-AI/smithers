import type { FileCard } from "../../src/FileCard.ts"
import { agent, person } from "./_shared.ts"

const base: FileCard = {
  path: "flows/todo/flow.ts",
  branch: "todo/12",
  text: "export default Flow.make(\"todo\", { description: \"Complete one TODO\" })\n",
  language: "typescript",
  diagnostics: []
}
export const fixtures = {
  ready: base,
  diagnostics: {
    ...base,
    diagnostics: [{ line: 1, severity: "error", message: "Missing body" }, {
      line: 1,
      severity: "warning",
      message: "Unused import"
    }]
  },
  gone: { ...base, text: "", gone: { kind: "deleted", by: person } },
  renamed: { ...base, gone: { kind: "renamed", by: person, to: "flows/todo-next/flow.ts" } },
  outside: { ...base, outside: { snapshot: "export default Flow.make(\"todo\", { description: \"Build\" })\n" } },
  saving: {
    ...base,
    authors: [{ actor: person }, { actor: agent }],
    editors: [{ actor: person, line: 1 }, { actor: agent, line: 2 }],
    saved: "saving"
  },
  saved: { ...base, authors: [{ actor: person }], editors: [], saved: "saved" },
  stale: { ...base, authors: [], editors: [], saved: "stale" }
} satisfies Record<string, FileCard>
