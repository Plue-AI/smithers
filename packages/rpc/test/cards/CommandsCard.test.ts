/**
 * Behavioral projection contract checks for Commands.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { CommandsCardSchema } from "../../src/CommandsCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Commands.ts"

cardContract("Commands", CommandsCardSchema, fixtures)

// Literal oracle: Appendix B agent column.
const AGENT = ["run", "confirm", "never"] as const
const maintainer = fixtures.maintainer.model
const withCommand = (patch: Record<string, unknown>) => ({
  groups: [{ ...maintainer.groups[0], commands: [{ ...maintainer.groups[0]!.commands[0], ...patch }] }]
})

describe("Commands", () => {
  test.each(AGENT)("accepts agent %s", (agent) => {
    expect(CommandsCardSchema.parse(withCommand({ agent })).groups[0]!.commands[0]!.agent).toBe(agent)
  })
  test.each(["yes", "ask", "always", ""])("refuses agent %j", (agent) => {
    expect(CommandsCardSchema.safeParse(withCommand({ agent })).success).toBe(false)
  })
  test("stories cover every agent value and an advanced group", () => {
    const groups = Object.values(fixtures).flatMap((story) => story.model.groups)
    const agents = groups.flatMap((group) => group.commands.map((command) => command.agent))
    expect([...new Set(agents)].sort()).toEqual([...AGENT].sort())
    expect(groups.some((group) => group.advanced)).toBe(true)
  })
  test.each(["/todo", "arbitrary.command", ""])("refuses unpublished tag %j", (tag) => {
    expect(CommandsCardSchema.safeParse(withCommand({ tag })).success).toBe(false)
  })
  test("each command needs its synopsis and description", () => {
    for (const key of ["synopsis", "description"]) {
      const { [key]: _removed, ...rest } = maintainer.groups[0]!.commands[0]! as Record<string, unknown>
      expect(CommandsCardSchema.safeParse({ groups: [{ ...maintainer.groups[0], commands: [rest] }] }).success, key)
        .toBe(false)
    }
  })
})
