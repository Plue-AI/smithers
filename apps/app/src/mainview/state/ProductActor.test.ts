import { expect, test } from "bun:test"
import { ActorSchema, PlaceholderAvatarUrl } from "@smthrs/rpc/CardPrimitives"
import { fixtures } from "@smthrs/rpc/fixtures/ActorChip"
import { actorName, toActor, type ActorMember } from "./ProductActor"
import { todoActors } from "./TodoActors"
const ben: ActorMember = { id: "b", login: "ben", name: "Ben", avatar_url: PlaceholderAvatarUrl, color_index: 3 }
const roster = [ben]
for (const [via, label] of [[undefined, "Ben"], ["smithers", "Smithers for Ben"], ["claude-code", "Claude Code for Ben"], ["codex", "Codex for Ben"], ["ssh", "Ben via SSH"], ["terminal", "Ben's terminal"], ["cli", "Ben via CLI"], ["Aider", "Aider for Ben"]] as const) {
  test(`recorded channel ${via}`, () => {
    const actor = toActor({ person: "b", via, session: "s" }, roster)
    expect(actorName(actor)).toBe(label)
    expect(actor.color_index).toBe(3)
    if (actor.kind === "agent") expect(actor).toMatchObject({ id: "agent-session-s", for_member: { name: "Ben" }, session_id: "s" })
  })
}
for (const [agent, label] of [["coding", "Coding agent for Ben"], ["reviewer", "Reviewer for Ben"]] as const) {
  test(agent, () => {
    const actor = toActor({ agent, run: "r", todo: 4 }, roster, [{ id: "r", owner: "b" }])
    expect(actorName(actor)).toBe(label)
    expect(actor).toMatchObject({ id: "agent-run-r", run_id: "r", todo: 4, color_index: 3 })
    expect(toActor({ agent, run: "u" }).color_index).toBe(6)
  })
}
test("system stays system, including requester; no credential inference", () => {
  expect(toActor({ system: "smithers", requester: "b" }, roster)).toEqual({ kind: "system", color_index: 7 })
  expect(actorName(toActor({ system: "smithers" }))).toBe("Smithers")
  expect(actorName(toActor({ person: "b", session: "cookie" }, roster))).toBe("Ben")
})
test("neutral actors and removed members", () => {
  expect(actorName(toActor({ github: "octocat" }))).toBe("@octocat")
  expect(actorName(toActor({ outside: true }))).toBe("changed outside Smithers")
  expect(toActor({ github: "octocat" }).color_index).toBe(7)
  expect(toActor({ outside: true }).color_index).toBe(7)
  expect(actorName(toActor({ person: "b" }, [{ ...ben, removed: true }]))).toBe("ben")
  expect(() => toActor({ person: "deleted" })).toThrow("missing from the roster")
})
test("session identity stays stable across delegation", () => {
  const maya = { ...ben, id: "m", login: "maya", name: "Maya", color_index: 5 }
  const a = toActor({ person: "b", via: "codex", session: "s" }, [ben, maya])
  const b = toActor({ person: "m", via: "codex", session: "s" }, [ben, maya])
  expect(a.kind === "agent" && a.id).toBe(b.kind === "agent" && b.id)
  expect(actorName(b)).toBe("Codex for Maya")
  expect(b.color_index).toBe(5)
})
test("all shared chip fixtures decode unchanged", () => {
  for (const fixture of Object.values(fixtures)) expect(toActor(fixture.model.actor)).toEqual(ActorSchema.parse(fixture.model.actor))
})
for (const color_index of [-1, 8]) test(`rejects color ${color_index}`, () => {
  expect(() => toActor({ person: "b" }, [{ ...ben, color_index }])).toThrow()
})
test("TODO author normalization retains fields and literals", () => {
  const source = { text: "Answer", by: { person: "b", via: "claude-code", session: "s" }, at: "now" }
  const mapped = todoActors({ prompt_revisions: [source], steers: [source], waits: [source], first_answer: source, present: [source.by] }, { roster }) as any
  for (const row of [mapped.prompt_revisions[0], mapped.steers[0], mapped.waits[0], mapped.first_answer]) {
    expect(actorName(row.by)).toBe("Claude Code for Ben")
    expect(row.text).toBe("Answer")
  }
  expect(actorName(mapped.present[0])).toBe("Claude Code for Ben")
  expect(source.by).toEqual({ person: "b", via: "claude-code", session: "s" })
  expect(todoActors(null)).toBeNull()
})

for (const color_index of [0, 1, 2, 3, 4, 5]) test(`inherits member color ${color_index}`, () => {
  expect(toActor({ person: "b", via: "smithers", session: "s" }, [{ ...ben, color_index }]).color_index).toBe(color_index)
})
test("registered session and run avatars remain their own", () => {
  const avatar_url = "https://example.test/agent.png"
  expect(toActor({ person: "b", via: "Aider", session: "s" }, roster, [], [{ id: "s", agent: "external", name: "Aider", avatar_url }])).toMatchObject({ avatar_url, name: "Aider", agent: "external" })
  expect(toActor({ agent: "coding", run: "r" }, roster, [{ id: "r", agent: "reviewer", avatar_url }])).toMatchObject({ avatar_url, agent: "reviewer", color_index: 6 })
  expect(actorName(toActor({ person: "b", via: "toString", session: "s" }, roster))).toBe("toString for Ben")
})
