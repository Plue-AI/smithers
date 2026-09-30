import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"
import type { Model } from "../src/models.ts"
import * as Session from "../src/session.ts"
import * as Theme from "../src/theme.ts"

// Real native headless App and session IO, with controlled Host execution and
// compaction recommendation boundaries. No provider or model calls execute.
let root = ""
let cwd = ""
let previousRoot: string | undefined
let previousTheme = Theme.activeTheme()
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let saved: Session.Writer
let turns: Array<{ input: Host.TurnInput; done: ReturnType<typeof Promise.withResolvers<Host.Outcome>> }> = []
const models: ReadonlyArray<Model> = [
  { seat: "replay:one", label: "One", provider: "Fixture" },
  { seat: "replay:two", label: "Two", provider: "Fixture" },
  { seat: "replay:three", label: "Three", provider: "Fixture" }
]
const frame = () => setup!.captureCharFrame()
const render = async () => {
  await setup!.renderOnce()
}
const type = async (text: string) => {
  await act(async () => {
    await setup!.mockInput.typeText(text)
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
    event: new AgentEvent.Resolved({
      eventType: "flows.harness.resolved.v1",
      message: ModelRequest.Message.assistant(answer)
    })
  })
  saved.append({ type: "outcome", at: 102, prompt: user, outcome: { _tag: "done", answer } })
}
const mount = async (options: { seat?: string; models?: ReadonlyArray<Model>; compact?: number } = {}) => {
  const host: Host.Host = {
    cwd,
    judged: false,
    compaction: async () => options.compact,
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
        seat={options.seat ?? "replay:one"}
        models={options.models ?? models}
        contextWindow={() => 10000}
        resume={saved.file}
      />,
      // Legacy control bytes cannot distinguish Ctrl+P from Ctrl+Shift+P.
      { width: 140, height: 35, exitOnCtrlC: false, kittyKeyboard: true }
    )
    await setImmediate()
  })
  await render()
}
const finish = async (index: number, answer: string) => {
  await act(async () => {
    turns[index]!.input.onEvent(
      new AgentEvent.Resolved({
        eventType: "flows.harness.resolved.v1",
        message: ModelRequest.Message.assistant(answer)
      })
    )
    turns[index]!.done.resolve({ _tag: "done", answer })
    await setImmediate()
  })
  await render()
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tui-app-settings-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  previousTheme = Theme.activeTheme()
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  turns = []
  saved = Session.create(cwd)
  seed("Old question", "Old answer")
  seed("Recent question", "Recent answer")
})
afterEach(async () => {
  try {
    await act(async () => {
      for (const turn of turns) turn.done.resolve({ _tag: "cancelled" })
      await setImmediate()
      setup?.renderer.destroy()
    })
  } finally {
    setup = undefined
    Theme.setTheme(previousTheme)
    if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test.each([
  { seat: "replay:one", previous: false, next: "replay:two", label: "Two" },
  { seat: "replay:three", previous: false, next: "replay:one", label: "One" },
  { seat: "replay:one", previous: true, next: "replay:three", label: "Three" },
  { seat: "replay:three", previous: true, next: "replay:two", label: "Two" }
])(
  "model cycle from $seat, previous=$previous, preserves draft and admits $next only on submit",
  async ({ seat, previous, next, label }) => {
    await mount({ seat })
    await type("Preserved draft")
    await key("p", { ctrl: true, shift: previous })
    expect(frame()).toContain(`Switched to ${label}`)
    expect(frame()).toContain("Preserved draft")
    expect(turns).toHaveLength(0)
    await type(" intact")
    await key("RETURN")
    expect(turns[0]!.input.prompt).toBe("Preserved draft intact")
    expect(turns[0]!.input.seat).toBe(next)
  }
)

test("cycling a single available model refuses without changing the draft or seat", async () => {
  await mount({ models: [models[0]!] })
  await type("Keep drafting")
  await key("p", { ctrl: true })
  expect(frame()).toContain("Only one model available")
  expect(turns).toHaveLength(0)
  await key("RETURN")
  expect(turns[0]!.input.prompt).toBe("Keep drafting")
  expect(turns[0]!.input.seat).toBe("replay:one")
})

test.each(["none", "minimal", "low", "medium", "high", "xhigh"] as const)(
  "reasoning level %s reaches the next Host admission without becoming a prompt",
  async (level) => {
    await mount()
    await command(`/thinking ${level}`)
    expect(turns).toHaveLength(0)
    expect(frame()).toContain(`Thinking level: ${level}`)
    expect(records().filter((record) => record.type === "user").map((record) => record.text))
      .toEqual(["Old question", "Recent question"])
    await command("Use selected reasoning")
    expect(turns[0]!.input.thinking).toBe(level)
    expect(turns[0]!.input.prompt).toBe("Use selected reasoning")
  }
)

test.each(["/thinking", "/thinking default"])("%s resets an explicit level to provider default", async (reset) => {
  await mount()
  await command("/thinking high")
  await command(reset)
  expect(frame()).toContain("Thinking level: default")
  await command("Use provider default")
  expect(Object.hasOwn(turns[0]!.input, "thinking")).toBe(false)
  expect(turns[0]!.input.prompt).toBe("Use provider default")
})

test.each(["HIGH", "7", "unsupported"])(
  "invalid reasoning level '%s' refuses and retains the prior valid level",
  async (invalid) => {
    await mount()
    await command("/thinking medium")
    await command(`/thinking ${invalid}`)
    // The shared toast has a bounded width; assert its visible refusal prefix.
    expect(frame()).toContain("Thinking levels: default, none, minimal, low, medium,")
    expect(turns).toHaveLength(0)
    await command("Retain valid reasoning")
    expect(turns[0]!.input.thinking).toBe("medium")
  }
)

test("model and reasoning changes leave the running input unchanged and apply to the next queued admission", async () => {
  await mount()
  await command("/thinking high")
  await command("First request")
  const running = turns[0]!.input
  await command("/model replay:two")
  await command("/thinking low")
  await type("Queued request")
  await key("RETURN", { meta: true })
  expect(turns).toHaveLength(1)
  expect({ prompt: running.prompt, seat: running.seat, thinking: running.thinking })
    .toEqual({ prompt: "First request", seat: "replay:one", thinking: "high" })
  await finish(0, "First answer")
  expect({ prompt: turns[1]!.input.prompt, seat: turns[1]!.input.seat, thinking: turns[1]!.input.thinking })
    .toEqual({ prompt: "Queued request", seat: "replay:two", thinking: "low" })
  expect(turns[1]!.input.history).toEqual([
    { kind: "exchange", user: "Old question", answer: "Old answer" },
    { kind: "exchange", user: "Recent question", answer: "Recent answer" },
    { kind: "exchange", user: "First request", answer: "First answer" }
  ])
})

test.each([
  { start: undefined, expected: "none" },
  { start: "xhigh", expected: undefined }
])(
  "Shift+Tab cycles reasoning from $start to $expected without consuming the composer draft",
  async ({ start, expected }) => {
    await mount()
    if (start !== undefined) await command(`/thinking ${start}`)
    await type("Reasoning draft")
    await key("TAB", { shift: true })
    expect(turns).toHaveLength(0)
    expect(frame()).toContain("Reasoning draft")
    await type(" retained")
    await key("RETURN")
    expect(turns[0]!.input.prompt).toBe("Reasoning draft retained")
    expect(turns[0]!.input.thinking).toBe(expected)
  }
)

test.each([undefined, 0])(
  "unavailable or zero compaction recommendation (%s) leaves context and journal unchanged",
  async (compact) => {
    await mount(compact === undefined ? {} : { compact })
    await command("/compact")
    expect(frame()).toContain("Nothing to compact")
    expect(records().filter((record) => record.type === "compact")).toEqual([])
    await command("Keep complete context")
    expect(turns[0]!.input.history).toEqual([
      { kind: "exchange", user: "Old question", answer: "Old answer" },
      { kind: "exchange", user: "Recent question", answer: "Recent answer" }
    ])
  }
)

test("compaction refuses while a turn runs, then records and drops only the oldest context after completion", async () => {
  await mount({ compact: 1 })
  await command("Current question")
  await command("/compact")
  expect(frame()).toContain("Stop running work first")
  expect(records().filter((record) => record.type === "compact")).toEqual([])
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.history).toEqual([
    { kind: "exchange", user: "Old question", answer: "Old answer" },
    { kind: "exchange", user: "Recent question", answer: "Recent answer" }
  ])
  await finish(0, "Current answer")
  await command("/compact")
  expect(frame()).toContain("Dropped the 1 oldest context entries")
  expect(records().filter((record) => record.type === "compact").map((record) => record.dropped)).toEqual([1])
  await command("After compacting")
  expect(turns[1]!.input.history).toEqual([
    { kind: "exchange", user: "Recent question", answer: "Recent answer" },
    { kind: "exchange", user: "Current question", answer: "Current answer" }
  ])
})
