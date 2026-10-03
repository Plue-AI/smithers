/**
 * Behavioral projection contract checks for Proposal and the lessons receipt.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { LessonsReceiptSchema, ProposalCardSchema } from "../../src/ProposalCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures, receipts } from "../fixtures/Proposal.ts"

cardContract("Proposal", ProposalCardSchema, fixtures)
cardContract("LessonsReceipt", LessonsReceiptSchema, receipts)

// Literal oracle from ui-components.md T-UI-20; never read from the schema.
const STATES = ["open", "accepted", "dismissed"] as const

describe("Proposal", () => {
  test("stories cover every state", () => {
    expect([...new Set(Object.values(fixtures).map((story) => story.model.state))].sort()).toEqual([...STATES].sort())
  })
  test.each(["committed", "rejected", "closed", ""])("rejects state %j", (state) => {
    expect(ProposalCardSchema.safeParse({ ...fixtures.open.model, state }).success).toBe(false)
  })
  // Re-homed from OtherContracts "retains the TODO created from an accepted proposal".
  test("retains the TODO an accepted proposal became", () => {
    expect(ProposalCardSchema.parse(fixtures.accepted.model).todo).toEqual({
      n: 14,
      title: "Keep completion receipts in toasts"
    })
  })
  test.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd"])("rejects unsafe ref %s", (url) => {
    expect(ProposalCardSchema.safeParse({ ...fixtures.open.model, refs: [{ label: "T12", url }] }).success).toBe(false)
  })
  test("a receipt names its TODO with a positive integer", () => {
    for (const todo of [0, -1, 1.5]) {
      expect(LessonsReceiptSchema.safeParse({ ...receipts.lessons.model, todo }).success).toBe(false)
    }
  })
})
