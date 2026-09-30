import { expect, test } from "bun:test"
import * as Catalog from "../src/catalog.ts"
import type * as Extension from "../src/extension.ts"
import * as Models from "../src/models.ts"
import * as Picker from "../src/picker.ts"
import type * as Session from "../src/session.ts"
import * as Theme from "../src/theme.ts"
import * as Timeline from "../src/timeline.ts"
import type { Tab } from "../src/workspace.ts"

// The seat the `sol` alias names, so the agents case below keeps resolving it
// when the alias moves; its label differs from the catalog's to prove an
// available model's label wins.
const sol = Models.delegateModels.sol
const models: ReadonlyArray<Models.Model> = [
  { seat: sol, label: "Sol", provider: "OpenAI" },
  { seat: "replay:small", label: "Small", provider: "Replay" }
]
const flows: ReadonlyArray<Extension.Descriptor> = [
  {
    name: "build",
    description: "Compile",
    kind: "module",
    modelInvocable: true,
    flows: [],
    capabilities: [],
    path: "flows/build/flow.ts"
  },
  {
    name: "writer",
    description: "Write prose",
    kind: "markdown",
    seat: "sol",
    modelInvocable: true,
    flows: [],
    capabilities: [],
    path: "flows/writer/flow.mdx"
  },
  {
    name: "research",
    description: "Find answers",
    kind: "markdown",
    seat: "unlisted",
    modelInvocable: false,
    flows: [],
    capabilities: [],
    path: "flows/research/flow.mdx"
  },
  {
    name: "review",
    description: "Review changes",
    kind: "markdown",
    modelInvocable: true,
    flows: [],
    capabilities: [],
    path: "flows/review/flow.mdx"
  }
]
const catalog = Catalog.entries({
  flows,
  fields: (name) => (name === "build" ? ["target", "mode"] : undefined),
  unloaded: () => false,
  keys: (name) => (name === "review" ? ["alt+r"] : []),
  runs: [],
  tabs: [],
  recorded: []
})
const noFiles = (): ReadonlyArray<string> => {
  throw new Error("This category must not read repository files")
}
const noEmpty = (): string => {
  throw new Error("This category must not read the flow listing diagnostic")
}
const rows = (picker: Picker.Picker, filter: Timeline.Filter = Timeline.all, tabs: ReadonlyArray<Tab> = []) =>
  Picker.rows(picker, models, "replay:small", filter, tabs, noFiles, [], catalog)

test("an auto-routed worker model picker does not call the chat seat current", () => {
  const worker: Tab = {
    id: "worker-2",
    depth: 0,
    title: "Worker",
    prompt: "Investigate",
    seat: "auto",
    file: "worker-2.jsonl",
    status: "failed",
    startedAt: 1
  }
  const shown = rows({ kind: "worker-model", id: worker.id, query: "", selected: 0 }, Timeline.all, [worker])
  expect(shown.map((row) => [row.value, row.current ?? false])).toEqual([
    [sol, false],
    ["replay:small", false]
  ])
})

test("chat model picker lists seat identities and marks the chat seat without reading files", () => {
  expect(rows({ kind: "model", query: "", selected: 1 })).toEqual([
    {
      key: sol,
      label: "Sol",
      hint: "OpenAI",
      detail: sol,
      current: false,
      value: sol
    },
    {
      key: "replay:small",
      label: "Small",
      hint: "Replay",
      detail: "replay:small",
      current: true,
      value: "replay:small"
    }
  ])
})

test("worker model picker marks its own seat rather than the chat seat", () => {
  const worker: Tab = {
    id: "worker-2",
    depth: 0,
    title: "Worker",
    prompt: "Investigate",
    seat: sol,
    file: "worker-2.jsonl",
    status: "failed",
    startedAt: 1
  }
  const shown = rows({ kind: "worker-model", id: worker.id, query: "", selected: 0 }, Timeline.all, [worker])
  expect(shown.map((row) => [row.value, row.current ?? false])).toEqual([
    [sol, true],
    ["replay:small", false]
  ])
})

test("worker picker follows its active routed seat and never borrows chat when the tab is gone", () => {
  const worker: Tab = {
    id: "worker-2",
    depth: 0,
    title: "Worker",
    prompt: "Investigate",
    seat: "auto",
    activeSeat: sol,
    file: "worker-2.jsonl",
    status: "failed",
    startedAt: 1
  }
  const picker: Picker.Picker = { kind: "worker-model", id: worker.id, query: "", selected: 0 }
  expect(rows(picker, Timeline.all, [worker]).map((row) => [row.value, row.current ?? false])).toEqual([
    [sol, true],
    ["replay:small", false]
  ])
  expect(rows(picker).every((row) => row.current !== true)).toBe(true)
})

