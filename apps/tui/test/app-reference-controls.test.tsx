import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"
import * as Theme from "../src/theme.ts"

// Real native headless App and session IO, with controlled Host execution and
// Host turn boundaries. No provider or model calls execute.
let root = ""
let cwd = ""
let previousRoot: string | undefined
let previousTheme = Theme.activeTheme()
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let saved: Session.Writer
let turns: Array<{ input: Host.TurnInput; done: ReturnType<typeof Promise.withResolvers<Host.Outcome>> }> = []
const frame = () => setup!.captureCharFrame()
const render = async () => {
  await setup!.renderOnce()
}
const visibleRow = async (text: string) => {
  const deadline = Date.now() + 4000
  while (!frame().includes(text)) {
    if (Date.now() > deadline) throw new Error(`Missing rendered text: ${text}`)
    await act(async () => {
      await setImmediate()
      await render()
    })
  }
}
const type = async (text: string) => {
  await act(async () => {
    await setup!.mockInput.pressKeys(Array.from(text))
  })
  await render()
}
const key = async (name: string, modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => {
  await act(async () => {
    setup!.mockInput.pressKey(name, modifiers)
    await setImmediate()
  })
  await render()
}
// Alt+Enter submits the literal command instead of accepting an argument
// completion (important for invalid values and omitted optional arguments).
const command = async (text: string) => {
  await type(text)
  await key("RETURN", { meta: true })
}
const records = () => Session.load(saved.file)
const seed = (user: string, answer: string) => {
  saved.append({ type: "user", at: 100, text: user })
  saved.append({
    type: "event",
    at: 101,
    event: new AgentEvent.ModelSettled({
      eventType: "flows.harness.model-settled.v1",
      message: ModelRequest.Message.assistant(answer),
      usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 40 }
    })
  })
  saved.append({
    type: "event",
    at: 103,
    event: new AgentEvent.Resolved({
      eventType: "flows.harness.resolved.v1",
      message: ModelRequest.Message.assistant(answer)
    })
  })
  saved.append({ type: "outcome", at: 104, prompt: user, outcome: { _tag: "done", answer } })
}
const mount = async (height = 35) => {
  const host: Host.Host = {
    cwd,
    judged: false,
    compaction: async () => undefined,
    dispose: async () => {},
    run: (input) => {
      const turn = { input, done: Promise.withResolvers<Host.Outcome>() }
      turns.push(turn)
      return { done: turn.done.promise, cancel: () => turn.done.resolve({ _tag: "cancelled" }) }
    }
  }
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        seat="replay:one"
        models={[{ seat: "replay:one", label: "One", provider: "Fixture" }]}
        contextWindow={() => 10000}
        resume={saved.file}
      />,
      // Legacy control bytes cannot distinguish Ctrl+P from Ctrl+Shift+P.
      { width: 140, height, exitOnCtrlC: false, kittyKeyboard: true }
    )
    await setImmediate()
  })
  await render()
  await visibleRow("Alpha answer")
  await visibleRow("Beta answer")
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tui-app-references-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  previousTheme = Theme.activeTheme()
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  turns = []
  mkdirSync(join(cwd, "src"))
  writeFileSync(join(cwd, "src/one.ts"), "First line\nuniqueHitNeedle\nLast line\n")
  writeFileSync(join(cwd, "src/two.ts"), "Other file\n")
  writeFileSync(join(cwd, "notes café 😀.md"), "Spaced Unicode fixture\nSecond line\nunicodeHitNeedle\n")
  saved = Session.create(cwd)
  seed("Alpha question", "Alpha answer")
  seed("Beta question", "Beta answer")
})
afterEach(async () => {
  try {
    await act(async () => {
      try {
        setup?.renderer.destroy()
      } finally {
        for (const turn of turns) turn.done.resolve({ _tag: "cancelled" })
        await Promise.all(turns.map((turn) => turn.done.promise))
        await setImmediate()
      }
    })
  } finally {
    setup = undefined
    Theme.setTheme(previousTheme)
    if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})

const expectedHistory = [
  { kind: "exchange", user: "Alpha question", answer: "Alpha answer" },
  { kind: "exchange", user: "Beta question", answer: "Beta answer" }
] satisfies Host.TurnInput["history"]
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Reference checkpoint did not arrive")
    await act(async () => {
      await setImmediate()
      await render()
    })
  }
}
const palette = async (query: string, label: string) => {
  await key("k", { ctrl: true })
  await type(query)
  await visibleRow(label)
}
test.each([
  { complete: "TAB", typed: "one", row: "src/one.ts", prompt: "Review @src/one.ts carefully" },
  { complete: "TAB", typed: "two", row: "src/two.ts", prompt: "Review @src/two.ts carefully" },
  { complete: "TAB", typed: "notes", row: "notes café 😀.md", prompt: "Review @\"notes café 😀.md\" carefully" },
  { complete: "RETURN", typed: "one", row: "src/one.ts", prompt: "Review @src/one.ts carefully" },
  { complete: "RETURN", typed: "two", row: "src/two.ts", prompt: "Review @src/two.ts carefully" },
  { complete: "RETURN", typed: "notes", row: "notes café 😀.md", prompt: "Review @\"notes café 😀.md\" carefully" }
])(
  "$complete file completion for $row waits for explicit submission and preserves literal filename",
  async ({ complete, typed, row, prompt }) => {
    await mount()
    const original = records()
    await type(`Review @${typed}`)
    await visibleRow(row)
    await key(complete)
    expect(turns).toEqual([])
    expect(records()).toEqual(original)
    await type("carefully")
    await key("RETURN", { meta: true })
    expect(turns).toHaveLength(1)
    expect(turns[0]!.input.prompt).toBe(prompt)
    expect(turns[0]!.input.history).toEqual(expectedHistory)
    expect(readFileSync(join(cwd, row), "utf8")).toBe(
      row === "src/one.ts"
        ? "First line\nuniqueHitNeedle\nLast line\n"
        : row === "src/two.ts"
        ? "Other file\n"
        : "Spaced Unicode fixture\nSecond line\nunicodeHitNeedle\n"
    )
  }
)

