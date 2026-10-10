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
  test("keeps a declared file path", () => {
    expect(SecretsCardSchema.parse(fixtures.file_path.model).secrets[0]!.path).toBe("~/.config/anthropic/key")
    expect(SecretsCardSchema.parse({ secrets: [row] }).secrets[0]).not.toHaveProperty("path")
  })
  test("never carries a secret value", () => {
    const parsed = SecretsCardSchema.parse({ secrets: [{ ...row, value: "hunter2" }] })
    expect(parsed.secrets[0]).not.toHaveProperty("value")
    expect(JSON.stringify(Object.values(fixtures).map((story) => story.model))).not.toContain("hunter2")
  })
  test("rows carry Replace and Delete bound to their name; a member sees none", () => {
    expect(row.actions.map((action) => [action.tag, action.label, action.args])).toEqual([
      ["secrets", "Replace", { operation: "set", name: "NPM_TOKEN" }],
      ["secrets", "Delete", { operation: "delete", name: "NPM_TOKEN" }]
    ])
    expect(fixtures.member_view.model.secrets[0]!.actions).toEqual([])
    expect(fixtures.member_view.actions).toEqual([])
  })
})

test("the shared live model and literal old pinned rows keep names, scopes and hosts without values", async () => {
  const { CardSchema } = await import("../../src/Cards.ts")
  const base = { id: "secrets", kind: "secrets", title: "Secrets", status: "active", createdAt: 0, ordinal: 0 }
  expect(CardSchema.safeParse({ ...base, payload: { secrets: [] } }).success).toBe(true)
  const legacy = CardSchema.parse({
    ...base,
    payload: {
      repo: "owner/repo",
      scope: "repository",
      secrets: [
        {
          name: "DEPLOY",
          mainOnly: true,
          hosts: ["api.example.test"],
          matchHeaders: ["authorization"],
          updatedAt: null,
          value: "PRIVATE_LEGACY"
        }
      ]
    }
  })
  expect(legacy.kind).toBe("secrets")
  if (legacy.kind !== "secrets") throw new Error("wrong kind")
  expect(legacy.payload.secrets[0]).toEqual({
    name: "DEPLOY",
    mainOnly: true,
    hosts: ["api.example.test"],
    matchHeaders: ["authorization"],
    updatedAt: null
  })
  const live = CardSchema.parse({
    ...base,
    payload: {
      secrets: [
        { name: "DEPLOY", scope: "main_only", hosts: ["api.example.test"], actions: [], value: "PRIVATE_LIVE" },
        { name: "TEST_KEY", scope: "all_branches", actions: [] }
      ]
    }
  })
  if (live.kind !== "secrets") throw new Error("wrong kind")
  expect(live.payload.secrets).toEqual([
    { name: "DEPLOY", mainOnly: true, hosts: ["api.example.test"], matchHeaders: [], updatedAt: null },
    { name: "TEST_KEY", mainOnly: false, hosts: [], matchHeaders: [], updatedAt: null }
  ])
  expect(JSON.stringify({ legacy, live })).not.toContain("PRIVATE_")
})
