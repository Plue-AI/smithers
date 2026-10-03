import type { LessonsReceipt, ProposalCard } from "../../src/ProposalCard.ts"
import { type Story, story } from "./_story.ts"

const base: ProposalCard = {
  id: "proposal-12",
  title: "Keep completion receipts",
  evidence: ["Merge launch returned before the job finished"],
  refs: [{ label: "T12", url: "https://github.com/smithersai/smithers/pull/3474" }],
  state: "open"
}
export const fixtures = {
  open: story("Open proposal", base, {
    actions: [
      { tag: "learning.accept", label: "Make TODO", args: { id: "proposal-12" }, primary: true },
      { tag: "learning.dismiss", label: "Dismiss", args: { id: "proposal-12" } }
    ],
    expect: ["Keep completion receipts", "Merge launch returned before the job finished", "Make TODO"]
  }),
  accepted: story(
    "Accepted, became T14",
    { ...base, state: "accepted", todo: { n: 14, title: "Keep completion receipts in toasts" } },
    { expect: ["Keep completion receipts in toasts"] }
  ),
  dismissed: story("Dismissed", { ...base, state: "dismissed" }, { expect: ["Keep completion receipts"] }),
  no_evidence: story("No evidence or references", { ...base, evidence: [], refs: [] }, {
    expect: ["Keep completion receipts"]
  })
} satisfies Record<string, Story<ProposalCard>>

export const receipts = {
  lessons: story(
    "Lessons from T12",
    {
      todo: 12,
      lessons: [{ title: "Retry policy", ref: "wiki:Retry policy" }, {
        title: "Keep completion receipts",
        ref: "proposal-12"
      }]
    },
    { expect: ["Retry policy", "Keep completion receipts"] }
  )
} satisfies Record<string, Story<LessonsReceipt>>