test("palette file selection inserts at the native cursor without losing its prefix or suffix", async () => {
  await mount()
  await type("Please inspect")
  await key("HOME")
  for (let index = 0; index < 7; index++) await key("ARROW_RIGHT")
  await palette("one.ts", "src/one.ts")
  await key("RETURN")
  expect(turns).toEqual([])
  expect(frame()).toContain("Please @src/one.ts inspect")
  await type("closely ")
  await key("RETURN", { meta: true })
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("Please @src/one.ts closely inspect")
})

test.each([
  {
    query: "uniqueHitNeedle",
    row: "src/one.ts:2",
    mention: "Inspect @src/one.ts:2",
    prompt: "Inspect @src/one.ts:2 carefully"
  },
  {
    query: "unicodeHitNeedle",
    row: "notes café 😀.md:3",
    mention: "Inspect @\"notes café 😀.md\":3",
    prompt: "Inspect @\"notes café 😀.md\":3 carefully"
  }
])(
  "real rg hit $row inserts its literal line reference and returns native composer focus",
  async ({ query, row, mention, prompt }) => {
    await mount()
    const original = records()
    await type("Inspect")
    await palette(`text:${query}`, row)
    await key("RETURN")
    expect(turns).toEqual([])
    expect(frame()).toContain(mention)
    expect(records()).toEqual(original)
    await type("carefully")
    await key("RETURN", { meta: true })
    expect(turns).toHaveLength(1)
    expect(turns[0]!.input.prompt).toBe(prompt)
    expect(turns[0]!.input.history).toEqual(expectedHistory)
  }
)

test("canceling file search keeps the native draft and journal unchanged", async () => {
  await mount()
  const original = records()
  await type("Draft kept")
  await palette("one.ts", "src/one.ts")
  await key("ESCAPE")
  await waitFor(() => !frame().includes("src/one.ts"))
  expect(frame()).toContain("Draft kept")
  expect(records()).toEqual(original)
  expect(turns).toEqual([])
  await type(" exactly")
  await key("RETURN", { meta: true })
  expect(turns[0]!.input.prompt).toBe("Draft kept exactly")
})

test("an unmatched reference search cannot submit a prompt or replace the retained draft", async () => {
  await mount()
  await palette("one.ts", "src/one.ts")
  await key("ESCAPE")
  await waitFor(() => !frame().includes("src/one.ts"))
  const original = records()
  await type("Keep this")
  await key("k", { ctrl: true })
  await type("this-file-does-not-exist")
  await visibleRow("No matches")
  await key("RETURN")
  expect(turns).toEqual([])
  expect(records()).toEqual(original)
  await key("ESCAPE")
  await waitFor(() => !frame().includes("No matches"))
  expect(frame()).toContain("Keep this")
  await type(" intact")
  await key("RETURN", { meta: true })
  expect(turns[0]!.input.prompt).toBe("Keep this intact")
})

test("file selection while Host work remains unresolved edits the draft without another launch", async () => {
  await mount()
  await command("Running request")
  const original = records()
  await type("Next request")
  await palette("one.ts", "src/one.ts")
  await key("RETURN")
  await type("later")
  expect(frame()).toContain("Next request @src/one.ts later")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("Running request")
  expect(records()).toEqual(original)
  await act(async () => {
    turns[0]!.input.onEvent(
      new AgentEvent.Resolved({
        eventType: "flows.harness.resolved.v1",
        message: ModelRequest.Message.assistant("Running answer")
      })
    )
    turns[0]!.done.resolve({ _tag: "done", answer: "Running answer" })
    await setImmediate()
  })
  await key("RETURN", { meta: true })
  expect(turns).toHaveLength(2)
  expect(turns[1]!.input.prompt).toBe("Next request @src/one.ts later")
  expect(turns[1]!.input.history).toEqual([...expectedHistory, {
    kind: "exchange",
    user: "Running request",
    answer: "Running answer"
  }])
})
