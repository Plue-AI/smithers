import { testRender } from "@opentui/react/test-utils"
import * as SubagentCard from "@smthrs/rpc/SubagentCard"
import { afterEach, describe, expect, it } from "bun:test"
import { act } from "react"
import * as SubagentView from "../src/subagent-view.tsx"
import * as Subagents from "../src/subagents.ts"
import { color } from "../src/theme.ts"
import * as Timeline from "../src/timeline.ts"
import * as Transcript from "../src/transcript.ts"
import * as Tree from "../src/tree.ts"
import type { Tab } from "../src/workspace.ts"

const models = [{ seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "openai" }]
const tab = (id: string, status: Tab["status"], extra: Partial<Tab> = {}): Tab => ({
  id,
  depth: 0,
  title: id,
  prompt: `Do ${id}.`,
  seat: "openai:gpt-6-sol",
  file: `/tmp/${id}.jsonl`,
  status,
  startedAt: 0,
  ...extra
})
const event = (value: unknown) => value as Parameters<typeof Transcript.apply>[1]
/** A cell that writes `prose` and makes `calls`, each settled unless it is `running`. */
const cell = (
  transcript: Transcript.Transcript,
  at: number,
  prose: string,
  calls: ReadonlyArray<{ flow: string; input: unknown; outcome?: "success" | "failure" | "running" }>
): Transcript.Transcript => {
  let next = Transcript.apply(transcript, event({ _tag: "model-requested" }), at)
  next = Transcript.apply(
    next,
    event({ _tag: "model-delta", delta: { type: "text-delta", text: `${prose}\n\`\`\`js\nx\n\`\`\`` } }),
    at
  )
  next = Transcript.apply(next, event({ _tag: "cell-produced", cell: { text: "x" } }), at)
  calls.forEach((call, index) => {
    const identity = { session: "s", frame: at, cell: 1, ordinal: index }
    next = Transcript.apply(
      next,
      event({ _tag: "cell-call-started", call: { flowName: call.flow, input: call.input, identity } }),
      at + index + 1
    )
    if (call.outcome === "running") return
    next = Transcript.apply(
      next,
      event({
        _tag: "cell-call-settled",
        flowName: call.flow,
        identity,
        result: call.outcome === "failure"
          ? { outcome: "failure", message: "exit 1" }
          : { outcome: "success", value: {} }
      }),
      at + index + 1
    )
  })
  return next
}

describe("the card adapter", () => {
  it("turns calls into tool rows with their states, verbs and line counts", () => {
    const worker = cell(Transcript.empty, 10, "Read then edit.", [
      { flow: "read", input: { path: "auth/login.ts" } },
      { flow: "edit", input: { path: "login.ts", oldString: "a\nb", newString: "a\nc\nd" } },
      { flow: "bash", input: { command: "bun test auth" }, outcome: "failure" },
      { flow: "edit", input: { path: "login.ts", oldString: "x", newString: "y" }, outcome: "running" }
    ])
    const card = SubagentCard.card(Subagents.subagent(tab("w", "running"), worker, models), 42_000)
    expect(card.activity.rows.map((row) => SubagentCard.line(row))).toEqual([
      "├ Read then edit.",
      "├ Read auth/login.ts ✓",
      "├ Edited login.ts +3 -2 ✓",
      "├ Ran bun test auth ✗",
      "└ Editing login.ts…"
    ])
    expect(card.footer.text).toBe("42s · sol")
  })

  it("prefers the flow's own verbs and takes counts from captured patches", () => {
    const call: Transcript.Call = {
      flow: "apply_patch",
      subject: "src/a.ts",
      status: "ok",
      verb: { pending: "patching", success: "patched", failure: "failed to patch" },
      patches: [{ path: "src/a.ts", patch: "--- a\n+++ b\n+one\n+two\n-three" }],
      startedAt: 0
    }
    expect(Subagents.entry(call)).toEqual({
      kind: "tool",
      tool: "apply_patch",
      state: "done",
      target: "src/a.ts",
      verb: { pending: "patching", done: "patched" },
      added: 2,
      removed: 1
    })
  })

  const patched = (...calls: ReadonlyArray<Transcript.Call>): Transcript.Transcript => ({
    ...Transcript.empty,
    items: [{
      kind: "cell",
      id: "0",
      index: 1,
      prose: "",
      source: "",
      status: "done",
      calls,
      printed: "",
      startedAt: 0
    }]
  })
  const edit = (path: string, undone?: true): Transcript.Call => ({
    flow: "edit",
    identity: path,
    subject: path,
    status: "ok",
    patches: [{ path, patch: "+a\n-b", ...(undone === undefined ? {} : { undone }) }],
    startedAt: 0
  })

  it("lists every captured file, undone ones too, and reads undone once all are", () => {
    const partly = Subagents.subagent(tab("w", "done"), patched(edit("kept.ts"), edit("undone.ts", true)), models)
    expect(partly.files).toEqual([
      { path: "kept.ts", added: 1, removed: 1 },
      { path: "undone.ts", added: 1, removed: 1 }
    ])
    expect(partly.title).toBe("w")
    const all = Subagents.subagent(tab("w", "done"), patched(edit("a.ts", true), edit("b.ts", true)), models)
    expect(all.title).toBe("w · undone")
    expect(all.files).toHaveLength(2)
    expect(Subagents.subagent(tab("w", "done"), Transcript.empty, models).title).toBe("w")
  })

  it("lists changed files from captured patches", () => {
    const patch = (path: string): Transcript.Call => ({
      flow: "edit",
      subject: path,
      status: "ok",
      patches: [{ path, patch: "+a\n-b" }],
      startedAt: 0
    })
    const transcript: Transcript.Transcript = {
      ...Transcript.empty,
      items: [{
        kind: "cell",
        id: "0",
        index: 1,
        prose: "",
        source: "",
        status: "done",
        calls: [patch("kept.ts")],
        printed: "",
        startedAt: 0
      }]
    }
    expect(Subagents.subagent(tab("w", "done"), transcript, models).files).toEqual([
      { path: "kept.ts", added: 1, removed: 1 }
    ])
  })
})

