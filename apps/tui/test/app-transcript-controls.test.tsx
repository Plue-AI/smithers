import { type Renderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate, setTimeout as timerPhase } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"

// Real native headless App and session IO, with controlled Host execution and
// Host turn boundaries. No provider or model calls execute.
let root = ""
let cwd = ""
let previousRoot: string | undefined
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
const mount = async (height = 35, width = 140) => {
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
      { width, height, exitOnCtrlC: false, kittyKeyboard: true }
    )
    await setImmediate()
  })
  await render()
  if (height > 24) await visibleRow("Alpha answer")
  await visibleRow("Beta answer")
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tui-app-transcript-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  turns = []
  saved = Session.create(cwd)
  seed("Alpha question", "Alpha answer")
  seed("Beta question", "Beta answer")
})
afterEach(async () => {
  try {
    await act(async () => {
      for (const turn of turns) turn.done.resolve({ _tag: "cancelled" })
      await Promise.all(turns.map((turn) => turn.done.promise))
      await setImmediate()
      setup?.renderer.destroy()
    })
  } finally {
    setup = undefined
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

test("palette Summary returns to Chat with the native draft still owned by the composer", async () => {
  await mount()
  await type("Draft preserved")
  await palette("summary")
  expect(frame()).toContain("Asked: Alpha question")
  expect(frame()).toContain("Draft preserved")
  await palette("chat")
  expect(frame()).not.toContain("Asked: Alpha question")
  expect(frame()).toContain("Alpha question")
  await type(" and continued")
  await key("RETURN")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("Draft preserved and continued")
  expect(turns[0]!.input.history).toEqual(expectedHistory)
})

test("an unknown command stays local, keeps its line, and never pollutes the next Host conversation", async () => {
  await mount(140)
  const original = records()
  await command("/not-a-command value")
  expect(frame()).toContain("Unknown command /not-a-command")
  expect(frame()).toContain("/not-a-command value")
  expect(turns).toEqual([])
  expect(records()).toEqual(original)
  await key("c", { ctrl: true })
  await command("A real question")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("A real question")
  expect(turns[0]!.input.history).toEqual(expectedHistory)
})

const descendant = <T extends Renderable>(node: Renderable, kind: new(...args: never[]) => T): T | undefined => {
  if (node instanceof kind) return node
  for (const child of node.getChildren()) {
    const found = descendant(child, kind)
    if (found !== undefined) return found
  }
  return undefined
}
const composer = () => descendant(setup!.renderer.root, TextareaRenderable)!
const scroll = () => descendant(setup!.renderer.root, ScrollBoxRenderable)!
const delegate = async (id: string, title: string) => {
  await act(async () => {
    turns[0]!.input.runtime!.delegate!({ id, title, prompt: `Work on ${title}` })
    await setImmediate()
  })
  await render()
}
const stream = async (index: number) => {
  const input = turns[index]!.input
  await act(async () => {
    input.onEvent(
      new AgentEvent.TurnOpened({
        eventType: "flows.harness.turn-opened.v1",
        seat: input.seat,
        modelParams: {},
        activeToolNames: [],
        contextDigest: `fixture-${index}`
      })
    )
    input.onEvent(
      new AgentEvent.ModelDelta({
        eventType: "flows.harness.model-delta.v1",
        delta: { type: "text-delta", id: `fixture-${index}`, text: "Earlier agent transcript\n".repeat(50) }
      })
    )
    await setImmediate()
  })
  await render()
}
// A later timer drains the real 60 ms reveal and restore callbacks, then
// rendering settles the native layout before checking the visible frame.
const drainDeferredScroll = async () => {
  await act(async () => {
    await timerPhase(100)
    await setImmediate()
  })
  await render()
}
const inserts = (index: number) =>
  Effect.runSync(turns[index]!.input.steering!.drain({ boundary: "worker-cell", wouldIdle: false })).inserts
    .map((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""))

test.each([24, 32])(
  "Escape dismisses completion before leaving an agent and Enter keeps its target at 80×%i",
  async (height) => {
    mkdirSync(join(cwd, "src"))
    writeFileSync(join(cwd, "src/app.ts"), "export const fixture = true\n")
    await mount(height, 80)
    await command("Coordinate both agents")
    await delegate("agent-a", "Agent A")
    await delegate("agent-b", "Agent B")
    await key("ARROW_RIGHT", { ctrl: true })
    await key("ARROW_RIGHT", { ctrl: true })
    expect(frame()).toContain("Continue Agent A")
    await type("explain @src/app")
    await visibleRow("src/app.ts")
    expect(frame()).toContain("tab Complete")
    expect(frame()).toContain("enter Choose")
    expect(frame()).not.toContain("esc Chat")
    await key("ESCAPE")
    await drainDeferredScroll()
    expect(frame()).not.toContain("src/app.ts")
    expect(frame()).not.toContain("tab Complete")
    expect(frame()).toContain("Subagent · Agent A")
    expect(frame()).toContain("steer ↳ Agent A")
    expect(composer().plainText).toBe("explain @src/app")
    expect(composer().focused).toBe(true)
    await key("RETURN")
    expect(inserts(1)).toEqual(["explain @src/app"])
    expect(inserts(2)).toEqual([])
    expect(inserts(0)).toEqual([])
    expect(turns).toHaveLength(3)
    expect(composer().plainText).toBe("")
    expect(frame()).toContain("Continue Agent A")
  }
)

test("starting inspection in a different agent returns to that agent and submits to its composer", async () => {
  await mount()
  await command("Coordinate both agents")
  await delegate("agent-a", "Agent A")
  await delegate("agent-b", "Agent B")
  await stream(1)
  await stream(2)
  await key("ARROW_RIGHT", { ctrl: true })
  await key("ARROW_RIGHT", { ctrl: true })
  expect(frame()).toContain("Continue Agent A")
  await key("t", { ctrl: true })
  await key("ARROW_RIGHT", { ctrl: true })
  expect(frame()).toContain("Continue Agent B")
  await key("\u001b[5~")
  const prior = scroll().scrollTop
  await key("t", { ctrl: true })
  await key("ARROW_LEFT")
  await drainDeferredScroll()
  await key("ESCAPE")
  await drainDeferredScroll()
  expect(frame()).toContain("Continue Agent B")
  expect(scroll().scrollTop).toBe(prior)
  expect(composer().focused).toBe(true)
  await type("Reply from B")
  await key("RETURN")
  expect(inserts(1)).toEqual([])
  expect(inserts(2)).toEqual(["Reply from B"])
  expect(inserts(0)).toEqual([])
})

test.each(["timeline", "escape"])(
  "%s after navigating from inspection to an agent awaiting activity keeps its composer target at 80×24",
  async (dismissal) => {
    await mount(24, 80)
    await command("Coordinate both agents")
    await delegate("agent-a", "Agent A")
    await delegate("agent-b", "Agent B")
    await stream(1)
    await key("ARROW_RIGHT", { ctrl: true })
    await key("ARROW_RIGHT", { ctrl: true })
    expect(frame()).toContain("Continue Agent A")
    await key("t", { ctrl: true })
    await key("ARROW_RIGHT", { ctrl: true })
    expect(frame()).toContain("Continue Agent B")
    if (dismissal === "timeline") await key("t", { ctrl: true })
    else await key("ESCAPE")
    await drainDeferredScroll()
    expect(frame()).toContain("Continue Agent B")
    expect(composer().focused).toBe(true)
    await type("Reply from empty B")
    await key("RETURN")
    expect(inserts(1)).toEqual([])
    expect(inserts(2)).toEqual(["Reply from empty B"])
    expect(inserts(0)).toEqual([])
    await key("ESCAPE")
    expect(frame()).not.toContain("Continue Agent B")
    expect(frame()).toContain("Steer, or alt+enter to queue")
  }
)

test.each([24, 32])(
  "a scrolled send at 80×%i reveals its text after worker toasts and deferred layout",
  async (height) => {
    await mount(height, 80)
    await command("Coordinate an agent")
    await delegate("review", "Review one file")
    await delegate("other", "Other review")
    await delegate("third", "Third review")
    await stream(1)
    await key("ARROW_RIGHT", { ctrl: true })
    await key("ARROW_RIGHT", { ctrl: true })
    expect(frame()).toContain("Continue Review one file")
    await act(async () => {
      await timerPhase(400)
    })
    for (let index = 0; index < 5; index++) await render()
    await key("\u001b[5~")
    expect(scroll().scrollHeight).toBeGreaterThan(50)
    expect(scroll().viewport.height).toBeGreaterThan(1)
    expect(scroll().scrollTop).toBeLessThan(scroll().scrollHeight - scroll().viewport.height)
    await type("Reply with exactly: hello")
    await key("RETURN")
    await drainDeferredScroll()
    for (let index = 0; index < 5; index++) {
      await act(async () => {
        await timerPhase(100)
      })
      await render()
      expect(frame()).toContain("Reply with exactly: hello")
    }
    expect(composer().plainText).toBe("")
    expect(frame()).toContain("Reply with exactly: hello")
    expect(inserts(1)).toEqual(["Reply with exactly: hello"])
    expect(inserts(0)).toEqual([])
  }
)
