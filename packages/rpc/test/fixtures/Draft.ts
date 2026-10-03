import type { Action } from "../../src/CardAction.ts"
import type { DraftCard } from "../../src/DraftCard.ts"
import { issue } from "./_shared.ts"
import { type Story, story } from "./_story.ts"

type DraftStory = Story<DraftCard, {}, "set">
const options: DraftCard["place"]["options"] = [
  { n: 8, title: "Persist merge requests", state: "in_review" },
  { n: 9, title: "Wire Home", state: "queued" }
]
const base: DraftCard = {
  title: "Card models",
  prompt: "Publish typed card models",
  acceptance: ["Fixtures parse", "Unknown states fail"],
  place: { mode: "append", options },
  private: true
}
const set: Action = { tag: "form.set", label: "Edit", args: { entry: "entry-draft-1" } }
const commit = (args: Record<string, string> = {}): Action => ({
  tag: "todo.new",
  label: "Commit",
  args,
  primary: true
})
// Discard deletes the author's uncommitted private Draft (draft.discard, mvp.md B.4); it never drops a TODO.
const discard: Action = { tag: "draft.discard", label: "Discard", args: { draft: "entry-draft-1" } }
const draft = (name: string, model: DraftCard, expect: string[], actions = [commit()]): DraftStory =>
  story(name, model, { actions: [...actions, discard], gestures: { set }, expect })

export const fixtures = {
  append: draft("Append to the end of the stack", base, ["Card models", "Fixtures parse", "Commit"]),
  before: draft(
    "Place before T8",
    { ...base, place: { mode: "before", n: 8, options } },
    ["Persist merge requests"],
    [commit({ before: "8" })]
  ),
  amend: draft(
    "Amend T9",
    { ...base, place: { mode: "amend", n: 9, options } },
    ["Wire Home"],
    [{ tag: "todo.amend", label: "Commit", args: { n: "9" }, primary: true }]
  ),
  issue_fixes: draft(
    "From an issue it closes",
    { ...base, issue: { ...issue, fixes: true } },
    ["Card model contracts", "Commit"]
  ),
  issue_without_fixes: draft(
    "From an issue it does not close",
    { ...base, issue: { ...issue, fixes: false } },
    ["Card model contracts"]
  ),
  seed: draft(
    "With a read-only seed patch",
    { ...base, seed: { files: ["packages/rpc/src/TodoCard.ts", "packages/rpc/test/fixtures/Todo.ts"] } },
    ["packages/rpc/src/TodoCard.ts"]
  ),
  committed: story("Committed as T12", { ...base, private: false, committed: { n: 12, rev: 1 } }, {
    expect: ["Card models"]
  }),
  committed_amendment: story(
    "Committed as the second revision of T9",
    { ...base, place: { mode: "amend", n: 9, options }, private: false, committed: { n: 9, rev: 2 } },
    { expect: ["Card models"] }
  ),
  empty_stack: draft(
    "Append to an empty stack",
    { ...base, title: "", prompt: "", acceptance: [], place: { mode: "append", options: [] } },
    ["Commit"],
    [{ ...commit(), disabled: { reason: "Add a title" } }]
  )
} satisfies Record<string, DraftStory>
