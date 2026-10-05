import { describe, expect, test } from "bun:test"
import type { Entry } from "@smthrs/harness/ExternalTranscript"
import { DiffCardSchema } from "@smthrs/rpc/DiffCard"
import { TimelineLineSchema } from "@smthrs/rpc/TimelineCard"
import { actsLine, clip, clipDiff, externalConversation, hunksOf, placeOf, type ExternalItem } from "./ExternalEntries"
import { railLines, railTimes } from "./ShellRail"
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
const conversation = externalConversation({ agent: "codex", session: SESSION, owner: { login: "will", name: "William Cory" }, cwd: "/repo", entries })!

describe("externalConversation", () => {
  test("nothing shows before the host names the owner", () => {
    expect(externalConversation({ agent: "codex", session: SESSION, entries })).toBeUndefined()
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

  test("a Claude Code session is Claude Code for the owner, with its own participant", () => {
    const claude = externalConversation({ agent: "claude-code", session: "5b2c9e10", owner: { login: "ben", name: "Ben Ito" },
      entries: [entry("assistant", { type: "encrypted" }), entry("assistant", { type: "edit", call_id: "e9", outcome: "applied", files: [{ path: "/etc/x", change: "modified", diff: "" }] })] })!
    expect(actorName(claude.agent)).toBe("Claude Code for Ben")
    expect(claude.agent).toMatchObject({ id: "claude-code:5b2c9e10", agent: "claude-code", session_id: "5b2c9e10" })
    expect(claude.agent.id).not.toBe(conversation.agent.id)
    expect(claude.items.map(item => item.kind === "message" ? item.text : item.kind === "diff" ? item.card.branch : "")).toEqual(["Encrypted by Claude Code", "claude-code"])
  })

  test("long command output and long diffs are clipped for display", () => {
    const long = externalConversation({ agent: "codex", session: SESSION, owner: { login: "will", name: "William Cory" }, cwd: "/repo", entries: [
      entry("assistant", { type: "tool", call_id: "c", command: "make", reads: [], status: "ok", output: `${"x".repeat(9_000)}END`, duration_ms: 1 }),
      entry("assistant", { type: "edit", call_id: "e", outcome: "applied", files: [{ path: "/repo/a.ts", change: "modified",
        diff: `@@ -1,1 +1,4000 @@\n${Array.from({ length: 4_000 }, (_, index) => `+line ${index}`).join("\n")}` }] })] })!
    const [acts, diff] = long.items
    const output = acts?.kind === "acts" && acts.acts[0]?.type === "tool" ? acts.acts[0].output : ""
    expect(output.endsWith("END") && output.includes("lines omitted")).toBe(true)
    expect(diff?.kind === "diff" ? diff.card.hunks[0]!.lines.length : 0).toBeLessThan(4_000)
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
    expect(placeOf("/repo/a/b.ts", "/repo", "codex")).toEqual({ branch: "repo", path: "a/b.ts" })
    expect(placeOf("/tmp/smithers-gh04/packages/x.go", "/Users/w/smithers", "codex")).toEqual({ branch: "smithers-gh04", path: "packages/x.go" })
    expect(placeOf("/private/tmp/lane/x.go", undefined, "codex")).toEqual({ branch: "lane", path: "x.go" })
    expect(placeOf("/Users/w/smithers-ui/apps/a.ts", "/elsewhere", "codex")).toEqual({ branch: "smithers-ui", path: "apps/a.ts" })
    expect(placeOf("/etc/hosts", "/repo", "codex")).toEqual({ branch: "repo", path: "/etc/hosts" })
    expect(placeOf("/etc/hosts", undefined, "codex")).toEqual({ branch: "codex", path: "/etc/hosts" })
    expect(placeOf("/etc/hosts", undefined, "claude-code")).toEqual({ branch: "claude-code", path: "/etc/hosts" })
  })

  test("clip keeps output's start and end; clipDiff ends a long diff at a whole line", () => {
    expect(clip("short")).toBe("short")
    expect(clip("a\nb\nc\nd\ne", 2, 2)).toBe("a\n\n… 3 lines omitted …\n\ne")
    const diff = Array.from({ length: 4_000 }, (_, index) => `+line ${index}`).join("\n")
    const shown = clipDiff(diff)
    expect(shown.length).toBeLessThanOrEqual(24_000)
    expect(shown.endsWith("\n")).toBe(true)
    expect(clipDiff("+a\n")).toBe("+a\n")
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

describe("railTimes", () => {
  test("each timed entry gives its time to the zoom's spans; entries without one give none", () => {
    const item = conversation.items[0]!
    const times = railTimes([
      { kind: "external", item, conversation },
      { kind: "message", message: { id: "m1", role: "user", text: "hi", status: "complete", createdAt: 5_000, ordinal: 1 } },
      { kind: "card", card: { id: "c1", kind: "status", title: "t", status: "active", createdAt: 7_000, ordinal: 2, payload: {} } as never },
      { kind: "init", message: { id: "init" } as never }
    ])
    expect([...times]).toEqual([[item.id, item.at], ["m1", 5_000], ["c1", 7_000]])
  })
})
