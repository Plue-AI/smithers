import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import type * as Extension from "../src/extension.ts"
import type * as Host from "../src/host.ts"
import type * as Panels from "../src/panels.ts"
import * as Session from "../src/session.ts"
import * as Theme from "../src/theme.ts"

// Headless component units: actual runtime projection, keys and session files;
// the public Host boundary is controlled. No provider or shell executes.
let root = ""
let cwd = ""
let previousRoot: string | undefined
let previousTheme = Theme.activeTheme()
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let turns: Array<{ input: Host.TurnInput; done: ReturnType<typeof Promise.withResolvers<Host.Outcome>> }> = []
const records = () => Session.list(cwd).flatMap((summary) => Session.load(summary.file))
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
const key = async (name: string, modifiers: { ctrl?: boolean; meta?: boolean } = {}) => {
  await act(async () => {
    setup!.mockInput.pressKey(name, modifiers)
    await setImmediate()
  })
  await render()
}
const publish = async (value: Extension.Contribution) => {
  await act(async () => {
    turns[0]!.input.runtime!.publish(value)
    await setImmediate()
  })
  await render()
}
const complete = async () => {
  await act(async () => {
    turns[0]!.input.onEvent(
      new AgentEvent.Resolved({
        eventType: "flows.harness.resolved.v1",
        message: ModelRequest.Message.assistant("Published")
      })
    )
    turns[0]!.done.resolve({ _tag: "done", answer: "Published" })
    await setImmediate()
  })
  await render()
}
/** Ctrl+K lists each view by title; Enter opens it. */
const openView = async (title: string) => {
  await key("k", { ctrl: true })
  await type(title)
  await key("RETURN")
}
const panel = (rows: ReadonlyArray<Panels.Row>, placement?: Panels.Panel["placement"]): Panels.Panel => ({
  id: "audit",
  title: "Audit view",
  summary: "Checks ready",
  rows,
  ...(placement === undefined ? {} : { placement })
})
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tui-app-panels-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  previousTheme = Theme.activeTheme()
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  turns = []
  const host: Host.Host = {
    cwd,
    judged: false,
    run: (input) => {
      const done = Promise.withResolvers<Host.Outcome>()
      turns.push({ input, done })
      return { done: done.promise, cancel: () => done.resolve({ _tag: "cancelled" }) }
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
      />,
      { width: 140, height: 35, exitOnCtrlC: false }
    )
  })
  await type("Publish views")
  await key("RETURN")
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
    Theme.setTheme(previousTheme)
    if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test.each(
  [
    { placement: "tab", draft: "" },
    { placement: "tab", draft: "Draft" },
    { placement: "card", draft: "" },
    { placement: "card", draft: "Draft" }
  ] as const
)(
  "$placement publication preserves composer ownership with draft '$draft' and invokes no action",
  async ({ placement, draft }) => {
    if (draft !== "") await type(draft)
    const value = panel([{
      id: "run",
      label: "Run checks",
      details: [],
      action: { label: "Run", action: { kind: "prompt", prompt: "Check now" } }
    }])
    await publish({ kind: "panel", placement, panel: value })
    expect(turns.map((turn) => turn.input.prompt)).toEqual(["Publish views"])
    const published = placement === "card"
      ? records().filter((record) => record.type === "card").map((record) => record.panel)
      : records().filter((record) => record.type === "panel").map((record) => record.panel)
    expect(published).toEqual([value])
    await type("kept")
    expect(frame()).toContain(`${draft}kept`)
    expect(turns).toHaveLength(1)
    expect(frame()).toContain("Audit view")
  }
)

test("updating a live card replaces its visible content in place without running either action", async () => {
  await publish({
    kind: "panel",
    placement: "card",
    panel: panel([{ id: "run", label: "Old result", details: [], action: { label: "Run", prompt: "Old action" } }])
  })
  await type("Keep draft")
  await publish({
    kind: "panel",
    placement: "card",
    panel: {
      ...panel([{ id: "run", label: "New result", details: [], action: { label: "Run", prompt: "New action" } }]),
      summary: "New summary"
    }
  })
  expect(frame()).toContain("New result")
  expect(frame()).not.toContain("Old result")
  expect(frame().match(/Audit view/g)).toHaveLength(1)
  expect(frame()).toContain("Keep draft")
  expect(records().filter((record) => record.type === "card").map((record) => record.panel.rows[0]?.label)).toEqual([
    "Old result",
    "New result"
  ])
  expect(turns).toHaveLength(1)
})

