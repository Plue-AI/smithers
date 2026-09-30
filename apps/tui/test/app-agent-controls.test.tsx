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
  text,
  baseDirectory: join(cwd, "flows/review"),
  digest: "b".repeat(64),
  capabilities: ["fs:read:**"]
})
const resolveBody = async (index: number, value = body()) => {
  await act(async () => {
    bodies[index]!.gate.resolve(value)
    await setImmediate()
  })
  await waitFor(() => turns.some((turn) => turn.input.role === "worker"))
}
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
  const listed: ReadonlyArray<Listed> = [
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

test("direct /agent without its prompt keeps the composer field and defers all body and Host work", async () => {
  await command("/agent review")
  expect(frame()).toContain("/agent review")
  expect(bodies).toEqual([])
  expect(turns).toEqual([])
  expect(tabs()).toEqual([])
  await type("Check one file")
  await key("RETURN", { meta: true })
  await waitFor(() => bodies.length === 1)
  expect(tabs().at(-1)!.tab.prompt).toBe("Check one file")
  expect(tabs().at(-1)!.tab.agent?.name).toBe("review")
})

test("an unresolved body leaves Chat usable, and only its real body receipt admits the configured worker", async () => {
  await command("/agent review Check src/one.ts")
  await waitFor(() => bodies.length === 1)
  expect(tabs().at(-1)!.tab.status).toBe("requested")
  expect(turns).toHaveLength(0)
  expect(bodies[0]!.admitted.filter((record) => record.type === "tab").at(-1)?.tab).toMatchObject({
    prompt: "Check src/one.ts",
    status: "requested",
    agent: { name: "review" }
  })
  await type("Chat while loading")
  expect(frame()).toContain("Chat while loading")
  await key("RETURN")
  expect(turns[0]!.input.prompt).toBe("Chat while loading")
  expect(turns[0]!.input.seat).toBe("replay:chat")
  expect(tabs().at(-1)!.tab.status).toBe("requested")
  await resolveBody(0)
  expect(turns[1]!.input).toMatchObject({
    prompt: "Check src/one.ts",
    seat: "replay:worker",
    role: "worker",
    agent: { name: "review", digest: "b".repeat(64), thinking: "high", flows: ["read"], envelope: ["fs:read:**"] }
  })
  expect(turns[1]!.input.agent?.system).toStartWith("Review the named file only.")
  expect(tabs().at(-1)!.tab.status).toBe("running")
  expect(tabs().at(-1)!.tab.agent).toEqual({ name: "review", digest: "b".repeat(64) })
  await type("Retained draft")
  expect(frame()).toContain("Retained draft")
})

test.each([
  { command: "/agent missing Check one file", message: "No agent named missing" },
  { command: "/agent module Check one file", message: "module is a module flow; run it with smithers.run" }
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

test("a body read failure remains durable and retry rereads the edited body without starting Chat", async () => {
  await command("/agent review Check one file")
  await waitFor(() => bodies.length === 1)
  const id = tabs().at(-1)!.tab.id
  await act(async () => {
    bodies[0]!.gate.reject(new Error("Body unavailable\nprivate stack"))
    await setImmediate()
  })
  await waitFor(() => tabs().at(-1)?.tab.status === "failed")
  expect(tabs().at(-1)!.tab).toMatchObject({ id, status: "failed", code: "unreadable", message: "Body unavailable" })
  expect(turns).toEqual([])
  await command(`/retry ${id}`)
  await waitFor(() => bodies.length === 2)
  expect(bodies.map((pending) => pending.name)).toEqual(["review", "review"])
  expect(tabs().at(-1)!.tab.status).toBe("requested")
  await resolveBody(1, { ...body("Edited review instructions."), digest: "c".repeat(64) })
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("Check one file")
  expect(turns[0]!.input.role).toBe("worker")
  expect(turns[0]!.input.agent?.system).toStartWith("Edited review instructions.")
  expect(tabs().at(-1)!.tab.agent).toEqual({ name: "review", digest: "c".repeat(64) })
})

test("a person can start a person-only agent while the coordinator's runtime delegation refuses it", async () => {
  await command("Coordinator turn")
  expect(() =>
    turns[0]!.input.runtime!.delegate!({ id: "forbidden", title: "Manual", prompt: "Manual check", agent: "manual" })
  )
    .toThrow("manual is for a person to start")
  expect(tabs()).toEqual([])
  await command("/agent manual Manual check")
  await waitFor(() => bodies.length === 1)
  expect(bodies[0]!.name).toBe("manual")
  await resolveBody(0)
  expect(turns.map((turn) => ({ prompt: turn.input.prompt, role: turn.input.role }))).toEqual([
    { prompt: "Coordinator turn", role: undefined },
    { prompt: "Manual check", role: "worker" }
  ])
  expect(tabs().at(-1)!.tab.agent?.name).toBe("manual")
})

test.each(["resolve", "reject"] as const)(
  "stopping and retrying a loading agent fences an old %s receipt",
  async (receipt) => {
    await command("/agent review Check one file")
    await waitFor(() => bodies.length === 1)
    const original = tabs().at(-1)!.tab
    await command(`/stop ${original.id}`)
    expect(tabs().at(-1)!.tab.status).toBe("cancelled")
    expect(turns).toEqual([])
    await command(`/retry ${original.id}`)
    await waitFor(() => bodies.length === 2)
    const replacement = tabs().at(-1)!.tab
    expect(replacement.id).toBe(original.id)
    expect(replacement.file).not.toBe(original.file)
    await resolveBody(1, { ...body("Current instructions."), digest: "c".repeat(64) })
    await act(async () => {
      if (receipt === "resolve") bodies[0]!.gate.resolve({ ...body("Stale instructions."), digest: "a".repeat(64) })
      else bodies[0]!.gate.reject(new Error("Stale body failure"))
      await setImmediate()
    })
    await render()
    expect(turns).toHaveLength(1)
    expect(turns[0]!.input.agent?.system).toStartWith("Current instructions.")
    expect(turns[0]!.input.agent?.digest).toBe("c".repeat(64))
    expect(tabs().at(-1)!.tab).toMatchObject({
      id: original.id,
      file: replacement.file,
      status: "running",
      agent: { name: "review", digest: "c".repeat(64) }
    })
    expect(Session.load(replacement.file).filter((record) => record.type === "outcome")).toEqual([])
    await type("Chat remains usable")
    expect(frame()).toContain("Chat remains usable")
  }
)

test("a failed agent body exposes its saved refusal in the worker view and expanded details", async () => {
  await command("/agent review Check one file")
  await waitFor(() => bodies.length === 1)
  await act(async () => {
    bodies[0]!.gate.reject(new Error("Body unavailable\nprivate stack"))
    await setImmediate()
  })
  await waitFor(() => tabs().at(-1)?.tab.status === "failed")
  expect(tabs().at(-1)!.tab.message).toBe("Body unavailable")
  await command("/tabs")
  await waitFor(() => frame().includes("Back (ctrl+y)") && frame().includes("Resume"))
  await key("o", { ctrl: true })
  expect(frame()).toContain("Body unavailable")
  expect(frame()).not.toContain("private stack")
  expect(turns).toEqual([])
}, 15000)

test(
  "a saved failed agent reloads its safe refusal and retry reads the changed body without replaying old work",
  async () => {
    await command("/agent review Check one file")
    await waitFor(() => bodies.length === 1)
    await act(async () => {
      bodies[0]!.gate.reject(new Error("Body unavailable\nprivate stack"))
      await setImmediate()
    })
    await waitFor(() => tabs().at(-1)?.tab.status === "failed")
    const failed = tabs().at(-1)!.tab
    const file = Session.list(cwd)[0]!.file
    expect(failed.message).toBe("Body unavailable")
    expect(failed.failure).toBeDefined()
    const failures = Session.load(failed.file).filter((record) => record.type === "outcome")
    expect(failures).toHaveLength(1)
    expect(failures[0]!.outcome).toEqual({
      _tag: "failed",
      message: "Body unavailable",
      headline: "Worker stopped unexpectedly"
    })
    expect(failed.code).toBe("unreadable")
    await act(async () => {
      setup!.renderer.destroy()
      setup = undefined
      await setImmediate()
    })
    await mount(file)
    expect(turns).toEqual([])
    expect(bodies).toHaveLength(1)
    await command("/tabs")
    await waitFor(() => frame().includes("Back (ctrl+y)") && frame().includes("Resume"))
    await key("o", { ctrl: true })
    expect(frame()).toContain("Body unavailable")
    expect(frame()).not.toContain("private stack")
    const restored = tabs().at(-1)!.tab
    expect(restored.id).toBe(failed.id)
    expect(restored.status).toBe("failed")
    expect(restored.failure).toEqual(failed.failure)
    expect(Session.load(failed.file).filter((record) => record.type === "outcome")).toEqual(failures)
    await key("r")
    await waitFor(() => bodies.length === 2)
    expect(bodies[1]!.name).toBe("review")
    await resolveBody(1, { ...body("Restored and edited instructions."), digest: "c".repeat(64) })
    expect(turns).toHaveLength(1)
    expect(turns[0]!.input.prompt).toBe("Check one file")
    expect(turns[0]!.input.role).toBe("worker")
    expect(turns[0]!.input.agent?.system).toStartWith("Restored and edited instructions.")
    expect(turns[0]!.input.agent?.digest).toBe("c".repeat(64))
    expect(turns[0]!.input.history).toEqual([{
      kind: "exchange",
      user: "Check one file",
      answer:
        "Continue the same worker task from this prior run. Do not repeat completed steps.\n\n\nError: Worker stopped unexpectedly\nLast error: Body unavailable"
    }])
    expect(Session.load(failed.file).filter((record) => record.type === "outcome")).toEqual(failures)
    expect(Session.load(tabs().at(-1)!.tab.file).filter((record) => record.type === "outcome")).toEqual([])
  },
  15000
)

test(
  "a legacy saved failed agent without presentation metadata or worker file still exposes its safe refusal",
  async () => {
    await command("/agent review Check one file")
    await waitFor(() => bodies.length === 1)
    await act(async () => {
      bodies[0]!.gate.reject(new Error("Body unavailable\nprivate stack"))
      await setImmediate()
    })
    await waitFor(() => tabs().at(-1)?.tab.status === "failed")
    const failed = tabs().at(-1)!.tab
    const original = Session.load(Session.list(cwd)[0]!.file)
    await act(async () => {
      setup!.renderer.destroy()
      setup = undefined
      await setImmediate()
    })
    const legacy = Session.create(cwd)
    for (const record of original) {
      if (record.type === "session") continue
      if (record.type === "tab") {
        const tab = { ...record.tab }
        delete tab.failure
        legacy.append({ ...record, tab })
      } else legacy.append(record)
    }
    rmSync(failed.file, { force: true })
    expect(existsSync(failed.file)).toBe(false)
    const legacyTab = Session.load(legacy.file).filter((record) => record.type === "tab").at(-1)!.tab
    expect(legacyTab).toMatchObject({
      id: failed.id,
      status: "failed",
      code: "unreadable",
      message: "Body unavailable"
    })
    expect(legacyTab.failure).toBeUndefined()
    await mount(legacy.file)
    expect(turns).toEqual([])
    expect(bodies).toHaveLength(1)
    await command("/tabs")
    await waitFor(() => frame().includes("Back (ctrl+y)") && frame().includes("Resume"))
    await key("o", { ctrl: true })
    expect(frame()).toContain("Body unavailable")
    expect(frame()).not.toContain("private stack")
  },
  15000
)
