import { expect, test } from "bun:test"
import type { Run } from "../src/flows.ts"
import type { Panel } from "../src/panels.ts"
import * as Surfaces from "../src/surfaces.ts"
import type { Tab } from "../src/workspace.ts"

const panel = (id: string): Panel => ({ id, title: id, summary: "Ready", rows: [] })
const tab = (id: string, parent?: string): Tab => ({
  id,
  title: id,
  depth: parent === undefined ? 0 : 1,
  parent,
  prompt: "Review",
  seat: "test",
  file: "session",
  status: "requested",
  startedAt: 0
})
const run = (status: Run["status"]): Run => ({
  id: status,
  flow: "review",
  by: "user",
  input: {},
  requested: "{}",
  status,
  startedAt: 0
})

test("the strip preserves plugin, worker, flow and custom view order, with no tree tabs", () => {
  const tabs = [tab("solo"), tab("parent"), tab("child", "parent"), tab("bound"), tab("nested", "bound")]
  const bound = { ...panel("bound-view"), bind: { tree: "bound" } }
  const calls: string[] = []
  const strip = Surfaces.chips({
    workspace: { tabs, panels: [bound] },
    plugins: [panel("plugin")],
    views: [bound, panel("custom")],
    runs: [run("running"), run("done")],
    worker: (worker) => {
      calls.push(worker.id)
      return { id: `tab:${worker.id}`, label: worker.title }
    }
  })
  expect(strip).toEqual([
    { id: "chat", label: "Chat" },
    { id: "summary", label: "Summary" },
    { id: "ui:plugin", label: "plugin" },
    { id: "tab:solo", label: "solo" },
    { id: "tab:parent", label: "parent" },
    { id: "tab:child", label: "child" },
    { id: "tab:bound", label: "bound" },
    { id: "tab:nested", label: "nested" },
    { id: "flow:running", label: "◌ review" },
    { id: "flow:done", label: "✓ review" },
    { id: "ui:bound-view", label: "bound-view" },
    { id: "ui:custom", label: "custom" }
  ])
  expect(calls).toEqual(["solo", "parent", "child", "bound", "nested"])
})

test.each(
  [
    ["requested", "◌ "],
    ["input", "◌ "],
    ["running", "◌ "],
    ["waiting", "◌ "],
    ["done", "✓ "],
    ["failed", "✗ "],
    ["cancelled", "■ "],
    ["queued", "… "],
    ["parked", "⏸ "]
  ] as const
)("the %s flow has its literal status glyph", (status, glyph) => {
  expect(Surfaces.flowGlyph(status)).toBe(glyph)
})

test("agent titles retain both the agent and the requested work", () => {
  expect(Surfaces.tabTitle(tab("Review diff"))).toBe("Review diff")
  expect(Surfaces.tabTitle({ ...tab("Review diff"), agent: { name: "security" } })).toBe("security: Review diff")
})

test("wrapped workers show their short description while native titles keep their requested wording", () => {
  const worker = { ...tab("Review the whole authentication system"), description: "Review authentication" }
  expect(Surfaces.tabTitle(worker)).toBe("Review the whole authentication system")
  expect(Surfaces.tabTitle({ ...worker, harness: { vendor: "claude" } })).toBe("Review authentication")
  expect(Surfaces.tabTitle({ ...worker, harness: { vendor: "codex" }, description: undefined })).toBe(
    "Review the whole authentication system"
  )
})

test.each(
  [
    ["chat", false, "summary"],
    ["chat", true, "ui:custom"],
    ["ui:custom", false, "chat"],
    ["ui:custom", true, "summary"],
    ["summary", false, "ui:custom"],
    ["summary", true, "chat"]
  ] as const
)("cycling from %s backwards=%s selects %s", (current, backwards, expected) => {
  expect(Surfaces.step(
    [
      { id: "chat", label: "Chat" },
      { id: "summary", label: "Summary" },
      { id: "ui:custom", label: "Custom" }
    ],
    current,
    backwards
  )).toBe(expected)
})

