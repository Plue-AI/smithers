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

// Real native headless App and session IO, with controlled Host execution.
// No provider or model calls execute.
let root = ""
let cwd = ""
let previousRoot: string | undefined
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
const mount = async (options: { seat?: string; models?: ReadonlyArray<Model> } = {}) => {
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

test("model changes leave the running input unchanged and apply to the next queued admission", async () => {
  await mount()
  await command("First request")
  const running = turns[0]!.input
  await command("/model replay:two")
  await type("Queued request")
  await key("RETURN", { meta: true })
  expect(turns).toHaveLength(1)
  expect({ prompt: running.prompt, seat: running.seat })
    .toEqual({ prompt: "First request", seat: "replay:one" })
  await finish(0, "First answer")
  expect({ prompt: turns[1]!.input.prompt, seat: turns[1]!.input.seat })
    .toEqual({ prompt: "Queued request", seat: "replay:two" })
  expect(turns[1]!.input.history).toEqual([
    { kind: "exchange", user: "Old question", answer: "Old answer" },
    { kind: "exchange", user: "Recent question", answer: "Recent answer" },
    { kind: "exchange", user: "First request", answer: "First answer" }
  ])
})

test(
  "/compact with nothing to compact leaves context and journal unchanged",
  async () => {
    await mount()
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
