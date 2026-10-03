/**
 * Behavioral projection contract checks for ActorChip and the M-34 actor identity.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { ActorChipCardSchema } from "../../src/ActorChipCard.ts"
import { ActorSchema } from "../../src/CardPrimitives.ts"
import { cardContract } from "../cardContract.ts"
import {
  agent,
  ben,
  claude_code,
  github_user,
  outside,
  person,
  smithers,
  smithers_for_ben,
  system,
  undelegated_agent
} from "../fixtures/_shared.ts"
import { fixtures } from "../fixtures/ActorChip.ts"

cardContract("ActorChip", ActorChipCardSchema, fixtures)

describe("chip props", () => {
  test("live is optional and size is s or m", () => {
    expect(ActorChipCardSchema.parse({ actor: person, size: "s" })).toEqual({ actor: person, size: "s" })
    for (const size of ["s", "m"]) expect(ActorChipCardSchema.safeParse({ actor: person, size }).success).toBe(true)
    for (const size of ["l", "xs", "S", ""]) {
      expect(ActorChipCardSchema.safeParse({ actor: person, size }).success).toBe(false)
    }
  })
})

// Literal oracles from M-34, spec §14.6a.1 and ui-components.md (origin/main); never read from the schema.
const ACTOR_KINDS = ["person", "agent", "system", "github", "outside"] as const
const AGENT_KINDS = ["smithers", "coding", "reviewer", "claude-code", "codex", "external"] as const
const VIAS = ["ssh", "terminal", "cli"] as const
const accepts = (actor: unknown): boolean => ActorSchema.safeParse(actor).success

describe("actor kinds", () => {
  test("fixtures cover every actor kind and every agent kind", () => {
    const actors = Object.values(fixtures).map(({ model }) => model.actor)
    expect([...new Set(actors.map((actor) => actor.kind))].sort()).toEqual([...ACTOR_KINDS].sort())
    expect([...new Set(actors.flatMap((actor) => actor.kind === "agent" ? [actor.agent] : []))].sort()).toEqual(
      [...AGENT_KINDS].sort()
    )
  })
  test.each(["bot", "member", "app", "smithers", ""])("rejects kind %j", (kind) => {
    expect(accepts({ ...agent, kind })).toBe(false)
    expect(accepts({ ...system, kind })).toBe(false)
  })
})

describe("person via", () => {
  test.each(VIAS)("accepts %s", (via) => {
    expect(ActorSchema.parse({ ...person, via })).toEqual({ ...person, via })
  })
  test.each(["claude-code", "codex", "smithers", "app", "SSH", ""])("rejects %j", (via) => {
    expect(accepts({ ...person, via })).toBe(false)
  })
})

describe("agent participants", () => {
  test.each(AGENT_KINDS)("accepts agent %s", (kind) => {
    expect(accepts({ ...agent, agent: kind })).toBe(true)
  })
  test.each(["app", "fast", "jev", "system", "claude_code", "Claude Code", ""])("rejects agent %j", (kind) => {
    expect(accepts({ ...agent, agent: kind })).toBe(false)
  })
  test("keeps participant id, run or session, avatar and the member it acts for", () => {
    expect(ActorSchema.parse(agent)).toEqual(agent)
    expect(ActorSchema.parse(claude_code)).toEqual(claude_code)
    expect(ActorSchema.parse(smithers_for_ben)).toMatchObject({ agent: "smithers", for_member: { login: "ben" } })
    const twin = { ...agent, id: "agent-run-42-implementer", run_id: "run-42" }
    expect(ActorSchema.parse(twin)).not.toEqual(ActorSchema.parse(agent))
  })
  test("an agent requires its stable id and its own avatar", () => {
    for (const key of ["id", "avatar_url", "agent"] as const) {
      const { [key]: _removed, ...rest } = smithers_for_ben
      expect(accepts(rest), key).toBe(false)
    }
  })
  test("for_member is the delegating person; the old `for` key is not part of the contract", () => {
    const { for_member: _member, ...undelegated } = agent
    expect(ActorSchema.parse({ ...undelegated, for: ben })).not.toHaveProperty("for")
    expect(accepts({ ...agent, for_member: { login: "ben" } })).toBe(false)
  })
  test("the system actor is a bare install event", () => {
    expect(ActorSchema.parse({ kind: "system", color_index: 7, id: "smithers", for: ben })).toEqual({
      kind: "system",
      color_index: 7
    })
  })
})

describe("identity colour 0–7", () => {
  const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i)
  test.each(
    [
      ["person", person, range(0, 5)],
      ["agent for a member", agent, range(0, 6)],
      ["undelegated agent", undelegated_agent, range(0, 6)],
      ["Smithers for a member", smithers_for_ben, range(0, 6)],
      ["undelegated Smithers", smithers, range(0, 6)],
      ["install event", system, [7]],
      ["GitHub user", github_user, [7]],
      ["outside write", outside, [7]]
    ] as const
  )("%s", (_name, actor, valid) => {
    for (const color_index of [-1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0.5]) {
      expect(accepts({ ...actor, color_index }), String(color_index)).toBe(
        (valid as readonly number[]).includes(color_index)
      )
    }
  })
  test("fixtures use the member's colour for delegated work, 6 for nobody's and 7 for neutral", () => {
    expect([agent, claude_code, smithers_for_ben].map((actor) => actor.color_index)).toEqual([0, 0, 0])
    expect([undelegated_agent, smithers].map((actor) => actor.color_index)).toEqual([6, 6])
    expect([system, github_user, outside].map((actor) => actor.color_index)).toEqual([7, 7, 7])
  })
})

// The one actor fixture set design builds against (@smthrs/rpc/fixtures/ActorChip), pinned by name (M-34 review).
describe("the pinned actor story set", () => {
  test("holds every actor variant design renders", () => {
    expect(Object.keys(fixtures)).toEqual(expect.arrayContaining([
      "person",
      "ssh",
      "smithers_for_ben",
      "claude_code_for_ben",
      "codex_for_ben",
      "coding_agent_for_ben",
      "reviewer_for_ben",
      "external_for_ben",
      "undelegated_agent",
      "undelegated_smithers",
      "github_user"
    ]))
  })
  test("external agents act for Ben as agents with for_member, never as person.via", () => {
    for (const key of ["claude_code_for_ben", "codex_for_ben", "external_for_ben"] as const) {
      const actor = fixtures[key].model.actor
      expect(actor).toMatchObject({ kind: "agent", for_member: { login: "ben" }, color_index: 0 })
    }
    const vias = Object.values(fixtures).flatMap(({ model }) => model.actor.kind === "person" ? [model.actor.via] : [])
    expect(vias.filter((via) => via !== undefined).sort()).toEqual(["cli", "ssh", "terminal"])
  })
  test("colours 6 and 7 appear where the spec allows them", () => {
    expect(fixtures.undelegated_agent.model.actor.color_index).toBe(6)
    expect(fixtures.undelegated_smithers.model.actor.color_index).toBe(6)
    expect(fixtures.github_user.model.actor.color_index).toBe(7)
    expect(fixtures.outside.model.actor.color_index).toBe(7)
  })
})