test.each(["model", "worker-model"] as const)(
  "%s offers an exact custom seat once and does not duplicate listed seats",
  (kind) => {
    const picker = (query: string): Picker.Picker =>
      kind === "model" ? { kind, query, selected: 0 } : { kind, id: "worker-2", query, selected: 0 }
    expect(rows(picker("custom:new"))).toEqual([{
      key: "custom:new",
      label: "custom:new",
      hint: "any seat",
      value: "custom:new"
    }])
    expect(rows(picker("replay:small"))).toEqual([{
      key: "replay:small",
      label: "Small",
      hint: "Replay",
      detail: "replay:small",
      current: kind === "model",
      value: "replay:small"
    }])
    expect(rows(picker("no match"))).toEqual([])
    expect(rows(picker("OpenAI")).map((row) => row.value)).toEqual([sol])
  }
)

test("the flows catalog lists flows and agents with their input hints; only the selected row describes itself", () => {
  const before = structuredClone(flows)
  expect(rows({ kind: "flows", query: "", selected: 0 })).toEqual([
    { key: "build", label: "build", hint: "target, mode", detail: "Compile", value: "build" },
    { key: "writer", label: "writer", hint: "", value: "writer" },
    { key: "research", label: "research", hint: "", value: "research" },
    { key: "review", label: "review", hint: "alt+r", value: "review" }
  ])
  expect(rows({ kind: "flows", query: "", selected: 3 }).map((row) => row.detail)).toEqual([
    undefined,
    undefined,
    undefined,
    "Review changes"
  ])
  expect(rows({ kind: "flows", query: "writer", selected: 0 })).toEqual([
    { key: "writer", label: "writer", hint: "", detail: "Write prose", value: "writer" }
  ])
  expect(flows).toEqual(before)
})

test("a flow's last run sits at the row's right end; a flow added after launch says only Restart to load", () => {
  const now = Date.UTC(2026, 8, 29, 12)
  const entries = Catalog.entries({
    flows,
    fields: () => [],
    unloaded: (name) => name === "build",
    keys: () => [],
    runs: [{
      id: "writer-1",
      flow: "writer",
      by: "user",
      input: {},
      requested: "{}",
      status: "done",
      startedAt: now - 3 * 60_000,
      endedAt: now - 2 * 60_000
    }],
    tabs: [],
    recorded: [{ runId: "run-9", flow: "build", status: "completed", at: now - 1000 }]
  })
  const shown = Picker.rows(
    { kind: "flows", query: "", selected: 0 },
    models,
    "",
    Timeline.all,
    [],
    noFiles,
    [],
    entries,
    [],
    [],
    now
  )
  expect(shown[0]).toEqual({ key: "build", label: "build", hint: "Restart to load", value: "build" })
  expect(shown[1]).toMatchObject({ key: "writer", aside: { mark: "✓", text: "2m ago" } })
  expect(shown.slice(2).every((row) => row.aside === undefined)).toBe(true)
})

test("kind filter preserves Show all first and marks visible categories, independently of selection", () => {
  const filter: Timeline.Filter = { kinds: ["cell", "error"], query: "unchanged text" }
  const before = structuredClone(filter)
  expect(rows({ kind: "filter", query: "", selected: 4 }, filter)).toEqual([
    { key: "all", label: "Show all", value: "all" },
    { key: "kind:user", label: "Messages", current: true, value: "kind:user" },
    { key: "kind:cell", label: "Cells", current: false, value: "kind:cell" },
    { key: "kind:shell", label: "Shell", current: true, value: "kind:shell" },
    { key: "kind:answer", label: "Answers", current: true, value: "kind:answer" },
    { key: "kind:error", label: "Errors", current: false, value: "kind:error" },
    { key: "kind:note", label: "Notes", current: true, value: "kind:note" },
    { key: "kind:card", label: "Cards", current: true, value: "kind:card" },
    { key: "kind:run", label: "Runs", current: true, value: "kind:run" }
  ])
  expect(rows({ kind: "filter", query: "Errors", selected: 1 }, filter)).toEqual([{
    key: "all",
    label: "Show all",
    value: "all"
  }, { key: "kind:error", label: "Errors", current: false, value: "kind:error" }])
  expect(rows({ kind: "filter", query: "none", selected: 0 }, filter)).toEqual([{
    key: "all",
    label: "Show all",
    value: "all"
  }])
  expect(filter).toEqual(before)
})

