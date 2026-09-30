import { describe, expect, it } from "bun:test"
import * as Complete from "../src/complete.ts"
import * as Editor from "../src/editor.ts"
import type * as Flows from "../src/flows.ts"
import * as Palette from "../src/palette.ts"
import type { Tab } from "../src/workspace.ts"

const files = ["README.md", "src/app.tsx", "src/view.tsx", "test/app.test.ts", "docs/my notes.md"]
const tab = (id: string, title: string, status: Tab["status"]): Tab => ({
  id,
  title,
  status,
  prompt: "p",
  seat: "s",
  file: `${id}.jsonl`,
  startedAt: 0,
  depth: 0
})
const sessions = [
  { file: "/s/b.jsonl", name: "Fix the build", firstPrompt: "fix it", modified: 1_000 },
  { file: "/s/a.jsonl", name: undefined, firstPrompt: "add a view\nsecond line", modified: 500 }
]
const sources: Palette.Sources = {
  commands: Editor.commands,
  files: () => files,
  sessions,
  tabs: [tab("w1", "Investigation", "running"), tab("w2", "Docs pass", "done")],
  hits: [{ path: "math.js", line: 1, text: "  export const add = (a, b) => a - b" }],
  now: 2_000
}
const rows = (raw: string, extra: Partial<Palette.Sources> = {}) =>
  Palette.rows(Palette.parse(raw), { ...sources, ...extra })

describe("parse", () => {
  it("reads the first token as the mode, like the web palette", () => {
    expect(Palette.parse("")).toMatchObject({ mode: "all", query: "" })
    expect(Palette.parse("/res")).toMatchObject({ mode: "commands", query: "res" })
    expect(Palette.parse("text:a - b")).toEqual({ mode: "text", prefix: "text:", query: "a - b" })
    expect(Palette.parse("text:/a.+b/")).toMatchObject({ mode: "text", regex: "a.+b" })
    expect(Palette.parse("conversation:fix")).toMatchObject({ mode: "sessions", query: "fix" })
    expect(Palette.parse("tab:w1")).toMatchObject({ mode: "tabs", query: "w1" })
    expect(Palette.parse("?")).toMatchObject({ mode: "help" })
    expect(Palette.parse("  text:x")).toMatchObject({ mode: "text", query: "x" })
    expect(Palette.parse("notes: hi")).toMatchObject({ mode: "all", query: "notes: hi" })
  })
})

