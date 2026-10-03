import type { ConfirmCard } from "../../src/ConfirmCard.ts"
import { at, ben, claude_code } from "./_shared.ts"

const base: ConfirmCard = {
  kind: "one_click",
  action: { tag: "todo.drop", verb: "Drop" },
  subject: { kind: "todo", ref: "T12", label: "Drop T12", revision: "r3" },
  asked_by: claude_code
}
export const fixtures = {
  one_click: base,
  review_merge: {
    ...base,
    kind: "review_merge",
    action: { tag: "merge", verb: "Review & merge" },
    title: "Card model contracts",
    pr: { number: 3475, url: "https://github.com/smithersai/smithers/pull/3475" },
    evidence: [{ attempt: 1, revision: "r3", items: [] }],
    merge: { state: "ready", on_github: false },
    place: 1
  },
  waiting: { ...base, waiting_for: ben },
  done: { ...base, receipt: { by: ben, text: "Dropped T12", result: "done", at } },
  cancelled: { ...base, receipt: { by: ben, text: "Dropped T12", result: "cancelled", at } },
  stale: { ...base, receipt: { by: ben, text: "Dropped T12", result: "stale", at } },
  branch: { ...base, subject: { kind: "branch", ref: "scratch/bug-repro", label: "Scratch", revision: "r1" } },
  flow: { ...base, subject: { kind: "flow", ref: "todo", label: "TODO flow", revision: "v2" } },
  secret: { ...base, subject: { kind: "secret", ref: "GITHUB_TOKEN", label: "GitHub token", revision: "r2" } },
  member: { ...base, subject: { kind: "member", ref: "ben", label: "Ben", revision: "r1" } }
} satisfies Record<string, ConfirmCard>
