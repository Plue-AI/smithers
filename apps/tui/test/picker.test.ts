import { expect, test } from "bun:test"
import type * as Extension from "../src/extension.ts"
import type * as Models from "../src/models.ts"
import * as Picker from "../src/picker.ts"
import type * as Session from "../src/session.ts"
import * as Theme from "../src/theme.ts"
import * as Timeline from "../src/timeline.ts"
import type { Tab } from "../src/workspace.ts"

const models: ReadonlyArray<Models.Model> = [
  { seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "OpenAI" },
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
const noFiles = (): ReadonlyArray<string> => {
  throw new Error("This category must not read repository files")
}
const noEmpty = (): string => {
  throw new Error("This category must not read the flow listing diagnostic")
}
const rows = (picker: Picker.Picker, filter: Timeline.Filter = Timeline.all, tabs: ReadonlyArray<Tab> = []) =>
  Picker.rows(picker, models, "replay:small", filter, tabs, noFiles, [], flows)

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
    ["openai:gpt-6-sol", false],
    ["replay:small", false]
  ])
})

test("chat model picker lists seat identities and marks the chat seat without reading files", () => {
  expect(rows({ kind: "model", query: "", selected: 1 })).toEqual([
    {
      key: "openai:gpt-6-sol",
      label: "GPT-6 Sol",
      hint: "OpenAI",
      detail: "openai:gpt-6-sol",
      current: false,
      value: "openai:gpt-6-sol"
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
    seat: "openai:gpt-6-sol",
    file: "worker-2.jsonl",
    status: "failed",
    startedAt: 1
  }
  const shown = rows({ kind: "worker-model", id: worker.id, query: "", selected: 0 }, Timeline.all, [worker])
  expect(shown.map((row) => [row.value, row.current ?? false])).toEqual([
    ["openai:gpt-6-sol", true],
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
    activeSeat: "openai:gpt-6-sol",
    file: "worker-2.jsonl",
    status: "failed",
    startedAt: 1
  }
  const picker: Picker.Picker = { kind: "worker-model", id: worker.id, query: "", selected: 0 }
  expect(rows(picker, Timeline.all, [worker]).map((row) => [row.value, row.current ?? false])).toEqual([
    ["openai:gpt-6-sol", true],
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
    expect(rows(picker("OpenAI")).map((row) => row.value)).toEqual(["openai:gpt-6-sol"])
  }
)

test("flows include module and markdown entries; agents preserve only markdown and declared-seat hints", () => {
  const before = structuredClone(flows)
  expect(rows({ kind: "flows", query: "", selected: 0 })).toEqual([
    { key: "build", label: "build", detail: "Compile", value: "build" },
    { key: "writer", label: "writer", detail: "Write prose", value: "writer" },
    { key: "research", label: "research", detail: "Find answers", value: "research" },
    { key: "review", label: "review", detail: "Review changes", value: "review" }
  ])
  expect(rows({ kind: "agents", query: "", selected: 0 })).toEqual([
    { key: "writer", label: "writer", hint: "GPT-6 Sol", detail: "Write prose", value: "writer" },
    { key: "research", label: "research", hint: "unlisted", detail: "Find answers", value: "research" },
    { key: "review", label: "review", hint: "", detail: "Review changes", value: "review" }
  ])
  expect(rows({ kind: "agents", query: "build", selected: 0 })).toEqual([])
  expect(rows({ kind: "flows", query: "writer", selected: 0 }).map((row) => row.value)).toEqual(["writer"])
  expect(flows).toEqual(before)
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
    { key: "kind:card", label: "Cards", current: true, value: "kind:card" }
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
    }], flows).map((row) => row.value)
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

const undo = (paths: ReadonlyArray<string>): Picker.Picker => ({
  kind: "undo",
  query: "",
  selected: 0,
  target: { calls: [], paths }
})
test("undo uses literal path or file count and preserves its two choices", () => {
  expect(Picker.title(undo(["notes.txt"]), false)).toBe("Undo notes.txt?")
  expect(Picker.title(undo(["a", "b"]), false)).toBe("Undo 2 files?")
  expect(rows(undo(["notes.txt"]))).toEqual([{ key: "undo", label: "Undo", value: "undo" }, {
    key: "cancel",
    label: "Cancel",
    value: "cancel"
  }])
})

test.each(
  [
    [{ kind: "model", query: "x", selected: 0 }, "Select model", "No model matches \"x\""],
    [{ kind: "worker-model", id: "w", query: "x", selected: 0 }, "Select model", "No worker-model matches \"x\""],
    [{ kind: "theme", query: "x", selected: 0 }, "Select theme", "No theme matches \"x\""],
    [{ kind: "agents", query: "x", selected: 0 }, "Agents", "No agents"],
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
