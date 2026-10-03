import type { Action } from "../../src/CardAction.ts"
import type { FileCard, FileView } from "../../src/FileCard.ts"
import { agent, at, claude_code, outside, person } from "./_shared.ts"
import { type Story, story } from "./_story.ts"

type FileStory = Story<FileCard, FileView, "hover" | "definition">
const path = "flows/todo/flow.ts"
const text = "export default Flow.make(\"todo\", { description: \"Complete one TODO\" })\n"
const base: FileCard = {
  path,
  branch: "todo/12",
  language: "typescript",
  digest: "sha256:9f2c41",
  content: { kind: "text", text },
  mode: "read_only",
  last_writer: agent,
  diagnostics: [],
  authors: [],
  editors: []
}
const gestures: FileStory["gestures"] = {
  hover: { tag: "code.hover", label: "Hover", args: { path } },
  definition: { tag: "code.definition", label: "Go to definition", args: { path } }
}
const compare: Action = { tag: "file.compare", label: "Compare", args: { path } }
const file = (name: string, model: FileCard, parts: Partial<FileStory> & { expect: readonly string[] }): FileStory =>
  story<FileCard, FileView, "hover" | "definition">(name, model, { gestures, ...parts })

export const fixtures = {
  text: file("Read-only text", base, { view: { maximized: false, line: 1 }, expect: [path, "Complete one TODO"] }),
  diagnostics: file(
    "Text with an error and a warning",
    {
      ...base,
      diagnostics: [
        { line: 1, col: 15, severity: "error", message: "Missing body" },
        { line: 1, severity: "warning", message: "Unused import" }
      ]
    },
    { expect: ["Missing body", "Unused import"] }
  ),
  hover: file(
    "A hover result",
    { ...base, hover: { line: 1, col: 20, markdown: "`Flow.make(tag, spec)`: declares a flow" } },
    { view: { maximized: false, line: 1 }, expect: ["`Flow.make(tag, spec)`: declares a flow"] }
  ),
  reveal: file(
    "A same-file definition revealed",
    { ...base, reveal: { line: 1, col: 15, to_line: 1 } },
    { expect: ["Complete one TODO"] }
  ),
  too_large: file(
    "Too large to co-edit",
    {
      ...base,
      path: "fixtures/large.json",
      language: "json",
      content: { kind: "too_large", bytes: 2_400_000, text: "{" },
      github_url: "https://github.com/smithersai/smithers/blob/todo/12/fixtures/large.json"
    },
    { expect: ["fixtures/large.json"] }
  ),
  binary: file(
    "Binary, no editor",
    {
      ...base,
      path: "assets/logo.png",
      language: "png",
      content: { kind: "binary", bytes: 18_204 },
      github_url: "https://github.com/smithersai/smithers/blob/todo/12/assets/logo.png"
    },
    { gestures: {}, expect: ["assets/logo.png"] }
  ),
  live: file(
    "Live with two editors saving",
    {
      ...base,
      mode: "live",
      last_writer: person,
      authors: [person, claude_code],
      editors: [{ actor: person, line: 1 }, { actor: claude_code, line: 2 }],
      saved: "saving"
    },
    { view: { maximized: true, line: 1 }, expect: [path] }
  ),
  saved: file("Live and saved", { ...base, mode: "live", authors: [person], editors: [], saved: "saved" }, {
    expect: [path]
  }),
  unsaved: file(
    "A recovered document lost edits",
    { ...base, mode: "live", authors: [person], unsaved: { count: 3, text: "  description: \"Build\",\n" } },
    { expect: ["  description: \"Build\","] }
  ),
  deleted: file(
    "Deleted by Ben",
    { ...base, content: { kind: "text", text: "" }, gone: { kind: "deleted", by: person } },
    {
      actions: [{ tag: "file.restore-deleted", label: "Restore", args: { path }, primary: true }],
      expect: ["Restore", "Ben Carter"]
    }
  ),
  renamed: file(
    "Renamed by Ben",
    { ...base, gone: { kind: "renamed", to: "flows/todo-next/flow.ts", by: person } },
    {
      actions: [{ tag: "file.follow-rename", label: "Follow", args: { path }, primary: true }],
      expect: ["flows/todo-next/flow.ts", "Follow"]
    }
  ),
  outside: file(
    "Changed outside Smithers",
    { ...base, last_writer: outside, outside: { version: "git:7d1e0c2", at } },
    { actions: [compare], expect: ["Compare"] }
  ),
  comparing: file(
    "Comparing the outside version",
    { ...base, outside: { version: "git:7d1e0c2", at } },
    { actions: [compare], view: { maximized: true, compare: true }, expect: ["Complete one TODO"] }
  )
} satisfies Record<string, FileStory>