describe("batches", () => {
  const delegating = cell(Transcript.user(Transcript.empty, "Split it", false, 5), 10, "Three workers.", [
    { flow: "agent.delegate", input: { id: "a", title: "auth", prompt: "a" } },
    { flow: "agent.delegate", input: { id: "b", title: "db", prompt: "b" } }
  ])
  const later = Transcript.note(delegating, "Requested.", 100)
  const tabs = [
    tab("a", "running", { title: "auth", startedAt: 11 }),
    tab("b", "done", { title: "db", startedAt: 12, endedAt: 200 }),
    tab("c", "running", { title: "cli", startedAt: 150 }),
    tab("a/x", "running", { parent: "a", title: "child", startedAt: 20 })
  ]

  it("groups a parent's workers at the cell that delegated them, others after the row before them", () => {
    const groups = Subagents.batches(later, tabs)
    const cellId = later.items.find((item) => item.kind === "cell")!.id
    expect(groups.map((batch) => [batch.anchor, batch.tabs.map((each) => each.id)])).toEqual([
      [cellId, ["a", "b"]],
      [later.items.at(-1)!.id, ["c"]]
    ])
    expect(Subagents.batches(later, tabs, "a").map((batch) => batch.tabs.map((each) => each.id))).toEqual([["a/x"]])
  })

  it("places each grid after its anchor and a finished row where its worker settled", () => {
    const rows = Timeline.rows(later)
    const lines = Subagents.lines(rows, Subagents.batches(later, tabs))
    expect(lines.map((line) => line.kind === "row" ? Timeline.text(line.row.item).split("\n")[0] : line.key)).toEqual([
      "Split it",
      "Three workers.",
      "batch:a",
      "Requested.",
      "batch:c",
      "finished:b"
    ])
  })

  it("keeps a grid whose anchor is filtered out at its time, and a finished row below its grid", () => {
    const rows = Timeline.rows(later, Timeline.toggleKind(Timeline.all, "cell"))
    const lines = Subagents.lines(rows, Subagents.batches(later, tabs))
    expect(lines.map((line) => line.key)).toEqual(["chat:0", "batch:a", "chat:2", "batch:c", "finished:b"])
    const early = [tab("q", "done", { startedAt: 11, endedAt: 12 })]
    expect(Subagents.lines(rows, Subagents.batches(later, early)).map((line) => line.key)).toEqual([
      "chat:0",
      "batch:q",
      "finished:q",
      "chat:2"
    ])
  })
})

describe("card focus", () => {
  const order = ["panel", "agent:a", "agent:b", "agent:c", "last"]
  const grid = ["agent:a", "agent:b", "agent:c"]
  it("moves by column between a grid's rows, then leaves the grid", () => {
    // 80 columns fit two cards a row: a b / c.
    expect(Subagents.move(order, [grid], 80, "agent:b", "down")).toBe("agent:c")
    expect(Subagents.move(order, [grid], 80, "agent:c", "up")).toBe("agent:a")
    expect(Subagents.move(order, [grid], 80, "agent:c", "down")).toBe("last")
    expect(Subagents.move(order, [grid], 80, "agent:a", "up")).toBe("panel")
  })
  it("steps in order sideways and with tab, wrapping around", () => {
    expect(Subagents.move(order, [grid], 80, "agent:a", "right")).toBe("agent:b")
    expect(Subagents.move(order, [grid], 80, "agent:a", "left")).toBe("panel")
    expect(Subagents.move(order, [grid], 80, "last", "next")).toBe("panel")
    expect(Subagents.move(order, [grid], 80, "panel", "previous")).toBe("last")
  })
})

