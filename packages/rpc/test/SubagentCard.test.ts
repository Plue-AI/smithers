import { describe, expect, test } from "vitest"
import * as SubagentCard from "../src/SubagentCard.ts"
import type { Status } from "../src/WorkerControls.ts"

const statuses: ReadonlyArray<Status> = [
  "requested",
  "queued",
  "running",
  "waiting",
  "parked",
  "done",
  "failed",
  "cancelled"
]

describe("status glyph", () => {
  test("turns ◐◓◑◒ every 150 ms and wraps", () => {
    expect([0, 149, 150, 300, 450, 600].map(SubagentCard.spinner)).toEqual(["◐", "◐", "◓", "◑", "◒", "◐"])
    expect(SubagentCard.spinner(-10)).toBe("◐")
  })

  test("spins moving work and shows ● for held or settled work", () => {
    const at = 150
    expect(Object.fromEntries(statuses.map((status) => [status, SubagentCard.glyph(status, at)]))).toEqual({
      requested: { glyph: "◓", tone: "waiting" },
      queued: { glyph: "●", tone: "waiting" },
      running: { glyph: "◓", tone: "running" },
      waiting: { glyph: "◓", tone: "waiting" },
      parked: { glyph: "●", tone: "waiting" },
      done: { glyph: "●", tone: "done" },
      failed: { glyph: "●", tone: "failed" },
      cancelled: { glyph: "●", tone: "stopped" }
    })
  })
})

describe("activity rows", () => {
  const read = { kind: "tool", tool: "read", state: "done", target: "auth/login.ts" } as const

  test("uses pending and done verbs with counts and marks", () => {
    expect(SubagentCard.describe(read)).toEqual({ text: "Read auth/login.ts", mark: "✓", state: "done" })
    expect(SubagentCard.describe({ kind: "tool", tool: "edit", state: "pending", target: "login.ts" }))
      .toEqual({ text: "Editing login.ts…", mark: "", state: "pending" })
    expect(
      SubagentCard.describe({ kind: "tool", tool: "edit", state: "done", target: "login.ts", added: 18, removed: 4 })
    ).toEqual({ text: "Edited login.ts +18 -4", mark: "✓", state: "done" })
    expect(SubagentCard.describe({ kind: "tool", tool: "bash", state: "error", target: "bun test auth" }))
      .toEqual({ text: "Ran bun test auth", mark: "✗", state: "error" })
  })

  test("prefers the tool's own verbs, capitalized, and names an unknown tool", () => {
    const verb = { pending: "reading", done: "read" }
    expect(SubagentCard.describe({ kind: "tool", tool: "x", state: "pending", target: "a", verb }).text)
      .toBe("Reading a…")
    expect(SubagentCard.describe({ kind: "tool", tool: "web.fetch", state: "done", target: "https://x" }).text)
      .toBe("Called web.fetch https://x")
    expect(SubagentCard.describe({ kind: "tool", tool: "agent.delegate", state: "done", target: "backfill" }).text)
      .toBe("Delegated backfill")
  })

  test("cuts a command or text to its first line", () => {
    expect(
      SubagentCard.describe({ kind: "tool", tool: "bash", state: "done", target: "\n  bun   test\nsecond line" }).text
    ).toBe("Ran bun test")
    expect(SubagentCard.describe({ kind: "text", text: "Waiting on backfill…\nmore" }))
      .toEqual({ text: "Waiting on backfill…", mark: "", state: "text" })
  })

  test("shows the last five with ├ and └ and counts the rest as earlier", () => {
    const entries = Array.from({ length: 12 }, (_, index) => ({ ...read, target: `f${index}.ts` }))
    const shown = SubagentCard.activity(entries)
    expect(shown.hidden).toBe(7)
    expect(shown.earlier).toBe("… +7 earlier")
    expect(shown.rows.map((row) => SubagentCard.line(row))).toEqual([
      "├ Read f7.ts ✓",
      "├ Read f8.ts ✓",
      "├ Read f9.ts ✓",
      "├ Read f10.ts ✓",
      "└ Read f11.ts ✓"
    ])
  })

  test("hides nothing when every entry fits, and draws nothing for none", () => {
    const shown = SubagentCard.activity([read, { kind: "text", text: "ok" }])
    expect(shown.earlier).toBeUndefined()
    expect(shown.rows.map((row) => row.branch)).toEqual(["├", "└"])
    expect(SubagentCard.activity([])).toEqual({ hidden: 0, earlier: undefined, rows: [] })
  })

  test("clips a row to its width but keeps the mark", () => {
    const row = { branch: "├", text: "Edited a/very/long/path.ts +18 -4", mark: "✓", state: "done" } as const
    expect(SubagentCard.line(row, 16)).toBe("├ Edited a/ve… ✓")
    expect([...SubagentCard.line(row, 16)]).toHaveLength(16)
    expect(SubagentCard.line({ ...row, mark: "", state: "pending" }, 10)).toBe("├ Edited …")
    expect(SubagentCard.clip("abc", 3)).toBe("abc")
    expect(SubagentCard.clip("abc", 0)).toBe("")
  })

  test("counts a unified diff's lines without its headers", () => {
    const diff = "--- a/x.ts\n+++ b/x.ts\n@@ -1,2 +1,3 @@\n-old\n+new\n+more\n same"
    expect(SubagentCard.diffCounts(diff)).toEqual({ added: 2, removed: 1 })
    expect(SubagentCard.counts(0, 0)).toBe("")
    expect(SubagentCard.counts(44)).toBe(" +44")
    expect(SubagentCard.counts(0, 3)).toBe(" -3")
  })
})

