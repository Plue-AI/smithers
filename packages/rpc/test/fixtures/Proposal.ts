import type { ProposalCard } from "../../src/ProposalCard.ts"

const base: ProposalCard = {
  id: "proposal-12",
  title: "Keep completion receipts",
  evidence: ["Merge launch returned before the job finished"],
  refs: [{ label: "T12", url: "https://github.com/smithersai/smithers/pull/3474" }],
  state: "open"
}
export const fixtures = {
  open: base,
  committed: { ...base, state: "accepted", todo: { n: 12, title: "Keep completion receipts" } },
  accepted: { ...base, state: "accepted" },
  dismissed: { ...base, state: "dismissed" },
  empty_evidence: { ...base, evidence: [], refs: [] }
} satisfies Record<string, ProposalCard>
