import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import { type Body, FlowError, type Listed, type Port } from "../src/flows.ts"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"
import * as Theme from "../src/theme.ts"

// Actual App command/picker routing and real session IO. Flow discovery/body
// and Host execution are typed boundary doubles; no provider executes.
let root = ""
let cwd = ""
let previousRoot: string | undefined
let previousTheme = Theme.activeTheme()
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let bodies: Array<
  { name: string; gate: ReturnType<typeof Promise.withResolvers<Body>>; admitted: ReadonlyArray<Session.Record> }
> = []
let turns: Array<{ input: Host.TurnInput; gate: ReturnType<typeof Promise.withResolvers<Host.Outcome>> }> = []
let discoveries = 0
let host: Host.Host
let flows: Port
let listed: ReadonlyArray<Listed> = []
const records = () => Session.list(cwd).flatMap((session) => Session.load(session.file))
const tabs = () => records().filter((record) => record.type === "tab")
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
// Submit literal arguments instead of accepting the completion menu's row.
const command = async (text: string) => {
  await type(text)
  await key("RETURN", { meta: true })
}
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!condition() && Date.now() < deadline) {
    await act(async () => {
      await setImmediate()
    })
    await render()
  }
  if (!condition()) throw new Error("Public agent state did not settle")
}
const body = (text = "Review the named file only."): Body => ({
  descriptor: listed[0]!,
  text,
  baseDirectory: join(cwd, "flows/review"),
  digest: "b".repeat(64),
  capabilities: ["fs:read:**"]
})
const mount = async (resume?: string) => {
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        seat="replay:chat"
        workerSeat="replay:worker"
        models={[{ seat: "replay:chat", label: "Chat", provider: "Fixture" }, {
          seat: "replay:worker",
          label: "Worker",
          provider: "Fixture"
        }]}
        contextWindow={() => 10000}
        flows={flows}
        {...(resume === undefined ? {} : { resume })}
      />,
      { width: 140, height: 35, exitOnCtrlC: false, kittyKeyboard: true }
    )
    await setImmediate()
  })
  await render()
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tui-app-agents-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  previousTheme = Theme.activeTheme()
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  bodies = []
  turns = []
  discoveries = 0
  listed = [
    {
      name: "review",
      description: "Review one file",
      modelInvocable: true,
      kind: "markdown",
      seat: "replay:worker",
      effort: "high",
      flows: ["read"],
      capabilities: ["*"],
      path: join(cwd, "flows/review/flow.mdx")
    },
    {
      name: "manual",
      description: "Person starts this agent",
      modelInvocable: false,
      kind: "markdown",
      flows: [],
      capabilities: [],
      path: join(cwd, "flows/manual/flow.mdx")
    },
    {
      name: "module",
      description: "Executable module only",
      modelInvocable: true,
      kind: "module",
      flows: [],
      capabilities: [],
      path: join(cwd, "flows/module/flow.ts")
    }
  ]
  flows = {
    discover: async () => {
      discoveries++
      return listed
    },
    input: async () => undefined,
    body: (name) => {
      const gate = Promise.withResolvers<Body>()
      bodies.push({ name, gate, admitted: records() })
      return gate.promise
    },
    plan: async () => {
      throw new FlowError("refused", "No module execution in this fixture")
    },
    start: async () => {
      throw new FlowError("refused", "No module execution in this fixture")
    },
    resume: async () => ({ kind: "cancelled" }),
    watch: () => ({ done: Promise.resolve({ kind: "cancelled" }), close: () => {} }),
    events: async () => [],
    cancel: async () => {},
    dispose: async () => {}
  }
  host = {
    cwd,
    judged: false,
    dispose: async () => {},
    run: (input) => {
      const gate = Promise.withResolvers<Host.Outcome>()
      turns.push({ input, gate })
      return { done: gate.promise, cancel: () => gate.resolve({ _tag: "cancelled" }) }
    }
  }
  await mount()
  await waitFor(() => discoveries > 0)
})
afterEach(async () => {
  try {
    await act(async () => {
      // Fence the workspace before releasing body reads, so cleanup cannot
      // admit another worker after the controlled Host gates were drained.
      try {
        setup?.renderer.destroy()
      } finally {
        for (const pending of bodies) pending.gate.resolve(body())
        await Promise.all(bodies.map((pending) => pending.gate.promise.catch(() => undefined)))
        await setImmediate()
        // Even a failed native destroy may leave an unfenced body continuation.
        // Drain Host turns after those body continuations had an event-loop phase.
        for (const turn of turns) turn.gate.resolve({ _tag: "cancelled" })
        await Promise.all(turns.map((turn) => turn.gate.promise))
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

test("Agents picker excludes module flows and asks for the selected agent's prompt before any read or run", async () => {
  await command("/agent")
  expect(frame()).toContain("Review one file")
  expect(frame()).toContain("Person starts this agent")
  expect(frame()).not.toContain("Executable module only")
  expect(bodies).toEqual([])
  expect(turns).toEqual([])
  await type("review")
  await key("RETURN")
  expect(frame()).toContain("/agent review")
  expect(bodies).toEqual([])
  expect(tabs()).toEqual([])
  await type("Review src/one.ts")
  await key("RETURN", { meta: true })
  await waitFor(() => bodies.length === 1)
  expect(bodies[0]!.name).toBe("review")
  expect(tabs().at(-1)!.tab).toMatchObject({
    prompt: "Review src/one.ts",
    agent: { name: "review" },
    status: "requested"
  })
  expect(turns).toEqual([])
})

test("direct /agent without its prompt keeps the composer field, and Enter after the prompt starts it", async () => {
  await command("/agent review")
  expect(frame()).toContain("/agent review")
  await key("RETURN")
  expect(frame()).toContain("Type what review should do")
  expect(bodies).toEqual([])
  expect(turns).toEqual([])
  expect(tabs()).toEqual([])
  await type("Check one file")
  await key("RETURN")
  await waitFor(() => bodies.length === 1)
  expect(tabs().at(-1)!.tab.prompt).toBe("Check one file")
  expect(tabs().at(-1)!.tab.agent?.name).toBe("review")
})

test.each([
  { command: "/agent missing Check one file", message: "No agent named missing" }
])("$command refuses before a tab, body read or Host admission", async ({ command: input, message }) => {
  await command(input)
  expect(frame()).toContain(message)
  expect(tabs()).toEqual([])
  expect(bodies).toEqual([])
  expect(turns).toEqual([])
  await command("Recover in Chat")
  expect(turns[0]!.input.prompt).toBe("Recover in Chat")
  expect(turns[0]!.input.history).toEqual([])
})
