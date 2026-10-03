/**
 * Behavioral projection contract checks for Secrets.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { SecretsCardSchema } from "../../src/SecretsCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Secrets.ts"

cardContract("Secrets", SecretsCardSchema, fixtures)

// Literal oracle: spec §8.8 scopes.
const SCOPES = ["all_branches", "main_only"] as const
const row = fixtures.all_branches.model.secrets[0]!

describe("Secrets", () => {
  test.each(SCOPES)("accepts scope %s", (scope) => {
    expect(SecretsCardSchema.parse({ secrets: [{ ...row, scope }] }).secrets[0]!.scope).toBe(scope)
  })
  test.each(["all", "main", "branch", "main-only", ""])("refuses scope %j", (scope) => {
    expect(SecretsCardSchema.safeParse({ secrets: [{ ...row, scope }] }).success).toBe(false)
  })
  test("keeps bound hosts", () => {
    expect(SecretsCardSchema.parse(fixtures.bound_hosts.model).secrets[0]!.hosts).toEqual([
      "api.stripe.com",
      "files.stripe.com"
    ])
  })
  test("never carries a secret value", () => {
    const parsed = SecretsCardSchema.parse({ secrets: [{ ...row, value: "hunter2" }] })
    expect(parsed.secrets[0]).not.toHaveProperty("value")
    expect(JSON.stringify(Object.values(fixtures).map((story) => story.model))).not.toContain("hunter2")
  })
  test("rows carry Replace and Delete bound to their name; a member sees none", () => {
    expect(row.actions.map((action) => [action.tag, action.label, action.args])).toEqual([
      ["secrets.set", "Replace", { name: "NPM_TOKEN" }],
      ["secrets.delete", "Delete", { name: "NPM_TOKEN" }]
    ])
    expect(fixtures.member_view.model.secrets[0]!.actions).toEqual([])
    expect(fixtures.member_view.actions).toEqual([])
  })
})
