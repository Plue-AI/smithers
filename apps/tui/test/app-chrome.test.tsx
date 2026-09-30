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

test("footer names the checkout while Ctrl+O reveals and hides session totals", async () => {
  const frame = await mount(80, 24)
  expect(frame.split("\n")[23]).toContain("inventory-replay (master)")
  expect(frame.split("\n")[23]).toContain("ctrl+k Search")
  expect(frame).not.toContain("ctx")
  expect(frame).not.toContain("input  ")
  expect(frame).not.toContain("est.")
  const details = await key("o", { ctrl: true })
  expect(details).toContain("120 input  30 output  ~$0.00 est.")
  expect(details.split("\n")[23]).toContain("inventory-replay (master)")
  const collapsed = await key("o", { ctrl: true })
  expect(collapsed).not.toContain("input  ")
  expect(collapsed).not.toContain("est.")
})

test("Ctrl+O session totals include restored parent and nested finished agents exactly once", async () => {
  writer.append({
    type: "event",
    at: 110,
    event: new AgentEvent.ModelSettled({
      eventType: "flows.harness.model-settled.v1",
      message: ModelRequest.Message.assistant("Chat complete"),
      usage: { inputTokens: 880, outputTokens: 970 },
      costUsd: 0.01,
      costSource: "estimated"
    })
  })
  const seedAgent = (id: string, parent: string | undefined, input: number, output: number, usd: number) => {
    const agent = Session.create(cwd, "worker")
    agent.append({ type: "user", at: 110, text: `Review ${id}` })
    agent.append({
      type: "event",
      at: 111,
      event: new AgentEvent.ModelSettled({
        eventType: "flows.harness.model-settled.v1",
        message: ModelRequest.Message.assistant(`${id} complete`),
        usage: { inputTokens: input, outputTokens: output, cachedInputTokens: 5000 },
        costUsd: usd,
        costSource: "estimated"
      })
    })
    agent.append({
      type: "outcome",
      at: 112,
      prompt: `Review ${id}`,
      outcome: { _tag: "done", answer: `${id} complete` }
    })
    const tab = {
      id,
      title: `Review ${id}`,
      prompt: `Review ${id}`,
      seat: "replay:test",
      file: agent.file,
      depth: parent === undefined ? 1 : 2,
      status: "done" as const,
      startedAt: 110,
      endedAt: 112,
      ...(parent === undefined ? {} : { parent })
    }
    writer.append({ type: "tab", tab })
    return tab
  }
  const parent = seedAgent("review", undefined, 10000, 8000, 0.01)
  seedAgent("review/docs", "review", 15000, 10000, 0.02)
  writer.append({ type: "tab", tab: parent })
  const restored = await mount(80, 24)
  expect(restored).not.toContain("input  ")
  const details = await key("o", { ctrl: true })
  expect(details).toContain("26k input  19k output  ~$0.04 est.")
  expect(details.split("\n")[0]).toContain("Chat")
  expect(details.split("\n")[0]).toContain("Summary")
  expect(details.split("\n")[23]).toContain("inventory-replay (master)")
  await key("s", { ctrl: true })
  const summary = setup!.captureCharFrame()
  expect(summary).toContain("Review review")
  expect(summary).toContain("Review review/docs")
  expect(summary).not.toContain("%")
})