test("theme selection is shown without changing the active theme", () => {
  const previous = Theme.activeTheme()
  try {
    Theme.setTheme("green")
    expect(rows({ kind: "theme", query: "", selected: 0 })).toEqual([
      { key: "purple", label: "purple", current: false, value: "purple" },
      { key: "blue", label: "blue", current: false, value: "blue" },
      { key: "green", label: "green", current: true, value: "green" },
      { key: "orange", label: "orange", current: false, value: "orange" }
    ])
    expect(rows({ kind: "theme", query: "blue", selected: 0 })).toEqual([{
      key: "blue",
      label: "blue",
      current: false,
      value: "blue"
    }])
    expect(Theme.activeTheme()).toBe("green")
  } finally {
    Theme.setTheme(previous)
  }
})

const future = Date.UTC(2500, 0, 1)
const sessions: ReadonlyArray<Session.Summary> = [
  { file: "/sessions/a.jsonl", name: "Fix build", firstPrompt: "repair", modified: future },
  {
    file: "/sessions/fork.jsonl",
    name: undefined,
    firstPrompt: "Review\nsecond line",
    modified: future,
    parent: "/sessions/a.jsonl"
  }
]
test("resume and fork keep saved file and turn identities while clipping only labels", () => {
  expect(rows({ kind: "resume", query: "", selected: 0, sessions })).toEqual([
    { key: "/sessions/a.jsonl", label: "Fix build", detail: "just now", value: "/sessions/a.jsonl" },
    { key: "/sessions/fork.jsonl", label: "Review", detail: "fork · just now", value: "/sessions/fork.jsonl" }
  ])
  const turns = [{ index: 42, at: future, text: `${"x".repeat(61)}\nsecond line` }, {
    index: 7,
    at: future,
    text: "Find bug"
  }]
  expect(rows({ kind: "fork", query: "", selected: 0, turns })).toEqual([
    { key: "42", label: "x".repeat(60), detail: "just now", value: "42" },
    { key: "7", label: "Find bug", detail: "just now", value: "7" }
  ])
  expect(rows({ kind: "fork", query: "second line", selected: 0, turns }).map((row) => row.value)).toEqual(["42"])
})

test("palette serializes public target identities without changing their exact paths or worker IDs", () => {
  const tabs: ReadonlyArray<Tab> = [{
    id: "worker:α",
    title: "Investigate",
    status: "running",
    prompt: "p",
    seat: "s",
    file: "a.jsonl",
    startedAt: 0,
    depth: 0
  }]
  const values = (query: string) =>
    Picker.rows({ kind: "palette", query, selected: 0, sessions }, models, "s", Timeline.all, tabs, noFiles, [{
      path: "odd\nfile.ts",
      line: 9,
      text: "match"
    }], catalog).map((row) => row.value)
  expect(values("text:match")).toEqual(["{\"kind\":\"hit\",\"path\":\"odd\\nfile.ts\",\"line\":9}"])
  expect(values("tab:Investigate")).toEqual(["{\"kind\":\"tab\",\"id\":\"worker:α\"}"])
  expect(values("conversation:Fix")).toEqual(["{\"kind\":\"session\",\"file\":\"/sessions/a.jsonl\"}"])
  expect(values("/resume")).toEqual(["{\"kind\":\"command\",\"name\":\"resume\"}"])
})

test("palette reads files only for the all-category query and propagates the caller's read failure", () => {
  let reads = 0
  const error = new Error("Inventory unavailable")
  const files = () => {
    reads++
    throw error
  }
  const list = (query: string) =>
    Picker.rows({ kind: "palette", query, selected: 0 }, [], "", Timeline.all, [], files, [], [])
  expect(list("text:word")).toEqual([])
  expect(list("conversation:word")).toEqual([])
  expect(reads).toBe(0)
  expect(() => list("word")).toThrow(error)
  expect(reads).toBe(1)
})

