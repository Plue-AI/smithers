/**
 * Behavioral projection contract checks for Members.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { MembersCardSchema } from "../../src/MembersCard.ts"
import { cardContract } from "../cardContract.ts"
import { placeholder_avatar } from "../fixtures/_shared.ts"
import { fixtures } from "../fixtures/Members.ts"

cardContract("Members", MembersCardSchema, fixtures)

// Literal oracle: M-05 roles.
const ROLES = ["owner", "maintainer", "member"] as const
const team = fixtures.team.model
const withRow = (patch: Record<string, unknown>) => ({ ...team, members: [{ ...team.members[1], ...patch }] })

describe("Members", () => {
  test.each(ROLES)("accepts role %s", (role) => {
    expect(MembersCardSchema.parse(withRow({ role })).members[0]!.role).toBe(role)
  })
  test.each(["admin", "write", "Owner", ""])("refuses role %j", (role) => {
    expect(MembersCardSchema.safeParse(withRow({ role })).success).toBe(false)
  })
  test("stories cover every role, needs access and suspended", () => {
    const rows = Object.values(fixtures).flatMap((story) => story.model.members)
    expect([...new Set(rows.map((row) => row.role))].sort()).toEqual([...ROLES].sort())
    expect(rows.some((row) => row.needs_access)).toBe(true)
    expect(rows.some((row) => row.suspended)).toBe(true)
  })
  test("a member colour is 0–5; 6 and 7 belong to agents and neutral actors", () => {
    for (const color_index of [0, 5, 6, 7, -1, 0.5]) {
      expect(MembersCardSchema.safeParse(withRow({ color_index })).success).toBe(color_index === 0 || color_index === 5)
    }
  })
  test("rows carry their own Role and Remove; a member sees none", () => {
    expect(team.members[1]!.actions.map((action) => [action.tag, action.args])).toEqual([
      ["members.role", { login: "ben" }],
      ["members.remove", { login: "ben" }]
    ])
    expect(fixtures.member_view.model.members.flatMap((row) => row.actions)).toEqual([])
    expect(fixtures.member_view.actions).toEqual([])
  })
  test("accepts the bundled avatar and refuses unsafe links", () => {
    expect(MembersCardSchema.parse(fixtures.placeholder_avatar.model).members[0]!.avatar_url).toBe(placeholder_avatar)
    for (const url of ["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd"]) {
      expect(MembersCardSchema.safeParse(withRow({ avatar_url: url })).success).toBe(false)
      expect(MembersCardSchema.safeParse({ ...team, access_url: url }).success).toBe(false)
    }
  })
})
