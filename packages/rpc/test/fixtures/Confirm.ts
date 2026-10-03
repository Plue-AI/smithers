import type { Action } from "../../src/CardAction.ts"
import type { Evidence } from "../../src/CardPrimitives.ts"
import type { ConfirmCard } from "../../src/ConfirmCard.ts"
import { at, ben, claude_code, smithers_for_ben } from "./_shared.ts"
import { type Story, story } from "./_story.ts"

const evidence: Evidence = {
  attempt: 1,
  revision: "4bc79ae",
  items: [
    { kind: "diff", files: 14, added: 412, removed: 96 },
    { kind: "check", name: "pnpm test", state: "passed", took_s: 48 },
    {
      kind: "github_check",
      name: "required-ci",
      state: "passed",
      required: true,
      url: "https://github.com/smithersai/smithers/actions/runs/124"
    },
    { kind: "review", summary: "Schemas match the spec" }
  ]
}
const pr = { number: 3475, url: "https://github.com/smithersai/smithers/pull/3475" }
const amend: ConfirmCard = {
  kind: "one_click",
  action: { tag: "todo.amend", verb: "Amend" },
  summary: "Amend T12",
  subject: { kind: "todo", ref: "T12", revision: "1b2c3d4" },
  text: "Keep the S3 fields optional",
  asked_by: claude_code
}
const verb = (tag: Action["tag"], label: string, args: Record<string, string>): Action => ({
  tag,
  label,
  args,
  primary: true
})
const reviewMerge: ConfirmCard = {
  kind: "review_merge",
  action: { tag: "merge", verb: "Review & merge" },
  summary: "Merge T12",
  subject: { kind: "todo", ref: "T12", revision: "4bc79ae" },
  asked_by: smithers_for_ben,
  review: { title: "Card model contracts", place: 1, pr, evidence, merge: { state: "ready", on_github: false } }
}
const mergeActions: Action[] = [
  verb("merge.confirm", "Merge", { n: "12", revision: "4bc79ae" }),
  { tag: "pr", label: "on GitHub ↗", args: { number: "3475" } }
]
const receipt = (result: "done" | "cancelled" | "expired", text?: string): ConfirmCard => ({
  ...amend,
  receipt: { by: ben, result, at, ...(text === undefined ? {} : { text }) }
})
const pending = {
  one_click: story("One click: amend with the exact text", amend, {
    actions: [verb("todo.amend", "Amend", { n: "12" })],
    expect: ["Amend T12", "Keep the S3 fields optional", "Amend"]
  }),
  drop: story(
    "One click: drop, asked by Smithers for Ben",
    {
      ...amend,
      action: { tag: "todo.drop", verb: "Drop" },
      summary: "Drop T12",
      text: undefined,
      asked_by: smithers_for_ben
    },
    { actions: [verb("todo.drop", "Drop", { n: "12" })], expect: ["Drop T12", "Drop"] }
  ),
  branch: story(
    "One click: add a scratch branch to the stack",
    {
      ...amend,
      action: { tag: "branch.add-to-stack", verb: "Add to stack" },
      summary: "Add scratch/repro to the stack",
      subject: { kind: "branch", ref: "scratch/repro", revision: "a1b2c3d" },
      text: undefined
    },
    {
      actions: [verb("branch.add-to-stack", "Add to stack", { branch: "scratch/repro" })],
      expect: ["Add scratch/repro to the stack"]
    }
  ),
  flow: story(
    "One click: propose a flow edit",
    {
      ...amend,
      action: { tag: "flow.edit", verb: "Propose" },
      summary: "Propose a TODO flow edit",
      subject: { kind: "flow", ref: "todo", revision: "v3" },
      text: "Run checks before review"
    },
    {
      actions: [verb("flow.edit", "Propose", { name: "todo" })],
      expect: ["Propose a TODO flow edit", "Run checks before review"]
    }
  ),
  agent: story(
    "One click: propose agent instructions",
    {
      ...amend,
      action: { tag: "todo.new", verb: "Propose" },
      summary: "Propose new implementer instructions",
      subject: { kind: "agent", ref: "implementer", revision: "e3f9a10" },
      text: "Prefer small commits"
    },
    {
      actions: [verb("todo.new", "Propose", { text: "Prefer small commits" })],
      expect: ["Propose new implementer instructions"]
    }
  ),
  wiki: story(
    "One click: create a wiki page",
    {
      ...amend,
      action: { tag: "wiki.page", verb: "Create" },
      summary: "Create the Retry policy page",
      subject: { kind: "wiki", ref: "Retry policy" },
      text: undefined
    },
    { actions: [verb("wiki.page", "Create", { name: "Retry policy" })], expect: ["Create the Retry policy page"] }
  ),
  review_merge: story("Review & merge, ready", reviewMerge, {
    actions: mergeActions,
    expect: ["Card model contracts", "required-ci", "Merge", "on GitHub ↗"]
  }),
  stale_approval: story(
    "Review & merge after the revision moved",
    {
      ...reviewMerge,
      subject: { kind: "todo", ref: "T12", revision: "9e8f7a6" },
      review: {
        ...reviewMerge.review!,
        evidence: { ...evidence, revision: "9e8f7a6", previous: { revision: "1b2c3d4", items: evidence.items } },
        approved_revision: "1b2c3d4",
        merge: { state: "waiting", reason: "rechecking", on_github: false }
      }
    },
    {
      actions: [{ tag: "pr", label: "on GitHub ↗", args: { number: "3475" } }],
      expect: ["1b2c3d4", "9e8f7a6"]
    }
  ),
  reviewing: story(
    "Review & merge while the review runs",
    {
      ...reviewMerge,
      review: {
        ...reviewMerge.review!,
        evidence: { ...evidence, reviewing: true },
        merge: { state: "blocked", reason: "checks", detail: "required-ci", on_github: true }
      }
    },
    { actions: [{ tag: "pr", label: "on GitHub ↗", args: { number: "3475" } }], expect: ["required-ci"] }
  ),
  done: story("Receipt: done", receipt("done", "Amended T12"), { expect: ["Amended T12"] }),
  cancelled: story("Receipt: cancelled", receipt("cancelled"), { expect: ["Amend T12"] }),
  expired: story("Receipt: expired", receipt("expired"), { expect: ["Amend T12"] })
} satisfies Record<string, Story<ConfirmCard>>

// Cancel (confirm.cancel, people only) on every confirmation still waiting, bound to its revision.
const cancel = (key: string, revision: string): Action => ({
  tag: "confirm.cancel",
  label: "Cancel",
  args: { confirmation: `confirm-${key}`, revision }
})
const revisionOf = (model: ConfirmCard): string | undefined =>
  model.receipt === undefined ? model.subject.revision : undefined
export const fixtures = Object.fromEntries(
  Object.entries(pending).map(([key, value]) => {
    const revision = revisionOf(value.model)
    return [key, revision === undefined ? value : { ...value, actions: [...value.actions, cancel(key, revision)] }]
  })
) as typeof pending
