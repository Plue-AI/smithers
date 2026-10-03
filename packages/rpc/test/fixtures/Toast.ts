import type { ToastCard } from "../../src/ToastCard.ts"

const base: ToastCard = {
  id: "toast-12",
  entry_id: "entry-12",
  title: "T12 needs you",
  tone: "attention",
  kind: "needs_you",
  action: {
    tag: "todo.answer",
    label: "Answer",
    primary: true,
    input: [{ name: "answer", label: "Answer", kind: "text", required: true }]
  }
}
export const fixtures = {
  needs_you: base,
  approval: { ...base, id: "toast-approval", kind: "approval", title: "Approve T12" },
  in_review: { ...base, kind: "in_review", title: "T12 in review", action: { tag: "merge", label: "Merge" } },
  failed: {
    ...base,
    kind: "failed",
    tone: "failed",
    title: "T12 failed",
    action: { tag: "todo.retry", label: "Retry" }
  },
  conflict: { ...base, kind: "conflict", title: "T12 has conflicts", action: { tag: "branch", label: "Resolve" } },
  merged: { ...base, kind: "merged", tone: "done", title: "T12 merged", action: { tag: "todo", label: "Open" } },
  allow_notifications: {
    id: "toast-allow",
    entry_id: "entry-allow",
    kind: "allow_notifications",
    tone: "quiet",
    title: "Allow notifications"
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