describe("the worker tree", () => {
  it("walks every top-level worker and its descendants in request order", () => {
    const tabs = [tab("a", "running"), tab("b", "done"), tab("a/x", "running", { parent: "a" })]
    expect(Tree.walk(tabs).map((node) => `${node.level}:${node.tab.id}`)).toEqual(["0:a", "1:a/x", "0:b"])
    expect(Tree.branch(tabs, "a").map((each) => each.id)).toEqual(["a", "a/x"])
  })
  it("draws each row with the shared glyph", () => {
    const panel = Tree.panel("a", [tab("a", "done", { launchedAt: 0, endedAt: 64_000 })], () => Transcript.empty, 1)
    expect(panel.rows[0]?.label).toContain("● a")
    expect(panel.rows[0]?.label).toContain("1m 04s")
  })
})

let setup: Awaited<ReturnType<typeof testRender>> | undefined
afterEach(() => {
  const mounted = setup
  setup = undefined
  if (mounted !== undefined) act(() => mounted.renderer.destroy())
})
const mount = async (node: Parameters<typeof testRender>[0], width: number, height: number) => {
  const mounted = await act(() => testRender(node, { width, height }))
  setup = mounted
  await act(() => mounted.renderOnce())
  return mounted
}

describe("the card grid", () => {
  const auth = cell(Transcript.empty, 10, "", [
    { flow: "read", input: { path: "auth/login.ts" } },
    { flow: "edit", input: { path: "login.ts", oldString: "a", newString: "b\nc" }, outcome: "running" }
  ])
  const tabs = [
    tab("auth", "running", { title: "auth-audit" }),
    tab("db", "waiting", { title: "db-migrate" }),
    tab("docs", "done", { title: "docs", endedAt: 64_000 })
  ]
  const cards = (focused?: string): SubagentView.Cards => ({
    transcript: (id) => id === "auth" ? auth : Transcript.empty,
    models,
    now: 42_000,
    lane: () => color.info,
    focused,
    open: new Set(),
    onOpen: () => {},
    onFiles: () => {},
    onAction: () => {}
  })
  const batch: Subagents.Batch = { key: "batch:auth", anchor: undefined, at: 0, tabs }

  it("heads the batch and draws equal-height cards across the width", async () => {
    const { captureCharFrame } = await mount(
      <SubagentView.Batch batch={batch} width={80} cards={cards("agent:auth")} />,
      80,
      16
    )
    const lines = captureCharFrame().split("\n")
    expect(lines[0]).toMatch(/^◐ Running 3 subagents \(1\/3\) {2}▰▰▰/)
    expect(lines[1]).toMatch(/^▌◐ auth-audit +▌◐ db-migrate/)
    expect(lines[2]).toContain("├ Read auth/login.ts ✓")
    expect(lines[3]).toContain("└ Editing login.ts…")
    // The rows of the shorter card pad so both footers share a line.
    expect(lines[4]).toMatch(/▌42s · sol +\[x Stop\] \[s Steer\] ▌42s · sol +waiting/)
    expect(lines[5]?.trim()).toBe("")
    // A short last row stretches across the width.
    expect(lines[6]).toMatch(/^▌● docs/)
    expect(lines[7]).toContain("Done 1m 04s · sol")
  })

  it("stacks cards in one column below two minimum widths", async () => {
    const { captureCharFrame } = await mount(
      <SubagentView.Grid tabs={tabs.slice(0, 2)} width={SubagentCard.gridBounds.min * 2} cards={cards()} />,
      68,
      12
    )
    const lines = captureCharFrame().split("\n")
    expect(lines[0]).toMatch(/^▌◐ auth-audit\s*$/)
    expect(lines.some((line) => /^▌◐ db-migrate/.test(line))).toBe(true)
  })

  it("writes the finished row", async () => {
    const { captureCharFrame } = await mount(<SubagentView.Finished tab={tabs[2]!} tone={color.info} />, 40, 2)
    expect(captureCharFrame()).toContain("◉ docs finished")
  })
})

describe("the Summary overview's tree row", () => {
  const row = {
    key: "w1",
    group: "working",
    level: 0,
    status: "running",
    name: "Fix UTF-8 split-chunk decoding in flows/release so a multibyte char survives",
    seat: "Claude Opus 5.5",
    clock: "11m 43s",
    window: 20,
    cache: 48
  } as const
  it("keeps a space between the clipped name and every fixed column", () => {
    const line = SubagentView.treeRow(row, 4, 64)
    const text = `${line.title}${" ".repeat(line.gap)}${line.aside}`
    expect(4 + text.length).toBeLessThanOrEqual(64 - 1)
    expect(text).toMatch(/… +Claude … +11m 43s +20% 48%$/)
  })
  it("pads short values to the same columns, so rows line up", () => {
    const a = SubagentView.treeRow({ ...row, seat: "opus", clock: "4s" }, 4, 64)
    const b = SubagentView.treeRow(row, 4, 64)
    expect(a.aside.indexOf("20%")).toBe(b.aside.indexOf("20%"))
    expect(a.title.length + a.gap).toBe(b.title.length + b.gap)
  })
  it("drops the meter first in a narrow pane and still separates the clock", () => {
    const line = SubagentView.treeRow(row, 4, 36)
    expect(line.aside).not.toContain("%")
    expect(`${line.title}${" ".repeat(line.gap)}${line.aside}`).toMatch(/… +Claude … +11m 43s *$/)
  })
})
