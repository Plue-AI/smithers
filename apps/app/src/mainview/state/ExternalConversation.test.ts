import { expect, test } from "bun:test"
import journal from "./testdata/external-journal-conversations.json"
import { SharedConversationSchema } from "./seams/SharedConversationSeam"
import fixtures from "./testdata/external-conversations.json"
import { FrameSnapshotSchema, MessageSchema } from "./AppState"

const records = fixtures.map(row => MessageSchema.parse(row))

test("shared decoder and branch snapshots retain imported identity and tool correlation", () => {
  const snapshot = FrameSnapshotSchema.parse({ revision: 1, messages: records, cards: [], worldDocuments: [], draft: "" })
  expect(snapshot.messages.map(row => row.id)).toEqual([
    "message-imported-user", "external-claude-tool", "external-claude-error", "external-codex-answer"
  ])
  expect(snapshot.messages[1]?.correlation_id).toBe("tool-1")
  expect(snapshot.messages[2]?.correlation_id).toBe("tool-1")
  expect(snapshot.messages[3]?.participant_id).toBe("participant-codex")
  expect(MessageSchema.parse(JSON.parse(JSON.stringify(records[3])))).toEqual(records[3])
})

for (const key of ["origin", "agent_kind", "format_version", "source_id", "session_id", "participant_id", "actor", "read_only"]) {
  test(`external record missing ${key} fails closed`, () => {
    const row: Record<string, unknown> = { ...fixtures[1] }
    delete row[key]
    expect(MessageSchema.safeParse(row).success).toBe(false)
  })
}
for (const field of ["agent_kind", "session_id", "participant_id", "format_version", "source_id"]) {
  test(`external ${field} cannot be empty`, () => {
    expect(MessageSchema.safeParse({ ...fixtures[1], [field]: " " }).success).toBe(false)
  })
}
for (const actor of [
  { ...fixtures[1]!.actor, id: "different-participant" },
  { ...fixtures[1]!.actor, id: "" },
  { ...fixtures[1]!.actor, for_member: { ...fixtures[1]!.actor.for_member, login: "" } },
  { ...fixtures[1]!.actor, session_id: "different-session" },
  { ...fixtures[1]!.actor, agent: "codex" },
  { ...fixtures[1]!.actor, for_member: undefined },
  { kind: "system", color_index: 0 }
]) test("external assistant cannot impersonate another participant", () => {
  expect(MessageSchema.safeParse({ ...fixtures[1], actor }).success).toBe(false)
})
for (const executable of [
  { turnId: "run-imported" }, { action: { flow: "flow.run", label: "Run" } },
  { answeredAction: { flow: "approve", label: "Approve", answer: "yes", answeredAt: 1 } },
  { disclosed: ["flow.run"] }, { read_only: false }, { origin: "smithers" }
]) test("external record cannot gain executable authority", () => {
  expect(MessageSchema.safeParse({ ...fixtures[1], ...executable }).success).toBe(false)
})

test("ordinary saved messages retain their original shape", () => {
  const row = { id: "ordinary", role: "user", text: "Hello", status: "complete", ordinal: 1, createdAt: 1 } as const
  expect(MessageSchema.parse(row)).toEqual(row)
})

test("external actor without origin cannot become an ordinary Smithers message", () => {
  expect(MessageSchema.safeParse({ id: "forged", role: "smithers", text: "Hello", status: "complete",
    createdAt: 1, ordinal: 1, actor: fixtures[1]!.actor }).success).toBe(false)
})


test("journal delivery preserves owner, participants, order and inert tool parts", () => {
  const decoded = SharedConversationSchema.parse({ id: "main", entries: journal }).entries
  expect(decoded.map(entry => "role" in entry ? [entry.role, entry.actor?.kind, entry.ordinal, entry.correlation_id] : [])).toEqual([
    ["user", "person", 0, undefined], ["smithers", "agent", 1, "tool-1"],
    ["smithers", "agent", 2, "tool-1"], ["smithers", "agent", 3, undefined]
  ])
  expect(decoded[0]).toMatchObject({ actor: { name: "Ben", login: "ben" }, text: "Run the webhook tests" })
  expect(decoded[1]).toMatchObject({ act: "tool-pending", participant_id: "participant-claude" })
  expect(decoded[2]).toMatchObject({ status: "failed", text: "Tests failed" })
  expect(decoded[3]).toMatchObject({ participant_id: "participant-codex", read_only: true })
})

for (const patch of [{ author_id: "forged" }, { owner_id: "forged" }, { source_format_version: "unknown" }, { read_only: false }, { agent: "smithers" }]) {
  test(`journal identity refuses ${JSON.stringify(patch)}`, () => {
    expect(SharedConversationSchema.safeParse({ id: "main", entries: [{ ...journal[1], ...patch }] }).success).toBe(false)
  })
}

test("journal object and thinking bodies remain inert shared message data", () => {
  const entries = SharedConversationSchema.parse({ id: "main", entries: [
    { ...journal[1], body: { name: "Bash", input: { command: "touch /tmp/forged" } }, action: { flow: "flow.run" } },
    { ...journal[1], kind: "thinking", body: "Consider the tests" }
  ] }).entries
  expect(entries[0]).toMatchObject({ text: '{\n  "name": "Bash",\n  "input": {\n    "command": "touch /tmp/forged"\n  }\n}' })
  expect(entries[0]).not.toHaveProperty("action")
  expect(entries[0]).not.toHaveProperty("turnId")
  expect(entries[1]).toMatchObject({ text: "", reasoning: "Consider the tests" })
})
