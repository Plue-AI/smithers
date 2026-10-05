import { describe, expect, test } from "bun:test"
import type { Entry } from "@smthrs/harness/ExternalTranscript"
import { DiffCardSchema } from "@smthrs/rpc/DiffCard"
import { TimelineLineSchema } from "@smthrs/rpc/TimelineCard"
import { actsLine, externalConversation, hunksOf, placeOf, type ExternalItem } from "./ExternalEntries"
import { railLines } from "./ShellRail"
import { actorName } from "./cards/views/ActorChip"

const SESSION = "0199aaaa-1111-7222-8333-444455556666"
let seq = 0
const entry = (role: Entry["role"], part: Entry["part"], turn = "t1"): Entry => ({
  origin: "external", agent_kind: "codex", format_version: "codex-rollout/0.160", session_id: SESSION, source_id: `${SESSION}:${seq + 1}`,
  read_only: true, seq: seq++, at: Date.parse("2026-10-05T18:00:00Z") + seq * 1000, turn_id: turn, role, part
})
const tool = (command: string, status: "ok" | "error" = "ok", reads: string[] = []): Entry["part"] =>
  ({ type: "tool", call_id: `c${seq}`, command, reads, status, ...(status === "error" ? { exit_code: 1 } : {}), output: "out", duration_ms: 5 })

const entries: Entry[] = [
  entry("user", { type: "prompt", text: "Fix the retry bug\nin retry.ts" }),
  entry("user", { type: "goal", objective: "finish the spec", status: "active" }),
  entry("assistant", { type: "text", text: "I'll read the code.", final: false }),
  entry("assistant", tool("sed -n 1,40p retry.ts", "ok", ["Read retry.ts"])),
  entry("assistant", tool("go test ./retry", "error")),
  entry("assistant", { type: "search", call_id: "s1", query: "go backoff" }),
  entry("assistant", { type: "compaction" }),
  entry("assistant", { type: "edit", call_id: "e1", outcome: "applied", files: [
    { path: "/repo/retry/retry.go", change: "modified", diff: "@@ -3,2 +3,2 @@\n ctx\n-a := 1\n+a := 2\n\\ No newline at end of file\n" },
    { path: "/tmp/lane-7/pkg/new.go", change: "added", diff: "@@ -0,0 +1,2 @@\n+package pkg\n+var x = 1\n" }] }),
  entry("assistant", { type: "edit", call_id: "e2", outcome: "failed", files: [{ path: "/repo/x.go", change: "modified", diff: "" }] }),
  entry("assistant", tool("go test ./retry")),
  entry("assistant", { type: "helper", call_id: "h1", agent: "spec_audit", activity: "started" }),
  entry("assistant", { type: "reasoning", text: "Thinking about retries." }),
  entry("assistant", { type: "encrypted" }),
  entry("assistant", { type: "text", text: "**Fixed** the retry bug.", final: true }),
  entry("assistant", { type: "error", message: "Codex reported an item this release does not read: Foo" })
]
const conversation = externalConversation({ session: SESSION, owner: { login: "will", name: "William Cory" }, cwd: "/repo", entries })!

describe("externalConversation", () => {
  test("nothing shows before the host names the owner", () => {
    expect(externalConversation({ session: SESSION, entries })).toBeUndefined()
  })

  test("prompts are the owner's and everything else is Codex for the owner", () => {
    expect(actorName(conversation.owner)).toBe("William")
    expect(actorName(conversation.agent)).toBe("Codex for William")
    expect(conversation.agent).toMatchObject({ agent: "codex", session_id: SESSION })
  })

  test("items keep source order; consecutive tool steps fold into one act line; each edited file is a diff", () => {
    expect(conversation.items.map(item => [item.kind, item.kind === "message" ? item.role : item.kind === "acts" ? item.acts.length : item.kind === "diff" ? item.card.path : item.text])).toEqual([
      ["message", "user"], ["message", "user"], ["message", "assistant"],
      ["acts", 4],
      ["diff", "retry/retry.go"], ["diff", "pkg/new.go"],
      ["diff", "x.go"],
      ["error", "The edit to x.go did not apply."],
      ["acts", 2],
      ["message", "assistant"], ["message", "assistant"], ["message", "assistant"],
      ["error", "Codex reported an item this release does not read: Foo"]
    ])
    expect(conversation.items.map(item => item.id)).toEqual([...new Set(conversation.items.map(item => item.id))])
  })

  test("the goal, reasoning and an encrypted body read as words, never dropped", () => {
    const texts = conversation.items.flatMap(item => item.kind === "message" ? [item.text || item.reasoning] : [])
    expect(texts).toEqual(["Fix the retry bug\nin retry.ts", "Goal: finish the spec", "I'll read the code.", "Thinking about retries.", "Encrypted by Codex", "**Fixed** the retry bug."])
  })

  test("diffs are valid diff cards attributed to the session's burst", () => {
    for (const item of conversation.items) if (item.kind === "diff") DiffCardSchema.parse(item.card)
    const first = conversation.items.find((item): item is Extract<ExternalItem, { kind: "diff" }> => item.kind === "diff")!
    expect(first.card).toMatchObject({ branch: "repo", change: "modified", against: { kind: "burst", burst: "t1", actor: conversation.agent } })
    expect(first.card.hunks).toEqual([{ old_start: 3, new_start: 3, lines: [{ op: " ", text: "ctx" }, { op: "-", text: "a := 1" }, { op: "+", text: "a := 2" }] }])
  })

  test("an act line counts its commands, other steps and failures", () => {
    const acts = conversation.items.filter((item): item is Extract<ExternalItem, { kind: "acts" }> => item.kind === "acts")
    expect(acts.map(actsLine)).toEqual(["ran 2 commands · 2 steps · 1 failed", "ran 1 command · 1 step"])
  })
})