test("palette retains contributed action ownership and exact file identity in serialized values", () => {
  const action: Extension.Action = { kind: "open", surface: "ui:worker:α:review" }
  const sources = [{ key: "worker:α:review", label: "Review owned output", hint: "alt+r", action }]
  const before = structuredClone(sources)
  let reads = 0
  const list = Picker.rows(
    { kind: "palette", query: "Review", selected: 0 },
    [],
    "",
    Timeline.all,
    [],
    () => {
      reads++
      return ["Review \"notes\".md"]
    },
    [],
    [],
    sources
  )
  expect(list).toEqual([
    {
      key: "worker:α:review",
      label: "Review owned output",
      hint: "alt+r",
      value: "{\"kind\":\"action\",\"action\":{\"kind\":\"open\",\"surface\":\"ui:worker:α:review\"}}"
    },
    {
      key: "file:Review \"notes\".md",
      label: "Review \"notes\".md",
      value: "{\"kind\":\"file\",\"path\":\"Review \\\"notes\\\".md\"}"
    }
  ])
  expect(reads).toBe(1)
  expect(sources).toEqual(before)
})

const undo = (checked: ReadonlyArray<string>): Picker.Picker => ({
  kind: "undo",
  query: "",
  selected: 0,
  title: "Fix add in math.js and run check",
  plan: {
    calls: ["edit", "bash"],
    entries: [
      { path: "math.js", added: 1, removed: 1, current: "a + b", next: "a - b", with: ["math.js"] },
      { path: "check.log", added: 1, removed: 0, state: "new", current: "ok\n", next: null, with: ["check.log"] },
      { path: "logo.png", added: 0, removed: 0, refused: "unrendered", with: ["logo.png"] },
      { path: "notes.md", added: 2, removed: 0, refused: "changed", with: ["notes.md"] }
    ],
    settled: []
  },
  checked: new Set(checked)
})
test("undo names the run and lists every file with its box, counts or reason", () => {
  expect(Picker.title(undo([]), false)).toBe("Undo Fix add in math.js and run check?")
  expect(rows(undo(["math.js", "check.log"]))).toEqual([
    { key: "math.js", label: "[x] math.js", hint: "+1 −1", value: "math.js" },
    { key: "check.log", label: "[x] check.log", hint: "new", value: "check.log" },
    { key: "logo.png", label: "[ ] logo.png", hint: "binary or large", value: "logo.png" },
    { key: "notes.md", label: "[ ] notes.md", hint: "changed since", value: "notes.md" }
  ])
  expect(rows(undo(["check.log"])).map((row) => row.label).slice(0, 2)).toEqual(["[ ] math.js", "[x] check.log"])
})

test.each(
  [
    [{ kind: "model", query: "x", selected: 0 }, "Select model", "No model matches \"x\""],
    [{ kind: "worker-model", id: "w", query: "x", selected: 0 }, "Select model", "No worker-model matches \"x\""],
    [{ kind: "theme", query: "x", selected: 0 }, "Select theme", "No theme matches \"x\""],
    [{ kind: "filter", query: "x", selected: 0 }, "Filter chat", "No filter matches \"x\""],
    [{ kind: "fork", query: "x", selected: 0, turns: [] }, "Fork from message", "No messages match \"x\""],
    [{ kind: "resume", query: "x", selected: 0, sessions: [] }, "Resume session", "No sessions in this directory"]
  ] satisfies Array<[Picker.Picker, string, string]>
)("category title and empty message stay independent of search status: %s", (picker, title, empty) => {
  expect(Picker.title(picker, false)).toBe(title)
  expect(Picker.title(picker, true)).toBe(title)
  expect(Picker.empty(picker, noEmpty, false)).toBe(empty)
  expect(Picker.empty(picker, noEmpty, true)).toBe(empty)
})

test("flow empty message is lazy and palette distinguishes pending from settled searches", () => {
  const failure = new Error("Listing unavailable")
  expect(() =>
    Picker.empty({ kind: "flows", query: "", selected: 0 }, () => {
      throw failure
    }, false)
  ).toThrow(failure)
  expect(Picker.empty({ kind: "flows", query: "", selected: 0 }, () => "Discovery failed", true)).toBe(
    "Discovery failed"
  )
  const picker: Picker.Picker = { kind: "palette", query: "text:x", selected: 0 }
  expect(Picker.empty(picker, () => {
    throw failure
  }, true)).toBe("Searching")
  expect(Picker.empty(picker, () => {
    throw failure
  }, false)).toBe("No matches")
  expect(Picker.title(picker, false)).toBe("Search")
  expect(Picker.title(picker, true)).toBe("Search · first 200")
  expect(Picker.title({ kind: "flows", query: "", selected: 0 }, true)).toBe("Flows")
})
