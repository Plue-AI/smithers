import { testRender } from "@opentui/react/test-utils"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import { type Body, FlowError, type Listed, type Port } from "../src/flows.ts"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"
import { seats } from "../src/workspace.ts"

// Actual App command/picker routing and real session IO. Flow discovery/body
// and Host execution are typed boundary doubles; no provider executes.
let root = ""
let cwd = ""
let previousRoot: string | undefined
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let bodies: Array<
  { name: string; gate: ReturnType<typeof Promise.withResolvers<Body>>; admitted: ReadonlyArray<Session.Record> }
> = []
let turns: Array<{ input: Host.TurnInput; gate: ReturnType<typeof Promise.withResolvers<Host.Outcome>> }> = []
let discoveries = 0
let cancellations: Host.TurnInput[] = []
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
const mount = async (resume?: string, width = 140, height = 35) => {
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
      { width, height, exitOnCtrlC: false, kittyKeyboard: true }
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
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  bodies = []
  turns = []
  discoveries = 0
  cancellations = []
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
      return {
        done: gate.promise,
        cancel: () => {
          cancellations.push(input)
          gate.resolve({ _tag: "cancelled" })
        }
      }
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
    if (previousRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test("/flows lists flows and agents together; Enter on an agent starts it at once with what it describes", async () => {
  await command("/flows")
  expect(frame()).toContain("Flows")
  for (const name of ["review", "manual", "module"]) expect(frame()).toContain(name)
  expect(bodies).toEqual([])
  expect(turns).toEqual([])
  await type("review")
  await key("RETURN")
  // No second step: the catalog's Enter runs the selection.
  await waitFor(() => bodies.length === 1)
  expect(bodies[0]!.name).toBe("review")
  expect(tabs().at(-1)!.tab).toMatchObject({
    prompt: "Review one file",
    agent: { name: "review" },
    status: "requested"
  })
  expect(frame()).not.toContain("/agent")
  expect(turns).toEqual([])
})

test("direct /flow agent without a prompt runs its description", async () => {
  await command("/flow review")
  await waitFor(() => bodies.length === 1)
  expect(tabs().at(-1)!.tab.prompt).toBe("Review one file")
  expect(tabs().at(-1)!.tab.agent?.name).toBe("review")
  expect(turns).toEqual([])
})

test("/flow <agent> <prompt> starts the agent with the rest of the line as its prompt", async () => {
  await command("/flow review Check one file")
  await waitFor(() => bodies.length === 1)
  expect(tabs().at(-1)!.tab.prompt).toBe("Check one file")
  expect(tabs().at(-1)!.tab.agent?.name).toBe("review")
  // A person may start an agent the model may not.
  await command("/flow manual")
  await waitFor(() => bodies.length === 2)
  expect(tabs().at(-1)!.tab).toMatchObject({ prompt: "Person starts this agent", agent: { name: "manual" } })
})

// Remount with the first discovery held open, as right after launch.
const remountUndiscovered = async (resume?: string) => {
  await act(async () => {
    setup!.renderer.destroy()
  })
  const gate = Promise.withResolvers<ReadonlyArray<Listed>>()
  flows = {
    ...flows,
    discover: () => {
      discoveries++
      return gate.promise
    }
  }
  discoveries = 0
  await mount(resume, 80, 24)
  await waitFor(() => discoveries > 0)
  return gate
}

test("/flow <agent> before discovery persists and shows its request, then dispatches the agent", async () => {
  const gate = await remountUndiscovered()
  await command("/flow review Check math.js")
  expect(bodies).toEqual([])
  expect(JSON.stringify(records())).toContain("/flow review Check math.js")
  expect(frame()).toContain("/flow review Check math.js")
  expect(frame()).toMatch(/review.*requested/)
  await key("TAB")
  await key("RETURN")
  expect(frame()).toMatch(/◌ review\s*\n\s*requested/)
  await act(async () => {
    gate.resolve(listed)
    await setImmediate()
  })
  await waitFor(() => bodies.length === 1)
  expect(tabs().at(-1)!.tab).toMatchObject({ prompt: "Check math.js", agent: { name: "review" } })
  expect(records().filter((record) => record.type === "run")).toEqual([])
  await waitFor(() => frame().includes("Back (ctrl+y)"))
  expect(frame()).not.toContain("Unknown run")
})

test("an undiscovered /flow request survives restart and ignores the old discovery without duplicating agent admission", async () => {
  const stale = await remountUndiscovered()
  const request = "/flow review Check math.js"
  await command(request)
  expect(frame()).toContain(request)
  expect(frame()).toMatch(/review.*requested/)
  const file = Session.list(cwd)[0]!.file
  expect(JSON.stringify(Session.load(file))).toContain(request)
  const admitted = Session.restore(Session.load(file)).flowCommands
  expect(admitted).toHaveLength(1)

  const current = await remountUndiscovered(file)
  expect(frame()).toContain(request)
  expect(frame()).toMatch(/review.*requested/)
  expect(Session.restore(Session.load(file)).flowCommands).toEqual(admitted)
  expect(bodies).toEqual([])
  expect(turns).toEqual([])
  await act(async () => {
    stale.resolve(listed)
    await setImmediate()
  })
  await render()
  expect(bodies).toEqual([])
  expect(tabs()).toEqual([])
  expect(frame()).toMatch(/review.*requested/)

  await act(async () => {
    current.resolve(listed)
    await setImmediate()
  })
  await waitFor(() => bodies.length === 1)
  expect(bodies[0]!.name).toBe("review")
  const restored = Session.restore(Session.load(file))
  expect(restored.flowCommands).toEqual([])
  expect(restored.workspace.tabs).toHaveLength(1)
  expect(restored.workspace.tabs[0]).toMatchObject({ prompt: "Check math.js", agent: { name: "review" } })
  bodies[0]!.gate.resolve(body())
  await waitFor(() => turns.length === 1)
  expect(turns[0]!.input.prompt).toBe("Check math.js")
  await render()
  expect(bodies).toHaveLength(1)
  expect(turns).toHaveLength(1)
})

test("an undiscovered module request survives restart and launches once from the recovered request", async () => {
  const stale = await remountUndiscovered()
  const request = "/flow module a=1"
  let planned = 0
  let launched = 0
  const done = Promise.withResolvers<{ kind: "done"; answer: string }>()
  flows = {
    ...flows,
    plan: async (name, input) => {
      expect(name).toBe("module")
      expect(input).toEqual({ a: "1" })
      planned++
      return { raw: {} }
    },
    start: async () => {
      launched++
      return "module-run"
    },
    watch: () => ({ done: done.promise, close: () => {} })
  }
  await command(request)
  expect(frame()).toContain(request)
  expect(frame()).toMatch(/module.*requested/)
  const file = Session.list(cwd)[0]!.file
  expect(JSON.stringify(Session.load(file))).toContain(request)
  const admitted = Session.restore(Session.load(file)).flowCommands
  expect(admitted).toHaveLength(1)
  const current = await remountUndiscovered(file)
  expect(frame()).toContain(request)
  expect(frame()).toMatch(/module.*requested/)
  expect(Session.restore(Session.load(file)).flowCommands).toEqual(admitted)
  await act(async () => {
    stale.resolve(listed)
    await setImmediate()
  })
  await render()
  expect(planned).toBe(0)
  expect(launched).toBe(0)
  await act(async () => {
    current.resolve(listed)
    await setImmediate()
  })
  await waitFor(() => launched === 1)
  const restored = Session.restore(Session.load(file))
  expect(restored.flowCommands).toEqual([])
  expect(restored.flows).toHaveLength(1)
  expect(restored.flows[0]).toMatchObject({ flow: "module", input: { a: "1" }, runId: "module-run" })
  expect(restored.workspace.tabs).toEqual([])
  done.resolve({ kind: "done", answer: "5" })
  await waitFor(() => frame().includes("→ 5"))
  expect(planned).toBe(1)
  expect(launched).toBe(1)
  expect(bodies).toEqual([])
  expect(turns).toEqual([])
})

// A crash can leave admission durable but its dispatch acknowledgment unwritten.
const loseDispatchReceipt = (file: string) => {
  const lines = readFileSync(file, "utf8").trimEnd().split("\n")
  const receipts = lines.filter((line) => JSON.parse(line).type === "flow-command-dispatched")
  expect(receipts).toHaveLength(1)
  writeFileSync(
    file,
    lines.filter((line) => JSON.parse(line).type !== "flow-command-dispatched").join("\n") + "\n"
  )
  expect(Session.restore(Session.load(file)).flowCommands).toHaveLength(1)
}

test("recovery retires an agent request admitted before its dispatch receipt without executing it twice", async () => {
  const gate = await remountUndiscovered()
  await command("/flow review Check math.js")
  gate.resolve(listed)
  await waitFor(() => bodies.length === 1)
  bodies[0]!.gate.resolve(body())
  await waitFor(() => turns.length === 1)
  turns[0]!.gate.resolve({ _tag: "done", answer: "Checked." })
  await waitFor(() => tabs().at(-1)?.tab.status === "done")
  const file = Session.list(cwd)[0]!.file
  const admitted = Session.restore(Session.load(file)).workspace.tabs[0]!
  await act(async () => {
    setup!.renderer.destroy()
  })
  loseDispatchReceipt(file)
  await mount(file)
  await waitFor(() => Session.restore(Session.load(file)).flowCommands.length === 0)
  expect(Session.restore(Session.load(file)).workspace.tabs).toHaveLength(1)
  expect(Session.restore(Session.load(file)).flows).toEqual([])
  expect(frame()).not.toContain("Working")
  expect(Session.restore(Session.load(file)).workspace.tabs[0]!.id).toBe(admitted.id)
  expect(bodies).toHaveLength(1)
  expect(turns).toHaveLength(1)
})

test("recovery retires a module request admitted before its dispatch receipt without executing it twice", async () => {
  await act(async () => {
    setup!.renderer.destroy()
  })
  let planned = 0
  let launched = 0
  const discovery = Promise.withResolvers<ReadonlyArray<Listed>>()
  flows = {
    ...flows,
    discover: () => discovery.promise,
    plan: async () => {
      planned++
      return { raw: {} }
    },
    start: async () => {
      launched++
      return "module-run"
    },
    watch: () => ({ done: Promise.resolve({ kind: "done", answer: "5" }), close: () => {} })
  }
  await mount(undefined, 80, 24)
  await command("/flow module a=1")
  discovery.resolve(listed)
  await waitFor(() => frame().includes("→ 5"))
  const file = Session.list(cwd)[0]!.file
  const admitted = Session.restore(Session.load(file)).flows[0]!
  await act(async () => {
    setup!.renderer.destroy()
  })
  loseDispatchReceipt(file)
  await mount(file)
  await waitFor(() => Session.restore(Session.load(file)).flowCommands.length === 0)
  expect(Session.restore(Session.load(file)).flows).toHaveLength(1)
  expect(Session.restore(Session.load(file)).flows[0]!.id).toBe(admitted.id)
  expect(planned).toBe(1)
  expect(launched).toBe(1)
  expect(bodies).toEqual([])
  expect(turns).toEqual([])
})

test("/new keeps an undiscovered request in its conversation until real completion", async () => {
  const discovery = await remountUndiscovered()
  await command("/flow review Check math.js")
  const file = Session.list(cwd)[0]!.file
  await command("/new")
  expect(frame()).toContain("Stop running work first")
  expect(frame()).toContain("/flow review Check math.js")
  expect(Session.restore(Session.load(file)).flowCommands).toHaveLength(1)
  expect(bodies).toEqual([])
  expect(turns).toEqual([])
  discovery.resolve(listed)
  await waitFor(() => bodies.length === 1)
  bodies[0]!.gate.resolve(body())
  await waitFor(() => turns.length === 1)
  turns[0]!.gate.resolve({ _tag: "done", answer: "Checked." })
  await waitFor(() => tabs().at(-1)?.tab.status === "done")
  await key("y", { ctrl: true })
  await command("/new")
  expect(frame()).not.toContain("/flow review Check math.js")
  expect(Session.restore(Session.load(file)).flowCommands).toEqual([])
  expect(Session.restore(Session.load(file)).workspace.tabs[0]!.status).toBe("done")
})

test("/flow typed before discovery settles waits; a failed discovery still runs it as a flow", async () => {
  const gate = await remountUndiscovered()
  await command("/flow module a=1")
  expect(records().filter((record) => record.type === "run")).toEqual([])
  await act(async () => {
    gate.reject(new Error("scan failed"))
    await setImmediate()
  })
  await waitFor(() => records().some((record) => record.type === "run"))
  expect(records().find((record) => record.type === "run")).toMatchObject({
    title: "module",
    request: "/flow module a=1"
  })
  expect(bodies).toEqual([])
})

test("/agent is gone: it is an unknown command and starts nothing", async () => {
  await command("/agent review Check one file")
  expect(frame()).toContain("Unknown command /agent")
  expect(tabs()).toEqual([])
  expect(bodies).toEqual([])
  expect(turns).toEqual([])
})

test("/flow with an unknown name fails on its chat card, before a tab, body read or Host admission", async () => {
  await command("/flow missing Check one file")
  await waitFor(() => frame().includes("No flow named missing; /flows lists them."))
  expect(frame()).toMatch(/✗ missing · \d+m?s · failed: No flow named missing/)
  expect(tabs()).toEqual([])
  expect(bodies).toEqual([])
  expect(turns).toEqual([])
  await command("Recover in Chat")
  expect(turns[0]!.input.prompt).toBe("Recover in Chat")
  expect(turns[0]!.input.history).toEqual([])
})

test("Stop confirmation follows the same queued worker through launch", async () => {
  await command("Coordinate reviews")
  for (let index = 0; index < seats; index++) {
    await act(async () => {
      turns[0]!.input.runtime!.delegate!({ id: `seat-${index}`, title: `Seat ${index}`, prompt: `Review ${index}` })
      await setImmediate()
    })
  }
  await command("/flow review Queued review")
  const queued = tabs().at(-1)!.tab
  expect(queued.status).toBe("queued")
  expect(bodies).toEqual([])
  await key("k", { ctrl: true })
  await type("tab:Queued review")
  await key("RETURN")
  await key("x", { meta: true })
  expect(frame()).toContain("Stop Queued review?")
  await act(async () => {
    turns[1]!.gate.resolve({ _tag: "cancelled" })
    await setImmediate()
  })
  await waitFor(() => bodies.length === 1)
  await act(async () => {
    bodies[0]!.gate.resolve(body())
    await setImmediate()
  })
  await waitFor(() => turns.some((turn) => turn.input.prompt === "Queued review"))
  const launched = turns.find((turn) => turn.input.prompt === "Queued review")!
  expect(cancellations).toEqual([])
  expect(frame()).toContain("Stop Queued review?")
  await key("RETURN")
  expect(cancellations).toEqual([launched.input])
  await waitFor(() => tabs().findLast((record) => record.tab.id === queued.id)!.tab.status === "cancelled")
})

test("Stop confirmation cannot follow a failed worker into its retry", async () => {
  await command("Coordinate retry")
  await command("/flow review Retry review")
  await waitFor(() => bodies.length === 1)
  await act(async () => {
    bodies[0]!.gate.resolve(body())
    await setImmediate()
  })
  await waitFor(() => turns.length === 2)
  const id = tabs().at(-1)!.tab.id
  await key("ARROW_RIGHT", { ctrl: true })
  await key("ARROW_RIGHT", { ctrl: true })
  await key("x", { meta: true })
  expect(frame()).toContain("Stop Retry review?")
  await act(async () => {
    turns[1]!.gate.resolve({ _tag: "failed", message: "Fixture failure", detail: "Failed while confirming" })
    await setImmediate()
  })
  await waitFor(() => tabs().at(-1)!.tab.status === "failed")
  await act(async () => {
    turns[0]!.input.runtime!.retry!(id)
    await setImmediate()
  })
  await waitFor(() => bodies.length === 2)
  await act(async () => {
    bodies[1]!.gate.resolve(body())
    await setImmediate()
  })
  await waitFor(() => turns.length === 3)
  await key("RETURN")
  expect(cancellations).toEqual([])
  expect(tabs().at(-1)!.tab.status).toBe("running")
  expect(frame()).not.toContain("Stop Retry review?")
})

test("an unresolved discovery run opens from Chat, restores, stops, and never dispatches afterward", async () => {
  const stale = await remountUndiscovered()
  let starts = 0
  flows = {
    ...flows,
    start: async () => {
      starts++
      return "unexpected"
    }
  }
  await command("/flow module a=1")
  const file = Session.list(cwd)[0]!.file
  const requested = Session.restore(Session.load(file)).flows[0]!
  expect(requested).toMatchObject({ status: "requested", pendingCommand: true })
  await key("TAB")
  await key("RETURN")
  expect(frame()).toMatch(/◌ module\s*\n\s*requested/)
  expect(frame()).not.toContain("Unknown run")
  expect(frame()).toMatch(/x.*Stop/)

  const current = await remountUndiscovered(file)
  await key("TAB")
  await key("RETURN")
  expect(frame()).toMatch(/◌ module\s*\n\s*requested/)
  await key("x")
  expect(frame()).toContain("stopped")
  expect(frame()).not.toMatch(/r.*Retry/)
  expect(Session.restore(Session.load(file)).flows[0]).toMatchObject({ status: "cancelled", pendingCommand: true })
  await act(async () => {
    stale.resolve(listed)
    current.resolve(listed)
    await setImmediate()
  })
  await waitFor(() => Session.restore(Session.load(file)).flowCommands.length === 0)
  expect(starts).toBe(0)
  expect(bodies).toEqual([])
  expect(turns).toEqual([])
  await act(async () => {
    setup!.renderer.destroy()
  })
  await mount(file, 80, 24)
  expect(frame()).toContain("■ module")
  expect(Session.restore(Session.load(file)).flows).toHaveLength(1)
  expect(Session.restore(Session.load(file)).flows[0]!.status).toBe("cancelled")
  expect(starts).toBe(0)
  await command("/new")
  expect(frame()).not.toContain("Stop running work first")
  expect(frame()).not.toContain("/flow module a=1")
})

test("Summary stops unresolved discovery while Chat remains usable and cancellation survives reload before discovery", async () => {
  const stale = await remountUndiscovered()
  await command("/flow review Check math.js")
  const file = Session.list(cwd)[0]!.file
  await key("s", { ctrl: true })
  await key("DOWN")
  expect(frame()).toMatch(/x.*Stop/)
  await key("x")
  expect(Session.restore(Session.load(file)).flows[0]!.status).toBe("cancelled")
  await key("ESCAPE")
  await command("Explain this directory")
  await waitFor(() => turns.length === 1)
  const stoppedId = Session.restore(Session.load(file)).flows[0]!.id
  expect(() => turns[0]!.input.runtime!.delegate!({ id: stoppedId, title: "Other work", prompt: "Other work" }))
    .toThrow("Request id already belongs to a flow run")
  turns[0]!.gate.resolve({ _tag: "done", answer: "Directory answer" })
  await waitFor(() => records().some((record) => record.type === "outcome" && record.outcome._tag === "done"))
  expect(frame()).toContain("Explain this directory")
  const current = await remountUndiscovered(file)
  expect(frame()).toContain("■ review")
  await act(async () => {
    stale.resolve(listed)
    current.resolve(listed)
    await setImmediate()
  })
  await waitFor(() => Session.restore(Session.load(file)).flowCommands.length === 0)
  expect(bodies).toEqual([])
  expect(turns).toHaveLength(1)
  expect(Session.restore(Session.load(file)).flows[0]).toMatchObject({ status: "cancelled", pendingCommand: true })
})

test("dispatch parsing failure stays on its Chat card after toast expiry and session restoration", async () => {
  await command("/flow module {oops")
  const file = Session.list(cwd)[0]!.file
  await waitFor(() => Session.restore(Session.load(file)).flowCommands.length === 0)
  const failed = Session.restore(Session.load(file)).flows[0]!
  expect(failed).toMatchObject({ flow: "module", status: "failed", failure: "Invalid JSON" })
  await waitFor(() => frame().includes("Invalid JSON"))
  expect(frame()).toContain("✗ module")
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 4300))
  })
  await render()
  expect(frame()).toContain("Invalid JSON")
  await act(async () => {
    setup!.renderer.destroy()
  })
  await mount(file, 80, 24)
  expect(frame()).toContain("✗ module")
  expect(frame()).toContain("Invalid JSON")
  expect(Session.restore(Session.load(file)).flows[0]).toEqual(failed)
  expect(Session.restore(Session.load(file)).flowCommands).toEqual([])
  expect(bodies).toEqual([])
  expect(turns).toEqual([])
}, 10000)

test("a dispatch admission refusal persists its failed outcome before retiring discovery", async () => {
  await act(async () => {
    setup!.renderer.destroy()
  })
  flows = { ...flows, warm: async () => {}, loaded: async () => ({ flows: [], refused: [] }) }
  mkdirSync(join(cwd, "flows"), { recursive: true })
  await mount(undefined, 80, 24)
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
  await command("/flow module a=1")
  const file = Session.list(cwd)[0]!.file
  await waitFor(() => Session.restore(Session.load(file)).flowCommands.length === 0)
  const failed = Session.restore(Session.load(file)).flows[0]!
  expect(failed).toMatchObject({ status: "failed", failure: "Restart to load module." })
  await act(async () => {
    setup!.renderer.destroy()
  })
  await mount(file, 80, 24)
  expect(frame()).toContain("Restart to load module.")
  expect(frame()).toContain("✗ module")
  expect(Session.restore(Session.load(file)).flows[0]).toEqual(failed)
})
