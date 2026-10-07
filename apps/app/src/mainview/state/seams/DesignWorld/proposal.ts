import type { ProposalCard } from "@smthrs/rpc/ProposalCard"
import type { DesignProposal, DesignWorldRows } from "./world"

/** Seeded subject projection; real installs read the proposals provider. */
export const designProposalCard = (world: DesignWorldRows, seed: DesignProposal): ProposalCard => {
  const made = seed.todo ? world.todos.find(row => row.id === seed.todo) : undefined
  return { id: seed.id, title: seed.title, evidence: [seed.evidence],
    refs: seed.refs.map(n => ({ label: `#${n}`, url: `https://github.com/${world.repo.repo}/pull/${n}` })),
    state: seed.todo ? "accepted" : "open",
    ...(made ? { todo: { n: Number(made.ref.slice(1)), title: made.title } } : {}) }
}
