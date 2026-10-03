import type { EdgeMapCard, ToastCard, ToastStackCard } from "../../src/ToastCard.ts"
import { type Story, story } from "./_story.ts"

const n = { n: "12" }
const needsYou: ToastCard = {
  id: "toast-12",
  entry_id: "entry-12",
  title: "T12 needs you",
  tone: "attention",
  kind: "needs_you",
  action: {
    tag: "todo.answer",
    label: "Answer",
    args: n,
    primary: true,
    input: [{ name: "answer", label: "Answer", kind: "text", required: true }]
  }
}
const toasts = {
  needs_you: needsYou,
  approval: { ...needsYou, id: "toast-approval", kind: "approval", title: "Approve T12" },
  in_review: {
    ...needsYou,
    id: "toast-review",
    kind: "in_review",
    title: "T12 in review",
    action: { tag: "merge", label: "Merge", args: n }
  },
  failed: {
    ...needsYou,
    id: "toast-failed",
    kind: "failed",
    tone: "failed",
    title: "T12 failed",
    action: { tag: "todo.retry", label: "Retry", args: n }
  },
  conflict: {
    ...needsYou,
    id: "toast-conflict",
    kind: "conflict",
    title: "T12 has conflicts",
    action: { tag: "branch", label: "Resolve", args: { name: "todo/12" } }
  },
  merged: {
    ...needsYou,
    id: "toast-merged",
    kind: "merged",
    tone: "done",
    title: "T12 merged",
    detail: "Checks passed",
    action: { tag: "todo", label: "Open", args: n }
  },
  progress: {
    id: "toast-progress",
    entry_id: "entry-13",
    kind: "progress",
    tone: "live",
    title: "Refreshing wiki",
    detail: "Reading source",
    action: { tag: "stop", label: "Stop" }
  },
  allow_notifications: {
    id: "toast-allow",
    entry_id: "entry-allow",
    kind: "allow_notifications",
    tone: "attention",
    title: "Allow notifications",
    action: { tag: "notifications.allow", label: "Allow notifications" }
  },
  no_action: {
    id: "toast-done",
    entry_id: "entry-done",
    title: "Source ready",
    kind: "merged",
    tone: "done",
    detail: "Checks passed"
  }
} satisfies Record<string, ToastCard>

export const fixtures = {
  needs_you: story("Needs you", toasts.needs_you, { expect: ["T12 needs you", "Answer"] }),
  approval: story("An approval", toasts.approval, { expect: ["Approve T12"] }),
  in_review: story("In review", toasts.in_review, { expect: ["T12 in review", "Merge"] }),
  failed: story("Failed", toasts.failed, { expect: ["T12 failed", "Retry"] }),
  conflict: story("A rebase conflict", toasts.conflict, { expect: ["T12 has conflicts", "Resolve"] }),
  merged: story("The viewer's TODO merged", toasts.merged, { expect: ["T12 merged", "Checks passed"] }),
  progress: story("Background progress", toasts.progress, { expect: ["Refreshing wiki", "Reading source", "Stop"] }),
  allow_notifications: story("Allow notifications", toasts.allow_notifications, { expect: ["Allow notifications"] }),
  no_action: story("No action", toasts.no_action, { expect: ["Source ready", "Checks passed"] })
} satisfies Record<string, Story<ToastCard>>

export const stacks = {
  three_and_more: story(
    "Three shown and +2 more",
    {
      toasts: [toasts.needs_you, toasts.failed, toasts.progress, toasts.in_review, toasts.merged],
      more: 2
    },
    { expect: ["T12 needs you", "T12 failed", "Refreshing wiki", "2"] }
  ),
  one: story("One toast", { toasts: [toasts.merged], more: 0 }, { expect: ["T12 merged"] })
} satisfies Record<string, Story<ToastStackCard>>

const edges: EdgeMapCard = {
  above: [toasts.needs_you, toasts.progress, toasts.in_review],
  below: [toasts.failed],
  narrow: false
}
export const edgeMaps = {
  wide: story("Above and below, wide", edges, { expect: ["T12 needs you", "Refreshing wiki", "T12 failed"] }),
  narrow: story("Above and below, narrow", { ...edges, narrow: true }, { expect: ["T12 needs you", "T12 failed"] }),
  below_only: story("Below only", { above: [], below: [toasts.conflict], narrow: false }, {
    expect: ["T12 has conflicts"]
  })
} satisfies Record<string, Story<EdgeMapCard>>