describe("placeOf and hunksOf", () => {
  test("paths read relative to the session directory or the checkout they sit in", () => {
    expect(placeOf("/repo/a/b.ts", "/repo")).toEqual({ branch: "repo", path: "a/b.ts" })
    expect(placeOf("/tmp/smithers-gh04/packages/x.go", "/Users/w/smithers")).toEqual({ branch: "smithers-gh04", path: "packages/x.go" })
    expect(placeOf("/private/tmp/lane/x.go", undefined)).toEqual({ branch: "lane", path: "x.go" })
    expect(placeOf("/Users/w/smithers-ui/apps/a.ts", "/elsewhere")).toEqual({ branch: "smithers-ui", path: "apps/a.ts" })
    expect(placeOf("/etc/hosts", "/repo")).toEqual({ branch: "repo", path: "/etc/hosts" })
    expect(placeOf("/etc/hosts", undefined)).toEqual({ branch: "codex", path: "/etc/hosts" })
  })

  test("hunks start at their headers; lines before the first header and markers are not file lines", () => {
    expect(hunksOf("garbage\n@@ -1 +1 @@\n-a\n+b\n@@ -10,2 +10,3 @@ func x\n c\n+d\n")).toEqual([
      { old_start: 1, new_start: 1, lines: [{ op: "-", text: "a" }, { op: "+", text: "b" }] },
      { old_start: 10, new_start: 10, lines: [{ op: " ", text: "c" }, { op: "+", text: "d" }] }
    ])
    expect(hunksOf("")).toEqual([])
  })
})

describe("the rail", () => {
  const lines = railLines(conversation.items.map(item => ({ kind: "external" as const, item, conversation })))

  test("one valid line per item with words, quoting prompts and naming each author", () => {
    for (const line of lines) TimelineLineSchema.parse(line)
    expect(lines.map(line => [line.kind, line.title, "actor" in line.glyph ? actorName(line.glyph.actor) : "event" in line.glyph ? line.glyph.event : ""])).toEqual([
      ["prompt", "“Fix the retry bug”", "William"],
      ["prompt", "“Goal: finish the spec”", "William"],
      ["answer", "I'll read the code.", "Codex for William"],
      ["event", "Ran 2 commands · 2 steps · 1 failed", "attention"],
      ["card", "Diff · retry.go", "ok"], ["card", "Diff · new.go", "ok"],
      ["card", "Diff · x.go", "ok"],
      ["event", "The edit to x.go did not apply.", "failed"],
      ["event", "Ran 1 command · 1 step", "ok"],
      ["answer", "Reasoning", "Codex for William"],
      ["answer", "Encrypted by Codex", "Codex for William"],
      ["answer", "**Fixed** the retry bug.", "Codex for William"],
      ["event", "Codex reported an item this release does not read: Foo", "failed"]
    ])
  })

  test("the import's own error shows without a conversation; a message without one does not", () => {
    expect(railLines([{ kind: "external", item: { id: "external-error", at: 0, kind: "error", text: "No Codex session ffff on this machine." } }]))
      .toEqual([{ entry_id: "external-error", kind: "event", title: "No Codex session ffff on this machine.", tone: "failed", glyph: { event: "failed" } }])
    expect(railLines([{ kind: "external", item: { id: "m", at: 0, kind: "message", role: "user", text: "hi" } }])).toEqual([])
  })
})
