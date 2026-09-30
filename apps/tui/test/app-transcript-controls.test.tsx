import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
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
const seed = (user: string, answer: string, source?: string) => {
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
  if (source !== undefined) {
    saved.append({
      type: "event",
      at: 102,
      event: new AgentEvent.CellProduced({
        eventType: "flows.harness.cell-produced.v1",
        cell: Cell.source(source)
      })
    })
  }
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
  root = mkdtempSync(join(tmpdir(), "tui-app-transcript-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  previousTheme = Theme.activeTheme()
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  turns = []
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
const closePicker = async () => {
  await key("ESCAPE")
  const deadline = Date.now() + 3000
  while (frame().includes("Filter chat")) {
    if (Date.now() > deadline) throw new Error("Filter did not close")
    await act(async () => {
      await setImmediate()
      await render()
    })
  }
}
const palette = async (query: string) => {
  await key("k", { ctrl: true })
  await type(query)
  await key("RETURN")
}

test.each([
  { query: "ALPHA QUESTION", visible: "Alpha question", absent: ["Alpha answer", "Beta question", "Beta answer"] },
  { query: "beta answer", visible: "Beta answer", absent: ["Alpha question", "Alpha answer", "Beta question"] },
  {
    query: "not-present-anywhere",
    visible: undefined,
    absent: ["Alpha question", "Alpha answer", "Beta question", "Beta answer"]
  }
])(
  "grep $query filters actual transcript rows and empty grep resets without changing storage",
  async ({ query, visible, absent }) => {
    await mount()
    const original = records()
    await command(`/grep ${query}`)
    if (visible !== undefined) {
      await visibleRow(visible)
      expect(frame()).toContain(visible)
    }
    for (const text of absent) expect(frame()).not.toContain(text)
    expect(turns).toEqual([])
    expect(records()).toEqual(original)
    await command("/grep")
    await visibleRow("Alpha answer")
    await visibleRow("Beta answer")
    for (const text of ["Alpha question", "Alpha answer", "Beta question", "Beta answer"]) {
      expect(frame()).toContain(
        text
      )
    }
    await command("Next question")
    expect(turns[0]!.input.history).toEqual(expectedHistory)
  }
)

test("grep matches source code independently of message and answer fields", async () => {
  seed("Code question", "Code answer", "const sourceOnlyNeedle = 7")
  await mount(48)
  const original = records()
  await key("o", { ctrl: true })
  await command("/grep sourceOnlyNeedle")
  expect(frame()).toContain("sourceOnlyNeedle")
  expect(frame()).not.toContain("Alpha question")
  expect(frame()).not.toContain("Beta answer")
  expect(frame()).not.toContain("Code question")
  expect(frame()).not.toContain("Code answer")
  expect(turns).toEqual([])
  expect(records()).toEqual(original)
  await command("Continue after source inspection")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("Continue after source inspection")
  expect(turns[0]!.input.history).toEqual([
    ...expectedHistory,
    { kind: "exchange", user: "Code question", answer: "Code answer" }
  ])
})

test.each([
  { kind: "Messages", hidden: "Alpha question", kept: "Alpha answer" },
  { kind: "Answers", hidden: "Alpha answer", kept: "Alpha question" }
])(
  "$kind toggle composes with text filtering and Show all resets both while keeping the dialog open",
  async ({ kind, hidden, kept }) => {
    await mount()
    const original = records()
    await command("/grep alpha")
    await command("/filter")
    await type(kind)
    await key("ARROW_DOWN")
    await key("RETURN")
    expect(frame()).toContain("Filter chat")
    await closePicker()
    await visibleRow(kept)
    expect(frame()).not.toContain(hidden)
    expect(frame()).toContain(kept)
    expect(frame()).not.toContain("Beta answer")
    await command("/filter")
    await key("RETURN")
    expect(frame()).toContain("Filter chat")
    await closePicker()
    await visibleRow("Beta answer")
    for (const text of ["Alpha question", "Alpha answer", "Beta question", "Beta answer"]) {
      expect(frame()).toContain(
        text
      )
    }
    expect(records()).toEqual(original)
    expect(turns).toEqual([])
  }
)

test("conversation rename queries the saved name and survives actual App reload without entering history", async () => {
  await mount()
  await command("/name")
  expect(frame()).toContain("This conversation has no name")
  expect(records().filter((r) => r.type === "name")).toEqual([])
  await command("/name Review café 😀")
  expect(records().filter((r) => r.type === "name")).toEqual([{ type: "name", name: "Review café 😀" }])
  await command("/name")
  expect(frame()).toContain("Conversation: Review café 😀")
  await act(async () => {
    setup!.renderer.destroy()
    setup = undefined
    await setImmediate()
  })
  await mount()
  await command("/name")
  expect(frame()).toContain("Conversation: Review café 😀")
  await command("Next question")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.history).toEqual(expectedHistory)
})

test("conversation reports owning session and token receipts without writing a prompt or metadata into history", async () => {
  await mount()
  const original = records()
  await command("/conversation")
  expect(frame().replace(/\s/g, "")).toContain(saved.file)
  expect(frame()).toContain("2 exchanges · ↑240 ↓60 R80")
  expect(records()).toEqual(original)
  expect(turns).toEqual([])
  await command("Continue")
  expect(turns[0]!.input.history).toEqual(expectedHistory)
})

test("palette Summary and empty Tabs return to Chat with the native draft still owned by the composer", async () => {
  await mount()
  await type("Draft preserved")
  await palette("summary")
  expect(frame()).toContain("Asked: Alpha question")
  expect(frame()).toContain("Draft preserved")
  await palette("tabs")
  expect(frame()).toContain("Asked: Alpha question")
  await palette("chat")
  expect(frame()).not.toContain("Asked: Alpha question")
  expect(frame()).toContain("Alpha question")
  await type(" and continued")
  await key("RETURN")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("Draft preserved and continued")
  expect(turns[0]!.input.history).toEqual(expectedHistory)
})

test("hotkeys and unknown command stay local without polluting the next Host conversation", async () => {
  await mount(140)
  const original = records()
  await command("/hotkeys")
  expect(frame()).toMatch(/ctrl\+shift\+p\s+Previous model/)
  expect(turns).toEqual([])
  await command("/not-a-command value")
  expect(frame()).toContain("Unknown command /not-a-command")
  expect(turns).toEqual([])
  expect(records()).toEqual(original)
  await command("A real question")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("A real question")
  expect(turns[0]!.input.history).toEqual(expectedHistory)
})