describe("files line", () => {
  test("sums per path and toggles a ├/└ list", () => {
    const changes = [
      { path: "login.ts", added: 10, removed: 4 },
      { path: "limit.ts", added: 13, removed: 2 },
      { path: "login.ts", added: 8, removed: 0 }
    ]
    expect(SubagentCard.files(changes)).toEqual({ line: "▸ 2 files +31 -6", rows: [] })
    expect(SubagentCard.files(changes, true)).toEqual({
      line: "▾ 2 files +31 -6",
      rows: [{ branch: "├", text: "login.ts +18 -4" }, { branch: "└", text: "limit.ts +13 -2" }]
    })
    expect(SubagentCard.files([{ path: "0042.sql", added: 44, removed: 0 }])?.line).toBe("▸ 1 file +44")
  })

  test("draws nothing without changes", () => {
    expect(SubagentCard.files(undefined)).toBeUndefined()
    expect(SubagentCard.files([])).toBeUndefined()
  })
})

describe("footer", () => {
  test("prints durations in seconds, minutes and hours", () => {
    expect([0, 999, 42_000, 60_000, 63_000, 64_900, 3_599_000, 7_200_000, 7_500_000].map(SubagentCard.duration))
      .toEqual(["0s", "0s", "42s", "1m", "1m 03s", "1m 04s", "59m 59s", "2h", "2h 05m"])
    expect(SubagentCard.duration(-5)).toBe("0s")
  })

  test("ticks while live and names the settlement once settled", () => {
    const base = { startedAt: 1_000, model: "sol" }
    expect(SubagentCard.footer({ ...base, status: "running" }, 43_000))
      .toEqual({ clock: "42s", text: "42s · sol", aside: "" })
    expect(SubagentCard.footer({ ...base, status: "done", endedAt: 65_000, model: "luna" }, 999_999).text)
      .toBe("Done 1m 04s · luna")
    expect(SubagentCard.footer({ startedAt: 0, endedAt: 60_000, status: "failed" }, 90_000))
      .toEqual({ clock: "Failed 1m", text: "Failed 1m", aside: "" })
    expect(SubagentCard.footer({ startedAt: 0, endedAt: 63_000, status: "cancelled" }, 90_000).clock)
      .toBe("Stopped 1m 03s")
  })

  test("sets a held status aside", () => {
    const at = (status: Status) => SubagentCard.footer({ startedAt: 0, status }, 38_000).aside
    expect(statuses.map(at)).toEqual(["", "queued", "", "waiting", "parked", "", "", ""])
  })
})

describe("batch header", () => {
  test("counts settled subagents and fills the bar while any run", () => {
    const value = SubagentCard.header(["done", "running", "waiting"], 0)
    expect(value).toEqual({
      glyph: "◐",
      tone: "running",
      text: "Running 3 subagents",
      count: "(1/3)",
      mark: "",
      bar: ["done", "pending", "pending"]
    })
    expect(SubagentCard.headerLine(value)).toBe("◐ Running 3 subagents (1/3)")
    expect(SubagentCard.headerLine(SubagentCard.header(["running"], 150))).toBe("◓ Running 1 subagent (0/1)")
  })

  test("says Ran with ✓, or ✗ when any failed, once all settle", () => {
    const ran = SubagentCard.header(["done", "cancelled", "done"], 0)
    expect(SubagentCard.headerLine(ran)).toBe("Ran 3 subagents ✓")
    expect(ran.tone).toBe("done")
    expect(ran.bar).toEqual(["done", "done", "done"])
    const failed = SubagentCard.header(["done", "failed"], 0)
    expect(SubagentCard.headerLine(failed)).toBe("Ran 2 subagents ✗")
    expect(failed.tone).toBe("failed")
    expect(SubagentCard.barGlyph).toBe("▰")
  })
})

