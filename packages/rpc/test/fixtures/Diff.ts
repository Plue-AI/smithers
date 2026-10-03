import type { DiffCard } from "../../src/DiffCard.ts"
import { at, claude_code } from "./_shared.ts"
import { type Story, story } from "./_story.ts"

const path = "flows/todo/flow.ts"
const hunk: DiffCard["hunks"][number] = {
  old_start: 2,
  new_start: 2,
  lines: [
    { op: " ", text: "export default Flow.make(\"todo\", {" },
    { op: "-", text: "  description: \"Build\"," },
    { op: "+", text: "  description: \"Complete one TODO\"," }
  ]
}
const base: DiffCard = {
  path,
  branch: "todo/12",
  against: { kind: "item_base", rev: "4bc79ae" },
  change: "modified",
  hunks: [hunk]
}
const burst: DiffCard = { ...base, against: { kind: "burst", burst: "burst-17", actor: claude_code, at } }

export const fixtures = {
  item_base: story("Modified against the previous item", base, {
    expect: [path, "  description: \"Complete one TODO\","]
  }),
  unchanged: story("No hunks", { ...base, hunks: [] }, { expect: [path] }),
  fork: story(
    "Added on a scratch branch since its fork",
    {
      ...base,
      branch: "scratch/bug-repro",
      against: { kind: "fork", rev: "7d1e0c2" },
      change: "added",
      hunks: [{ old_start: 0, new_start: 1, lines: [{ op: "+", text: "export const repro = true" }] }]
    },
    { expect: ["export const repro = true"] }
  ),
  burst: story("One burst by Claude Code", burst, {
    actions: [{ tag: "file.restore", label: "Restore this file", args: { path, revision: "burst-17" } }],
    expect: ["Restore this file", "  description: \"Build\","]
  }),
  deleted: story(
    "Deleted",
    {
      ...base,
      change: "deleted",
      hunks: [{ old_start: 1, new_start: 0, lines: [{ op: "-", text: "export const legacy = true" }] }]
    },
    { expect: ["export const legacy = true"] }
  ),
  renamed: story(
    "Renamed without edits",
    { ...base, change: "renamed", renamed_to: "flows/todo-next/flow.ts", hunks: [] },
    { expect: ["flows/todo-next/flow.ts"] }
  ),
  binary: story(
    "Binary sizes",
    { ...base, path: "assets/logo.png", binary: { before_bytes: 18_204, after_bytes: 19_660 }, hunks: [] },
    { expect: ["assets/logo.png"] }
  )
} satisfies Record<string, Story<DiffCard>>
