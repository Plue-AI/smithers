import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate, setTimeout as timerPhase } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"

// Real App rendering and journal restore; host execution is outside this chrome test.
let root = ""
let cwd = ""
let previousRoot: string | undefined
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let writer: Session.Writer
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tui-chrome-"))
  cwd = join(root, "inventory-replay")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  writer = Session.create(cwd)
  writer.append({ type: "user", at: 100, text: "Review the repository" })
  writer.append({
    type: "event",
    at: 100,
    event: new AgentEvent.ModelSettled({
      eventType: "flows.harness.model-settled.v1",
      message: ModelRequest.Message.assistant(Array.from({ length: 40 }, (_, i) => `Answer row ${i}`).join("\n")),
      usage: { inputTokens: 120, outputTokens: 30 }
    })
  })
  writer.append({
    type: "event",
    at: 101,
    event: new AgentEvent.Resolved({
      eventType: "flows.harness.resolved.v1",
      message: ModelRequest.Message.assistant(Array.from({ length: 40 }, (_, i) => `Answer row ${i}`).join("\n"))
    })
  })
  writer.append({
    type: "outcome",
    at: 102,
    prompt: "Review the repository",
    outcome: { _tag: "done", answer: "Done" }
  })
})
afterEach(async () => {
  await act(async () => setup?.renderer.destroy())
  setup = undefined
  if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
  else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
  rmSync(root, { recursive: true, force: true })
})
const mount = async (width: number, height: number) => {
  const host: Host.Host = {
    cwd,
    judged: false,
    run: () => {
      throw new Error("Chrome must not start a turn")
    },
    dispose: async () => {}
  }
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        seat="replay:test"
        models={[{ seat: "replay:test", label: "Replay", provider: "Fixture" }]}
        contextWindow={() => 10000}
        resume={writer.file}
        branch="master"
      />,
      { width, height }
    )
    await setImmediate()
  })
  await setup!.renderOnce()
  const deadline = Date.now() + 3000
  while (!setup!.captureCharFrame().includes("Answer row") && Date.now() < deadline) {
    await act(async () => timerPhase(20))
    await setup!.renderOnce()
  }
  return setup!.captureCharFrame()
}
const key = async (name: string, modifiers: { ctrl?: boolean } = {}) => {
  await act(async () => {
    setup!.mockInput.pressKey(name, modifiers)
    if (name === "ESCAPE") await timerPhase(80)
    await setImmediate()
  })
  await setup!.renderOnce()
  return setup!.captureCharFrame()
}

test.each([[80, 24], [110, 32]])(
  "idle chrome reserves two composer rows and footer at %sx%s",
  async (width, height) => {
    const frame = await mount(width!, height!)
    const rows = frame.split("\n")
    expect(rows[0]).toContain("Chat")
    expect(rows[0]).toContain("Summary")
    expect(rows[height! - 3]).toContain("Ask Smithers to change this repository")
    expect(rows[height! - 2]).toContain("Replay")
    expect(frame).not.toContain("Pause")
    expect(frame).not.toContain("ctrl+t")
    expect(rows.filter((row) => row.includes("Answer row")).length).toBeGreaterThanOrEqual(height! - 7)
  }
)

test("Ctrl+T overlays one row and Escape restores the same Chat draft", async () => {
  const before = await mount(80, 24)
  await act(async () => setup!.mockInput.typeText("Draft stays here"))
  await setup!.renderOnce()
  const drafting = setup!.captureCharFrame()
  const inspecting = await key("t", { ctrl: true })
  expect(inspecting).toContain("esc Back")
  expect(inspecting.split("\n").filter((row) => row.includes("esc Back"))).toHaveLength(1)
  expect(inspecting).toContain("Draft stays here")
  expect(inspecting.split("\n")[0]).toBe(before.split("\n")[0])
  const restored = await key("ESCAPE")
  expect(restored).not.toContain("esc Back")
  expect(restored).toContain("Draft stays here")
  expect(restored).toBe(drafting)
  await act(async () => setup!.mockInput.typeText("!"))
  await setup!.renderOnce()
  expect(setup!.captureCharFrame()).toContain("Draft stays here!")
})

// Native input can deliver the focus key and navigation in a single read.
test("Ctrl+T and bracket navigation in one input burst never enter the Chat draft", async () => {
  await mount(80, 24)
  await act(async () => {
    await setup!.mockInput.typeText("Draft")
    setup!.renderer.stdin.emit("data", Buffer.from("\x14\x1b[H]"))
    await setImmediate()
  })
  await setup!.renderOnce()
  const inspecting = setup!.captureCharFrame()
  expect(inspecting).toContain("esc Back")
  expect(inspecting).toContain("Draft")
  expect(inspecting).not.toContain("Draft]")
  await key("ESCAPE")
  await act(async () => setup!.mockInput.typeText("!"))
  await setup!.renderOnce()
  expect(setup!.captureCharFrame()).toContain("Draft!")
})

test("Return exits timeline before later draft bytes in the same input burst", async () => {
  await mount(80, 24)
  await act(async () => {
    await setup!.mockInput.typeText("Draft")
    setup!.renderer.stdin.emit("data", Buffer.from("\x14\x1b[H]\r!"))
    await setImmediate()
  })
  await setup!.renderOnce()
  const frame = setup!.captureCharFrame()
  expect(frame).not.toContain("esc Back")
  expect(frame).toContain("Draft!")
  expect(frame).not.toContain("Draft]")
})
