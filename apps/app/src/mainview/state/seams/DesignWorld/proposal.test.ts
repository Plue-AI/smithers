import { expect, test } from "bun:test"
import { designProposalCard } from "./proposal"
import { seedDesignWorld } from "./world"

test("seeded proposals retain their evidence and recorded change references", () => {
  const world = seedDesignWorld()
  expect(designProposalCard(world, world.proposals[0]!)).toEqual({
    id: "r-learn", title: "Use the shared backoff() for every retry",
    evidence: ["Three TODOs this month hand-wrote retry delays. lib/backoff.ts already caps them."],
    refs: [{ label: "#85", url: "https://github.com/acme/api/pull/85" },
      { label: "#87", url: "https://github.com/acme/api/pull/87" }, { label: "#88", url: "https://github.com/acme/api/pull/88" }], state: "open"
  })
  expect(designProposalCard(world, { ...world.proposals[0]!, todo: "t-stripe" })).toMatchObject({
    state: "accepted", todo: { n: 8, title: "Upgrade the Stripe SDK to v17" }
  })
  const unknown = designProposalCard(world, { ...world.proposals[0]!, todo: "missing" })
  expect(unknown.state).toBe("accepted")
  expect(unknown).not.toHaveProperty("todo")
})
