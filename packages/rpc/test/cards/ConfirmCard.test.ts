/**
 * Behavioral projection contract checks for Confirm.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { type ConfirmCard, ConfirmCardSchema } from "../../src/ConfirmCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Confirm.ts"

cardContract("Confirm", ConfirmCardSchema, fixtures)

// Literal oracles from ui-components.md T-UI-05; never read from the schema.
const KINDS = ["one_click", "review_merge"] as const
const SUBJECTS = ["todo", "branch", "flow", "agent", "wiki"] as const
const RESULTS = ["done", "cancelled", "expired"] as const
const models: ConfirmCard[] = Object.values(fixtures).map((story) => story.model)
const review = () => ConfirmCardSchema.parse(fixtures.review_merge.model)

describe("Confirm enums", () => {
  test("stories cover both kinds, every subject kind and every receipt result", () => {
    expect([...new Set(models.map((confirm) => confirm.kind))].sort()).toEqual([...KINDS].sort())
    expect([...new Set(models.map((confirm) => confirm.subject.kind))].sort()).toEqual([...SUBJECTS].sort())
    expect(models.flatMap((confirm) => confirm.receipt ? [confirm.receipt.result] : []).sort()).toEqual(
      [...RESULTS].sort()
    )
  })
  test.each(["merge", "two_click", ""])("rejects kind %j", (kind) => {
    expect(ConfirmCardSchema.safeParse({ ...fixtures.one_click.model, kind }).success).toBe(false)
  })
  // Members, secrets and settings are agent: never and have no confirmation.
  test.each(["secret", "member", "settings", "file", ""])("rejects subject kind %j", (kind) => {
    const base = fixtures.one_click.model
    expect(ConfirmCardSchema.safeParse({ ...base, subject: { ...base.subject, kind } }).success).toBe(false)
  })
  test.each(["stale", "approved", "denied", ""])("rejects receipt result %j", (result) => {
    const base = fixtures.done.model
    expect(ConfirmCardSchema.safeParse({ ...base, receipt: { ...base.receipt!, result } }).success).toBe(false)
  })
})

describe("Confirm variants", () => {
  // Re-homed from CoreDataReview "confirmation variants keep one-click exact text and review merge data".
  test("one click keeps the exact words the command sends and the receipt text", () => {
    expect(ConfirmCardSchema.parse(fixtures.one_click.model).text).toBe("Keep the S3 fields optional")
    expect(ConfirmCardSchema.parse(fixtures.done.model).receipt).toEqual({
      by: fixtures.done.model.receipt!.by,
      result: "done",
      at: fixtures.done.model.receipt!.at,
      text: "Amended T12"
    })
    expect(review().review?.pr).toEqual({ number: 3475, url: "https://github.com/smithersai/smithers/pull/3475" })
  })
  test("a stale approval names the approved revision beside the current one", () => {
    const stale = ConfirmCardSchema.parse(fixtures.stale_approval.model)
    expect([stale.review?.approved_revision, stale.subject.revision]).toEqual(["1b2c3d4", "9e8f7a6"])
  })
  // Re-homed from CoreDataReview "revision evidence preserves previous results while review is running".
  test("review evidence is one revision's evidence and keeps previous results while reviewing", () => {
    const evidence = ConfirmCardSchema.parse(fixtures.stale_approval.model).review!.evidence
    expect(evidence.previous?.revision).toBe("1b2c3d4")
    expect(ConfirmCardSchema.parse(fixtures.reviewing.model).review?.evidence.reviewing).toBe(true)
    const base = review()
    expect(
      ConfirmCardSchema.safeParse({ ...base, review: { ...base.review!, evidence: [base.review!.evidence] } })
        .success
    ).toBe(false)
  })
  test("each review check keeps its name, state and requiredness", () => {
    expect(
      review().review!.evidence.items.flatMap((item) =>
        item.kind === "github_check" ? [[item.name, item.state, item.required]] : []
      )
    ).toEqual([["required-ci", "passed", true]])
  })
  test("review place and PR number are positive integers", () => {
    const base = review()
    for (const value of [0, -1, 1.5]) {
      expect(ConfirmCardSchema.safeParse({ ...base, review: { ...base.review!, place: value } }).success).toBe(false)
      expect(
        ConfirmCardSchema.safeParse({ ...base, review: { ...base.review!, pr: { ...base.review!.pr, number: value } } })
          .success
      ).toBe(false)
    }
  })
  test.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd"])(
    "rejects unsafe PR URL %s",
    (url) => {
      const base = review()
      expect(
        ConfirmCardSchema.safeParse({ ...base, review: { ...base.review!, pr: { ...base.review!.pr, url } } }).success
      ).toBe(false)
    }
  )
})