describe("rows", () => {
  it("lists commands before files, ranks files by name, and caps files", () => {
    const all = rows("")
    expect(all[0]).toMatchObject({ label: "/model", value: { kind: "command", name: "model" } })
    const firstFile = all.findIndex((row) => row.value.kind === "file")
    expect(all.slice(0, firstFile).every((row) => row.value.kind === "command")).toBe(true)
    const view = rows("view").filter((row) => row.value.kind === "file")
    expect(view[0]?.value).toEqual({ kind: "file", path: "src/view.tsx" })
    const many = Array.from({ length: 50 }, (_, index) => `f${index}.ts`)
    expect(rows("f", { files: () => many }).filter((row) => row.value.kind === "file")).toHaveLength(Complete.fileLimit)
  })

  it("offers only commands after /", () => {
    const commands = rows("/")
    expect(commands.length).toBe(Editor.commands.length)
    expect(commands.every((row) => row.value.kind === "command")).toBe(true)
    expect(rows("/rsm").map((row) => row.label)).toEqual(["/resume"])
  })

  it("lists rg hits as path:line with the line text", () => {
    expect(rows("text:a - b")).toEqual([
      {
        key: "hit:math.js:1",
        label: "math.js:1",
        detail: "export const add = (a, b) => a - b",
        value: { kind: "hit", path: "math.js", line: 1 }
      }
    ])
  })

  it("draws awkward file and hit names on one line and keeps the exact path in values and mentions", () => {
    const odd = ["new\nline.ts", "tab\there.ts", "café 日本.ts", "say \"hi\"\\x.ts"]
    const fileRows = rows("", { commands: [], files: () => odd }).filter((row) => row.value.kind === "file")
    expect(fileRows.map((row) => row.label).sort()).toEqual(
      ["new\\nline.ts", "tab\\there.ts", "café 日本.ts", "say \"hi\"\\x.ts"].sort()
    )
    expect(fileRows.map((row) => row.value).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))))
      .toEqual(
        odd.map((path) => ({ kind: "file" as const, path })).sort((a, b) =>
          JSON.stringify(a).localeCompare(JSON.stringify(b))
        )
      )
    const hits = rows("text:x", { hits: [{ path: "new\nline.ts", line: 3, text: "\ta\tb\u0007 café" }] })
    expect(hits).toEqual([
      {
        key: "hit:new\nline.ts:3",
        label: "new\\nline.ts:3",
        detail: "a\\tb\\u0007 café",
        value: { kind: "hit", path: "new\nline.ts", line: 3 }
      }
    ])
    for (const row of [...fileRows, ...hits]) {
      expect(`${row.label}${row.detail ?? ""}`).not.toMatch(/[\u0000-\u001f\u007f]/)
    }
    expect(Palette.mention("new\nline.ts", 3)).toBe("@\"new\\nline.ts\":3 ")
    expect(Palette.mention("say \"hi\"\\x.ts")).toBe("@\"say \\\"hi\\\"\\\\x.ts\" ")
  })

  it("filters worker tabs by title and status", () => {
    expect(rows("tab:inv").map((row) => row.value)).toEqual([{ kind: "tab", id: "w1" }])
    expect(rows("tab:done").map((row) => row.label)).toEqual(["Docs pass"])
    expect(rows("tab:")[0]).toMatchObject({ label: "Investigation", hint: "running" })
  })

  it("lists sessions exactly as /resume does", () => {
    const listed = rows("conversation:")
    expect(listed.map((row) => row.value)).toEqual([{ kind: "session", file: "/s/b.jsonl" }, {
      kind: "session",
      file: "/s/a.jsonl"
    }])
    expect(listed.map((row) => row.label)).toEqual(Palette.sessionRows(sessions, "", 2_000).map((row) => row.label))
    expect(listed.map((row) => row.label)).toEqual(["Fix the build", "add a view"])
    expect(rows("conversation:view").map((row) => row.label)).toEqual(["add a view"])
    expect(rows("conversation:", { sessions: undefined })).toEqual([])
  })

  it("lists the prefixes after ?", () => {
    expect(rows("?").map((row) => row.value)).toEqual([
      { kind: "prefix", prefix: "/" },
      { kind: "prefix", prefix: "text:" },
      { kind: "prefix", prefix: "conversation:" },
      { kind: "prefix", prefix: "tab:" }
    ])
  })
})

describe("mentions", () => {
  it("writes @path and @path:line, quoting paths with spaces", () => {
    expect(Palette.mention("src/a.ts", 12)).toBe("@src/a.ts:12 ")
    expect(Palette.mention("docs/my notes.md")).toBe("@\"docs/my notes.md\" ")
  })

  it("inserts at the cursor with a separating space, merging a trailing one", () => {
    expect(Palette.insertAt("look at", 7, "@x ")).toEqual({ text: "look at @x ", cursor: 11 })
    expect(Palette.insertAt("", 0, "@x ")).toEqual({ text: "@x ", cursor: 3 })
    expect(Palette.insertAt("a  b", 2, "@x ")).toEqual({ text: "a @x b", cursor: 5 })
  })
})

describe("contributed actions", () => {
  it("lists contributed keys and status items in the plain search and picks their action", () => {
    const actions = [{
      key: "repo:review/alt+r",
      label: "Review",
      hint: "alt+r",
      action: { kind: "flow" as const, flow: "review" }
    }]
    const found = rows("revi", { actions })
    expect(found[0]).toMatchObject({
      label: "Review",
      hint: "alt+r",
      value: { kind: "action", action: { kind: "flow", flow: "review" } }
    })
    expect(rows("/revi", { actions }).some((row) => row.value.kind === "action")).toBe(false)
  })
})

