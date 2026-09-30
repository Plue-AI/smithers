import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Schema } from "effect"
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import { FlowError, type Port, type Settled } from "../src/flows.ts"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"
import * as Theme from "../src/theme.ts"

// Actual App routing, native headless rendering and isolated session files.
// Execution and control-plane boundaries are explicit doubles, not providers.
let root = ""
let cwd = ""
let previousRoot: string | undefined
let previousTheme = Theme.activeTheme()
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let active: Session.Writer
let saved: Session.Writer
let savedBytes = ""
let turns: Array<
  { input: Host.TurnInput; done: ReturnType<typeof Promise.withResolvers<Host.Outcome>>; cancelled: number }
> = []
let launch: ReturnType<typeof Promise.withResolvers<string>>
let remote: ReturnType<typeof Promise.withResolvers<Settled>>
let starts = 0
let watches = 0
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
const command = async (text: string) => {
  await type(text)
  await key("RETURN")
}
const palette = async (verb: string) => {
  await key("k", { ctrl: true })
  await type(`/${verb}`)
  await key("RETURN")
}
const chooseSaved = async () => {
  await type("Saved target")
  await key("RETURN")
}
const checkpoint = async () => {
  await act(async () => {
    await setImmediate()
  })
  await render()
}
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!condition() && Date.now() < deadline) await checkpoint()
  if (!condition()) throw new Error("App boundary did not reach its expected public state")
}
const finish = async (index: number, answer = "Current work done") => {
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
const seed = (writer: Session.Writer, user: string, answer: string) => {
  writer.append({ type: "user", at: 100, text: user })
  writer.append({
    type: "event",
    at: 101,
    event: new AgentEvent.Resolved({
      eventType: "flows.harness.resolved.v1",
      message: ModelRequest.Message.assistant(answer)
    })
  })
  writer.append({ type: "outcome", at: 102, prompt: user, outcome: { _tag: "done", answer } })
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tui-app-sessions-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  previousTheme = Theme.activeTheme()
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  turns = []
  launch = Promise.withResolvers<string>()
  remote = Promise.withResolvers<Settled>()
  starts = 0
  watches = 0
  saved = Session.create(cwd)
  saved.append({ type: "name", name: "Saved target" })
  seed(saved, "Saved question", "Saved answer")
  savedBytes = readFileSync(saved.file, "utf8")
  active = Session.create(cwd)
  seed(active, "Earlier question", "Earlier answer")
  const host: Host.Host = {
    cwd,
    judged: false,
    dispose: async () => {},
    run: (input) => {
      const turn = { input, done: Promise.withResolvers<Host.Outcome>(), cancelled: 0 }
      turns.push(turn)
      return {
        done: turn.done.promise,
        cancel: () => {
          turn.cancelled++
          turn.done.resolve({ _tag: "cancelled" })
        }
      }
    }
  }
  const flows: Port = {
    discover: async () => [{
      name: "review",
      description: "Review",
      modelInvocable: true,
      kind: "module",
      flows: [],
      capabilities: [],
      path: join(cwd, "flows/review/flow.ts")
    }],
    input: async () => Schema.Struct({}),
    body: async () => {
      throw new FlowError("refused", "Module flow")
    },
    plan: async (_flow, input) => ({ raw: input }),
    start: () => {
      starts++
      return launch.promise
    },
    resume: async (runId) => ({ runId }),
    watch: () => {
      watches++
      return { done: remote.promise, close: () => {} }
    },
    events: async () => [],
    cancel: async () => {},
    dispose: async () => {}
  }
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        seat="replay:chat"
        workerSeat="replay:worker"
        models={[{ seat: "replay:chat", label: "Replay", provider: "Fixture" }]}
        contextWindow={() => 10000}
        resume={active.file}
        flows={flows}
      />,
      { width: 140, height: 35, exitOnCtrlC: false }
    )
    await setImmediate()
  })
  await render()
})
afterEach(async () => {
  try {
    await act(async () => {
      launch.resolve("remote-review")
      remote.resolve({ kind: "cancelled" })
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

const combinations = ["chat", "worker", "flow"].flatMap((work) =>
  ["new", "resume", "fork"].map((verb) => ({ work, verb }))
)
test.each(combinations)(
  "/$verb refuses unsettled $work without losing session or draft, then accepts real completion",
  async ({ work, verb }) => {
    if (work === "flow") {
      await command("/flow review")
      await waitFor(() => starts === 1)
    } else {
      await command("Current work")
      if (work === "worker") {
        await act(async () => {
          turns[0]!.input.runtime!.delegate!({ id: "review", title: "Worker review", prompt: "Review one file" })
          await setImmediate()
        })
        await finish(0)
      }
    }
    if (work === "chat") {
      await type("Queued follow-up")
      await key("RETURN", { meta: true })
    }
    const queued = () => Session.load(active.file).filter((record) => record.type === "queued")
    expect(queued().map((record) => ({ text: record.prompt.text, scope: record.prompt.scope })))
      .toEqual(work === "chat" ? [{ text: "Queued follow-up", scope: "chat" }] : [])
    const capturedQueue = queued()
    await type("Unsent draft")
    const refuse = async () => {
      await palette(verb)
      if (verb === "resume") await chooseSaved()
      expect(frame()).toContain("Stop running work first")
      expect(frame()).toContain("Unsent draft")
      // Session.create is lazy: an unchanged file listing alone cannot detect
      // a rejected command silently adopting an empty conversation.
      expect(frame()).toContain("Earlier question")
      expect(Session.list(cwd).map((session) => session.file).sort()).toEqual([active.file, saved.file].sort())
      expect(readFileSync(saved.file, "utf8")).toBe(savedBytes)
      expect(queued()).toEqual(capturedQueue)
    }
    await refuse()
    if (work === "flow") {
      expect(watches).toBe(0)
      await act(async () => {
        launch.resolve("remote-review")
        await setImmediate()
      })
      await waitFor(() => watches === 1)
      // A launch receipt still must not authorize a session switch.
      await refuse()
      await act(async () => {
        remote.resolve({ kind: "done", answer: "Flow done" })
        await setImmediate()
      })
      await waitFor(() =>
        Session.load(active.file).filter((record) => record.type === "flow").at(-1)?.run.status === "done"
      )
    } else {
      await finish(work === "worker" ? 1 : 0)
      if (work === "chat") {
        expect(turns[1]!.input.prompt).toBe("Queued follow-up")
        await refuse()
        await finish(1, "Queued follow-up done")
        expect(Session.load(active.file).filter((record) => record.type === "dequeued").map((record) => record.reason))
          .toEqual(["started"])
      }
    }
    if (work === "flow") {
      expect(Session.load(active.file).filter((record) => record.type === "flow").at(-1)?.run.status).toBe("done")
    } else {
      expect(
        Session.load(active.file).filter((record) => record.type === "outcome").map((record) => ({
          prompt: record.prompt,
          outcome: record.outcome._tag
        }))
      ).toContainEqual({ prompt: "Current work", outcome: "done" })
      if (work === "worker") {
        expect(Session.load(active.file).filter((record) => record.type === "tab").at(-1)?.tab.status).toBe("done")
      }
    }
    const admitted = turns.length
    await palette(verb)
    if (verb === "resume") await chooseSaved()
    if (verb === "fork") {
      await type("Earlier question")
      await key("RETURN")
    }
    expect(turns).toHaveLength(admitted)
    expect(frame()).not.toContain("Stop running work first")
    if (verb === "fork") {
      expect(frame()).toContain("Earlier question")
      await type(" revised")
    } else {
      expect(frame()).toContain("Unsent draft")
      await type(" continued")
    }
    await key("RETURN")
    const next = turns.at(-1)!.input
    expect(next.prompt).toBe(verb === "fork" ? "Earlier question revised" : "Unsent draft continued")
    expect(next.seat).toBe("replay:chat")
    expect(next.history).toEqual(
      verb === "resume" ? [{ kind: "exchange", user: "Saved question", answer: "Saved answer" }] : []
    )
    if (verb === "resume") {
      expect(Session.load(saved.file).filter((record) => record.type === "user").map((record) => record.text))
        .toEqual(["Saved question", "Unsent draft continued"])
    } else {
      const other = Session.list(cwd).filter((session) => session.file !== active.file && session.file !== saved.file)
      expect(other).toHaveLength(1)
      expect(Session.load(other[0]!.file).filter((record) => record.type === "user").map((record) => record.text))
        .toEqual([next.prompt])
      expect(readFileSync(saved.file, "utf8")).toBe(savedBytes)
    }
  },
  15000
)

test("cancelling the resume picker keeps its original conversation and unsent draft", async () => {
  await type("Kept draft")
  await palette("resume")
  await type("Saved target")
  await key("ESCAPE")
  await waitFor(() => !frame().includes("Resume session"))
  expect(frame()).toContain("Kept draft")
  expect(frame()).not.toContain("Resume session")
  expect(readFileSync(saved.file, "utf8")).toBe(savedBytes)
  await key("RETURN")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("Kept draft")
  expect(turns[0]!.input.history).toEqual([{ kind: "exchange", user: "Earlier question", answer: "Earlier answer" }])
  expect(Session.list(cwd)).toHaveLength(2)
})

test("an empty resume search cannot select a missing conversation or consume the current draft", async () => {
  await type("Keep me")
  await palette("resume")
  await type("zzzz-no-such-conversation")
  await key("RETURN")
  expect(turns).toHaveLength(0)
  expect(Session.list(cwd)).toHaveLength(2)
  expect(readFileSync(saved.file, "utf8")).toBe(savedBytes)
  await key("ESCAPE")
  await waitFor(() => !frame().includes("Resume session"))
  expect(frame()).not.toContain("Resume session")
  await key("RETURN")
  expect(turns).toHaveLength(1)
  expect(turns[0]!.input.prompt).toBe("Keep me")
  expect(turns[0]!.input.history).toEqual([{ kind: "exchange", user: "Earlier question", answer: "Earlier answer" }])
})

test("a saved conversation disappearing after the picker opens refuses without replacing the active session", async () => {
  await type("Retained draft")
  await palette("resume")
  await type("Saved target")
  expect(frame()).toContain("Saved target")
  rmSync(saved.file)
  await key("RETURN")
  expect(frame()).toContain("That conversation could not be opened.")
  expect(frame()).toContain("Retained draft")
  expect(turns).toHaveLength(0)
  await type(" continued")
  await key("RETURN")
  expect(turns[0]!.input.prompt).toBe("Retained draft continued")
  expect(turns[0]!.input.history).toEqual([{ kind: "exchange", user: "Earlier question", answer: "Earlier answer" }])
  expect(Session.list(cwd).map((session) => session.file)).toEqual([active.file])
  expect(Session.load(active.file).filter((record) => record.type === "user").map((record) => record.text))
    .toEqual(["Earlier question", "Retained draft continued"])
})

test("inspecting and cancelling a fork selection does not create a conversation or replace the draft", async () => {
  const original = readFileSync(active.file, "utf8")
  await type("Original draft")
  await palette("fork")
  expect(frame()).toContain("Earlier question")
  expect(turns).toHaveLength(0)
  expect(readFileSync(active.file, "utf8")).toBe(original)
  await key("ESCAPE")
  await waitFor(() => !frame().includes("Fork from message"))
  await type(" kept")
  await key("RETURN")
  expect(turns[0]!.input.prompt).toBe("Original draft kept")
  expect(turns[0]!.input.history).toEqual([{ kind: "exchange", user: "Earlier question", answer: "Earlier answer" }])
  expect(Session.list(cwd)).toHaveLength(2)
})