describe("card", () => {
  const subagent: SubagentCard.Subagent = {
    title: "auth-audit: rate-limit login",
    status: "running",
    model: "sol",
    startedAt: 0,
    entries: [
      ...Array.from({ length: 7 }, () => ({ kind: "text" as const, text: "thinking" })),
      { kind: "tool", tool: "read", state: "done", target: "auth/login.ts" },
      { kind: "tool", tool: "grep", state: "done", target: "\"attempts\"" },
      { kind: "tool", tool: "edit", state: "done", target: "login.ts", added: 18, removed: 4 },
      { kind: "tool", tool: "bash", state: "error", target: "bun test auth" },
      { kind: "tool", tool: "edit", state: "pending", target: "login.ts" }
    ],
    files: [{ path: "login.ts", added: 18, removed: 4 }, { path: "limit.ts", added: 13, removed: 2 }]
  }

  test("projects the approved mock's first card", () => {
    const value = SubagentCard.card(subagent, 42_000)
    expect(value.glyph).toBe("◐")
    expect(value.tone).toBe("running")
    expect([
      `${value.glyph} ${value.title}`,
      value.activity.earlier,
      ...value.activity.rows.map((row) => SubagentCard.line(row)),
      value.files?.line,
      value.footer.text
    ]).toEqual([
      "◐ auth-audit: rate-limit login",
      "… +7 earlier",
      "├ Read auth/login.ts ✓",
      "├ Searched \"attempts\" ✓",
      "├ Edited login.ts +18 -4 ✓",
      "├ Ran bun test auth ✗",
      "└ Editing login.ts…",
      "▸ 2 files +31 -6",
      "42s · sol"
    ])
    expect(value.height).toBe(9)
  })

  test("grows by the open files list and shrinks without earlier or files", () => {
    expect(SubagentCard.card(subagent, 0, { open: true }).height).toBe(11)
    const docs = SubagentCard.card({
      title: "docs",
      status: "done",
      startedAt: 0,
      endedAt: 64_000,
      model: "luna",
      entries: [{ kind: "tool", tool: "read", state: "done", target: "docs/auth.md" }]
    }, 99_000)
    expect(docs.glyph).toBe("●")
    expect(docs.files).toBeUndefined()
    expect(docs.footer.text).toBe("Done 1m 04s · luna")
    expect(docs.height).toBe(3)
  })

  test("gives toasts and the finished row the card's words", () => {
    expect(SubagentCard.toast({ title: "auth-audit", status: "running", startedAt: 0 }, 42_000))
      .toEqual({ glyph: "◐", tone: "running", text: "auth-audit · 42s", line: "◐ auth-audit · 42s" })
    expect(SubagentCard.toast({ title: "docs", status: "done", startedAt: 0, endedAt: 64_000 }, 99_000).line)
      .toBe("● docs · Done 1m 04s")
    expect(SubagentCard.finished("docs")).toEqual({
      glyph: "◉",
      tone: "done",
      title: "docs",
      line: "◉ docs finished"
    })
    expect(SubagentCard.finished("db", "failed").tone).toBe("failed")
  })
})

describe("grid", () => {
  const widths = (width: number, count: number) =>
    SubagentCard.grid(width, count).map((row) => row.map((cell) => cell.width))

  test("fits as many 34-column cards as the width allows, at most four", () => {
    expect(SubagentCard.columns(33, 3)).toBe(1)
    expect(SubagentCard.columns(68, 3)).toBe(1)
    expect(SubagentCard.columns(69, 3)).toBe(2)
    expect(SubagentCard.columns(200, 9)).toBe(4)
    expect(SubagentCard.columns(200, 2)).toBe(2)
    expect(SubagentCard.columns(200, 0)).toBe(1)
  })

  test("fills each row with 1-column gaps and stretches the last row", () => {
    expect(widths(80, 3)).toEqual([[40, 39], [80]])
    expect(widths(104, 3)).toEqual([[34, 34, 34]])
    expect(widths(120, 5)).toEqual([[40, 39, 39], [60, 59]])
    expect(widths(20, 2)).toEqual([[20], [20]])
    expect(SubagentCard.grid(80, 0)).toEqual([])
    const row = SubagentCard.grid(120, 3)[0]!
    expect(row.map((cell) => cell.x)).toEqual([0, 41, 81])
    expect(row.at(-1)!.x + row.at(-1)!.width).toBe(120)
    expect(SubagentCard.grid(80, 3).flat().map((cell) => [cell.index, cell.row])).toEqual([[0, 0], [1, 0], [2, 1]])
  })

  test("gives each row its tallest card's height", () => {
    const layout = SubagentCard.grid(80, 3)
    expect(SubagentCard.rowHeights(layout, [9, 4, 3])).toEqual([9, 3])
  })
})