describe("built-in actions", () => {
  const run = (id: string, status: Flows.Run["status"]): Flows.Run => ({
    id,
    flow: `flow-${id}`,
    by: "user",
    input: {},
    requested: "{}",
    status,
    startedAt: 0
  })
  const acts = (input: Partial<Parameters<typeof Palette.actions>[0]> = {}) =>
    Palette.actions({ diff: false, tabs: [], runs: [], monitors: [], views: [], ...input })

  it("always offers undo and the wrapped workers, and the diff keys only on a view", () => {
    expect(acts().map((row) => [row.label, row.hint])).toEqual([
      ["Undo…", "u"],
      ["Run Claude Code…", undefined],
      ["Run Codex…", undefined]
    ])
    expect(acts({ diff: true }).map((row) => [row.label, row.hint]).slice(1, 3)).toEqual([
      ["Diff", "d"],
      ["Split diff", "v"]
    ])
  })

  it("finds a captured worker run's diff by title and keeps its target and key", () => {
    const worker = tab("fixer", "Fixer", "done")
    const listed = acts({ diffs: [worker] })
    expect(rows("diff fixer", { acts: listed })).toMatchObject([{
      label: "Diff",
      detail: "Fixer",
      hint: "d",
      value: { kind: "act", act: { act: "review", id: "fixer" } }
    }])
    expect(acts().some((row) => row.act.act === "review")).toBe(false)
    expect(rows("/diff", { acts: listed }).some((row) => row.value.kind === "act")).toBe(false)
  })

  it("lists each worker's allowed actions with their keys and no action its status refuses", () => {
    const listed = acts({ tabs: [tab("w1", "Investigation", "running"), tab("w2", "Docs pass", "failed")] })
    const worker = listed.filter((row) => row.act.act === "worker")
    expect(worker.map((row) => [row.label, row.detail, row.hint])).toEqual([
      ["Stop", "Investigation", "x"],
      ["Steer", "Investigation", "s"],
      ["Take over", "Investigation", "t"],
      ["Resume", "Docs pass", "r"],
      ["Switch model", "Docs pass", "m"]
    ])
    expect(worker[0]!.act).toEqual({ act: "worker", id: "w1", action: "stop" })
    expect(worker.some((row) => row.detail === "Investigation" && row.label === "Resume")).toBe(false)
  })

  it("lists a flow run's stop while it runs and its resume once stopped, never both", () => {
    const listed = acts({ runs: [run("a", "running"), run("b", "cancelled"), run("c", "done")] })
      .filter((row) => row.act.act === "run")
    expect(listed.map((row) => [row.label, row.detail, row.hint, row.act])).toEqual([
      ["Stop", "flow-a", "x", { act: "run", id: "a", action: "stop" }],
      ["Resume", "flow-b", "r", { act: "run", id: "b", action: "retry" }]
    ])
  })

  it("lists a stop for each active monitor and every custom view by title", () => {
    const listed = acts({
      monitors: [
        { id: "ci", title: "CI watcher", status: "active" },
        { id: "old", title: "Old watcher", status: "stopped" }
      ],
      views: [{ id: "checks", title: "Addition checks" }]
    })
    expect(listed.filter((row) => row.act.act === "monitor").map((row) => [row.label, row.detail, row.hint]))
      .toEqual([["Stop", "CI watcher", "x"]])
    expect(listed.find((row) => row.act.act === "view")).toMatchObject({
      label: "Addition checks",
      act: { act: "view", id: "checks" }
    })
  })

  it("finds an action by its words or its target in the plain search, never after /", () => {
    const listed = acts({ tabs: [tab("w1", "Investigation", "running")] })
    expect(rows("undo", { acts: listed })[0]).toMatchObject({
      label: "Undo…",
      hint: "u",
      value: { kind: "act", act: { act: "undo" } }
    })
    expect(rows("stop inv", { acts: listed }).map((row) => row.value)[0]).toEqual({
      kind: "act",
      act: { act: "worker", id: "w1", action: "stop" }
    })
    expect(rows("claude", { acts: listed }).map((row) => row.label)).toContain("Run Claude Code…")
    expect(rows("/undo", { acts: listed }).some((row) => row.value.kind === "act")).toBe(false)
  })
})
