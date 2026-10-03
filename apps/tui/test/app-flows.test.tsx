import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate, setTimeout } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import { FlowError, type Listed, type Loaded, type Port } from "../src/flows.ts"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"

// The App over real session storage and a typed flow Port double: the catalog, the home
// screen and a flow added after the host loaded, through the keys a person presses.
let root = ""
let cwd = ""
let previousRoot: string | undefined
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let listed: ReadonlyArray<Listed> = []
let loaded: Loaded | undefined
let starts = 0
const frame = () => setup!.captureCharFrame()
const records = () => Session.list(cwd).flatMap((summary) => Session.load(summary.file))
const settle = async () => {
  await act(async () => {
    await setTimeout(20)
  })
  await setup!.renderOnce()
}
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!condition() && Date.now() < deadline) await settle()
  if (!condition()) throw new Error(`The screen did not settle:\n${frame()}`)
}
const press = async (...keys: Array<string>) => {
  await act(async () => {
    await setup!.mockInput.pressKeys(keys)
  })
  await settle()
}
const type = async (text: string) => {
  await act(async () => {
    await setup!.mockInput.typeText(text)
  })
  await settle()
}
const module = (name: string, description: string): Listed => ({
  name,
  description,
  kind: "module",
  modelInvocable: true,
  flows: [],
  capabilities: [],
  path: join(cwd, `flows/${name}/flow.ts`)
})
const mount = async () => {
  const host: Host.Host = {
    cwd,
    judged: false,
    run: () => ({ done: new Promise(() => {}), cancel: () => {} }),
    dispose: async () => {}
  }
  const port: Port = {
    warm: async () => {},
    loaded: async () => loaded,
    discover: async () => listed,
    input: async (flow) => {
      if (flow === "sum") return Schema.Struct({ a: Schema.Number, unit: Schema.Literals(["kg", "lb"]) })
      throw new FlowError("unknown_flow", `Unknown flow ${flow}`, { subject: flow })
    },
    body: async () => {
      throw new FlowError("refused", "Module flow")
    },
    plan: async () => ({ raw: {} }),
    start: async () => {
      starts++
      return new Promise(() => {})
    },
    resume: async (runId) => ({ runId }),
    watch: () => ({ done: new Promise(() => {}), close: () => {} }),
    events: async () => [],
    cancel: async () => {},
    dispose: async () => {}
  }
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        flows={port}
        seat="replay:test"
        models={[{ seat: "replay:test", label: "Replay", provider: "Fixture" }]}
        contextWindow={() => 10000}
      />,
      { width: 110, height: 32, exitOnCtrlC: false }
    )
    await setImmediate()
  })
  await settle()
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tui-app-flows-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  starts = 0
  listed = [
    module("sum", "Add two numbers"),
    { ...module("review", "Reviews the change"), kind: "markdown", tui: { keys: [{ key: "alt+z", label: "Review" }] } }
  ]
  loaded = {
    flows: [{ name: "sum", input: Schema.Struct({ a: Schema.Number, unit: Schema.Literals(["kg", "lb"]) }) }],
    refused: []
  }
})
afterEach(async () => {
  try {
    await act(async () => {
      setup?.renderer.destroy()
      await setImmediate()
    })
  } finally {
    setup = undefined
    if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test("the home screen lists the repository's declared flows with their keys", async () => {
  await mount()
  await waitFor(() => frame().includes("alt+z"))
  const lines = frame().split("\n")
  expect(lines.find((line) => /^\s+sum\b/.test(line))).toBeDefined()
  expect(lines.find((line) => /^\s+review\s+alt\+z\s*$/.test(line))).toBeDefined()
  expect(frame()).toContain("smithers")
})

test("a directory that declares no flows keeps the quiet home screen", async () => {
  listed = []
  loaded = undefined
  await mount()
  await settle()
  const words = frame().split("\n").map((line) => line.trim()).filter((line) => line !== "")
  const logo = words.indexOf("smithers")
  expect(logo).toBeGreaterThanOrEqual(0)
  // The hint line follows the logo directly: nothing is invented to fill the space.
  expect(words[logo + 1]).toMatch(/^\/ commands/)
})

test("/flows shows inputs and keys; a flow added after launch says Restart to load and Enter keeps the list", async () => {
  listed = [...listed, module("echo-label", "Echo a label")]
  await mount()
  await type("/flows")
  await press("RETURN")
  await waitFor(() => frame().includes("Restart to load"))
  const row = (name: string) => frame().split("\n").find((line) => line.includes(` ${name} `)) ?? ""
  expect(row("sum")).toMatch(/sum\s+a, unit/)
  expect(row("review")).toContain("alt+z")
  expect(row("echo-label")).toMatch(/echo-label\s+Restart to load/)
  expect(frame()).toContain("enter Run")
  await type("echo")
  expect(frame()).not.toContain("enter Run")
  expect(frame()).toContain("esc Back")
  await press("RETURN")
  // Still open, nothing requested.
  expect(frame()).toContain("Restart to load")
  expect(records().filter((record) => record.type === "flow")).toEqual([])
  expect(starts).toBe(0)
})

test("/flow on a flow added after launch says Restart to load instead of No flow named", async () => {
  listed = [...listed, module("echo-label", "Echo a label")]
  await mount()
  await waitFor(() => frame().includes("alt+z"))
  // A flow that cannot run yet is not offered on the home screen.
  expect(frame()).not.toContain("echo-label")
  await type("/flow echo-label")
  await press("ESCAPE")
  await press("RETURN")
  await waitFor(() => frame().includes("Restart to load echo-label."))
  expect(frame()).not.toContain("No flow named")
  expect(records().filter((record) => record.type === "flow")).toEqual([])
})

test("a flow form shows every field and its choices, with no estimate toast", async () => {
  await mount()
  await waitFor(() => frame().includes("alt+z"))
  await type("/flow sum")
  await press("ESCAPE")
  await press("RETURN")
  await waitFor(() => /Unit\s+kg\s+lb/.test(frame()))
  expect(frame()).toMatch(/A\s+/)
  expect(frame()).toContain("tab Next")
  expect(frame()).toContain("enter Run")
  expect(frame()).not.toContain("No estimate")
  // The request is in the chat; no splash under the form.
  expect(frame()).toContain("/flow sum")
  expect(frame()).not.toContain("/ commands")
  // The form asks; the card does not repeat it until the form closes with the run still waiting.
  expect(frame()).not.toContain("Needs:")
  await press("ESCAPE")
  await waitFor(() => frame().includes("◌ sum · Needs: A, Unit"))
})

test("/smithers shows only factory content, never the flows or their runs", async () => {
  await mount()
  await waitFor(() => frame().includes("alt+z"))
  await type("/smithers")
  await press("ESCAPE")
  await press("RETURN")
  // No factory in a directory without a remote or apps: one line, and chat stays.
  await waitFor(() => frame().includes("No factory for this directory"))
  expect(frame()).not.toMatch(/\d+ flows · \d+ active/)
})