test.each(
  [
    ["summary", "summary"],
    ["tab:worker/a", "tab:worker/a"],
    ["flow:run/a", "flow:run/a"],
    ["tree:worker/a", undefined],
    ["ui:custom", "custom"],
    ["chat", undefined],
    ["ui:absent", undefined]
  ] as const
)("%s selects only its requested panel", (surface, expected) => {
  const calls: string[] = []
  const sources = {
    summary: () => {
      calls.push("summary")
      return panel("summary")
    },
    tab: (id: string) => {
      calls.push(`tab:${id}`)
      return panel(`tab:${id}`)
    },
    run: (id: string) => {
      calls.push(`flow:${id}`)
      return panel(`flow:${id}`)
    },
    tree: (id: string) => {
      calls.push(`tree:${id}`)
      return panel(`tree:${id}`)
    },
    views: [panel("custom")]
  }
  const selected = Surfaces.panelFor(surface, sources)
  expect(selected.base?.id).toBe(expected)
  expect(selected.panel).toBe(selected.base)
  expect(calls).toEqual(surface === "chat" || surface.startsWith("ui:") || surface.startsWith("tree:") ? [] : [surface])
})

test("a bound panel prepends its tree and namespaces its own rows without altering either source", () => {
  const tree: Panel = { ...panel("tree"), rows: [{ id: "same", label: "Worker", details: [] }] }
  const base: Panel = {
    ...panel("custom"),
    bind: { tree: "root" },
    rows: [{ id: "same", label: "Run", details: [], action: { label: "Review", prompt: "review" } }]
  }
  const selected = Surfaces.panelFor("ui:custom", {
    summary: () => panel("summary"),
    tab: panel,
    run: panel,
    tree: (id) => {
      expect(id).toBe("root")
      return tree
    },
    views: [base]
  })
  expect(selected.base).toBe(base)
  expect(selected.panel).toEqual({
    ...base,
    rows: [
      { id: "same", label: "Worker", details: [] },
      { id: "custom/same", label: "Run", details: [], action: { label: "Review", prompt: "review" } }
    ]
  })
  expect(base.rows[0]?.id).toBe("same")
  expect(tree.rows).toEqual([{ id: "same", label: "Worker", details: [] }])
})

test.each(
  [
    ["flow:running", "repo:review"],
    ["flow:missing", undefined],
    ["tab:worker/a", "runtime:worker/a"],
    ["ui:plugin/shared", "plugin:owner"],
    ["ui:custom", "runtime:chat"],
    ["ui:worker/custom", "runtime:worker"],
    ["chat", undefined],
    ["summary", undefined],
    ["tree:worker", undefined]
  ] as const
)("keys on %s belong to %s", (surface, expected) => {
  expect(Surfaces.ownerOf(surface, {
    run: (id) => id === "running" ? run("running") : undefined,
    plugins: [{ owner: "plugin:owner", panel: panel("plugin/shared") }]
  })).toBe(expected)
})

test("ctrl+s opens the Summary from a worker tab with that worker selected, and returns there", () => {
  const strip = [{ id: "chat", label: "Chat" }, { id: "summary", label: "Summary" }, { id: "tab:w1", label: "w1" }]
  // A worker tab opens the overview on its worker, whether its panel or the composer has the keys.
  expect(Surfaces.summaryKey({ surface: "tab:w1", main: false, strip })).toEqual({
    kind: "summary",
    from: "tab:w1",
    select: "w1"
  })
  expect(Surfaces.summaryKey({ surface: "flow:r1", main: false, strip })).toEqual({
    kind: "summary",
    from: "flow:r1",
    select: "flow:r1"
  })
  expect(Surfaces.summaryKey({ surface: "chat", main: false, strip })).toEqual({
    kind: "summary",
    from: "chat"
  })
  // The Summary goes back to the tab it came from while that tab exists, else to the chat.
  expect(Surfaces.summaryKey({ surface: "summary", main: false, from: "tab:w1", strip }))
    .toEqual({ kind: "show", surface: "tab:w1" })
  expect(Surfaces.summaryKey({ surface: "summary", main: false, from: "tab:gone", strip }))
    .toEqual({ kind: "show", surface: "chat" })
  expect(Surfaces.summaryKey({ surface: "summary", main: false, strip }))
    .toEqual({ kind: "show", surface: "chat" })
  // The Summary itself shows the worker tree: no `tree:` tab selects a worker.
  expect(Surfaces.summaryKey({ surface: "tree:w1", main: false, strip })).toEqual({
    kind: "summary",
    from: "tree:w1"
  })
  // A main view keeps chat beside it: ctrl+s switches focus between them.
  expect(Surfaces.summaryKey({ surface: "ui:plan", main: true, strip })).toEqual({ kind: "focus" })
  // A `ui:` view (a plugin's tab leaves the strip once hidden) keeps its focus switch, never leaving it.
  expect(Surfaces.summaryKey({ surface: "ui:smithers", main: false, strip })).toEqual({ kind: "focus" })
})