test.each(["legacy", "typed"] as const)(
  "%s row action runs only after opening, selecting and explicitly activating its owning row",
  async (kind) => {
    const second: Panels.Row["action"] = kind === "legacy"
      ? { label: "Choose second", prompt: "Second action" }
      : { label: "Choose second", action: { kind: "prompt", prompt: "Second action" } }
    await publish({
      kind: "panel",
      placement: "tab",
      panel: panel([
        {
          id: "first",
          label: "First row",
          details: [{ kind: "text", text: "First evidence" }],
          action: { label: "Choose first", prompt: "First action" }
        },
        { id: "second", label: "Second row", details: [{ kind: "text", text: "Second evidence" }], action: second }
      ])
    })
    await complete()
    await openView("Audit view")
    expect(frame()).toContain("First row")
    expect(frame()).toContain("Second row")
    expect(turns).toHaveLength(1)
    await key("ARROW_DOWN")
    await key("RETURN")
    expect(frame()).toContain("Second evidence")
    expect(turns).toHaveLength(1)
    await key("a")
    expect(turns.map((turn) => turn.input.prompt)).toEqual(["Publish views", "Second action"])
    expect(turns[1]?.input.history).toEqual([{ kind: "exchange", user: "Publish views", answer: "Published" }])
  }
)

test("a legacy shell-looking row prompt reaches the Host as text and never executes a shell command", async () => {
  const sentinel = join(root, "must-not-exist")
  const prompt = `!touch ${sentinel}`
  await publish({
    kind: "panel",
    placement: "tab",
    panel: panel([{ id: "shell", label: "Send literal prompt", details: [], action: { label: "Send", prompt } }])
  })
  await complete()
  await openView("Audit view")
  await key("a")
  expect(turns[1]?.input.prompt).toBe(prompt)
  expect(existsSync(sentinel)).toBe(false)
  expect(records().filter((record) => record.type === "shell")).toEqual([])
})

test("main view publication shows the view but preserves an in-progress draft and composer focus", async () => {
  await type("Keep this draft")
  await publish({
    kind: "panel",
    placement: "tab",
    panel: panel([{ id: "check", label: "Build checks", details: [] }], "main")
  })
  expect(frame()).toContain("Build checks")
  expect(frame()).toContain("Keep this draft")
  await type(" intact")
  expect(frame()).toContain("Keep this draft intact")
  expect(turns).toHaveLength(1)
  await key("\\", { ctrl: true })
  expect(frame()).not.toContain("Build checks")
  expect(frame()).toContain("Keep this draft intact")
  await publish({
    kind: "panel",
    placement: "tab",
    panel: panel([{ id: "check", label: "Updated checks", details: [] }], "main")
  })
  expect(frame()).not.toContain("Updated checks")
  await type(" after update")
  expect(frame()).toContain("Keep this draft intact after update")
})

test("a contributed global key queues its prompt only when invoked and leaves the draft intact", async () => {
  await type("Unsent draft")
  await publish({
    kind: "key",
    key: {
      id: "checks",
      key: "alt+r",
      label: "Run checks",
      action: { kind: "prompt", prompt: "Run contributed checks" }
    }
  })
  expect(records().filter((record) => record.type === "queued")).toEqual([])
  expect(turns).toHaveLength(1)
  await key("r", { meta: true })
  expect(
    records().filter((record) => record.type === "queued").map((record) => ({
      text: record.prompt.text,
      scope: record.prompt.scope
    }))
  ).toEqual([{ text: "Run contributed checks", scope: "chat" }])
  expect(frame()).toContain("Unsent draft")
  expect(turns).toHaveLength(1)
  await complete()
  expect(turns.map((turn) => turn.input.prompt)).toEqual(["Publish views", "Run contributed checks"])
  expect(frame()).toContain("Unsent draft")
})

test("a panel open action selects its named view only after explicit invocation", async () => {
  await publish({
    kind: "panel",
    placement: "tab",
    panel: {
      ...panel([{ id: "detail", label: "Owned detail content", details: [] }]),
      id: "detail",
      title: "Detail view"
    }
  })
  await publish({
    kind: "panel",
    placement: "tab",
    panel: panel([{
      id: "open",
      label: "Open detail",
      details: [],
      action: { label: "Open", action: { kind: "open", surface: "ui:detail" } }
    }])
  })
  expect(frame()).not.toContain("Owned detail content")
  await complete()
  await openView("Audit view")
  expect(frame()).toContain("Open detail")
  expect(frame()).not.toContain("Owned detail content")
  await key("a")
  expect(frame()).toContain("Owned detail content")
  expect(turns).toHaveLength(1)
})

test("an unavailable target in a panel action remains visible as a refusal instead of opening an empty view", async () => {
  await publish({
    kind: "panel",
    placement: "tab",
    panel: panel([{
      id: "missing",
      label: "Missing target row",
      details: [],
      action: { label: "Open", action: { kind: "open", surface: "ui:missing" } }
    }])
  })
  await complete()
  await openView("Audit view")
  await key("a")
  expect(frame()).toContain("No view ui:missing")
  expect(frame()).toContain("Missing target row")
  expect(turns).toHaveLength(1)
})
