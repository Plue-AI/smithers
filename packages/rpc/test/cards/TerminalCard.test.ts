/**
 * Behavioral projection contract checks for Terminal.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { TerminalCardSchema } from "../../src/TerminalCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/Terminal.ts"

cardContract("Terminal", TerminalCardSchema, fixtures)

describe("Terminal participants", () => {
  test("agents working in a terminal are actors, such as Claude Code for Ben (M-34)", () => {
    const terminal = TerminalCardSchema.parse(fixtures.agent_working.model)
    expect(terminal.agents.map((agent) => agent.kind === "agent" && [agent.agent, agent.for_member?.login])).toEqual([
      ["claude-code", "ben"]
    ])
  })
  test("watchers and owners may be people or agents", () => {
    expect(TerminalCardSchema.parse(fixtures.agent_owner.model).owner.kind).toBe("agent")
    expect(TerminalCardSchema.parse(fixtures.running.model).watchers.map((actor) => actor.kind)).toEqual(["person"])
  })
  // Re-homed from OtherContracts "offers a machine image change from a terminal": v0.4 has no `offer`, only the
  // owner check survives.
  test("a watched terminal is not the viewer's, and the retired offer field is stripped", () => {
    expect(TerminalCardSchema.parse(fixtures.watching.model).viewer_is_owner).toBe(false)
    expect(TerminalCardSchema.parse({ ...fixtures.idle.model, offer: "Add ripgrep" })).not.toHaveProperty("offer")
  })
  test("frozen and agents are required", () => {
    const { frozen: _frozen, ...unfrozen } = fixtures.idle.model
    const { agents: _agents, ...noAgents } = fixtures.idle.model
    expect(TerminalCardSchema.safeParse(unfrozen).success).toBe(false)
    expect(TerminalCardSchema.safeParse(noAgents).success).toBe(false)
    expect(TerminalCardSchema.parse(fixtures.frozen.model).frozen).toBe(true)
  })
})
