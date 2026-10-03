import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act } from "react"
import { App, type AppProps } from "../src/app.tsx"
import { FlowError, type Port, type Settled } from "../src/flows.ts"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"

// Headless component units: explicit Host boundary doubles and real session
// storage. No providers execute. Session-root environment requires serial tests.
interface OwnedTurn {
  readonly input: Host.TurnInput
  readonly history: Host.TurnInput["history"]
  readonly admittedRecords: Session.Record[]
  readonly gate: ReturnType<typeof Promise.withResolvers<Host.Outcome>>
  settled: boolean
  cancels: number
}
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let root = ""
let cwd = ""
let previousSessionRoot: string | undefined
let turns: OwnedTurn[] = []
let host: Host.Host
let releaseFlow: (() => void) | undefined
const models = [{ seat: "replay:test", label: "Replay", provider: "Fixture" }]
const records = () => Session.list(cwd).flatMap((summary) => Session.load(summary.file))
const draw = async () => {
  await setup!.renderOnce()
  return setup!.captureCharFrame()
}
const waitFor = async (condition: () => boolean) => {
  const deadline = Date.now() + 5000
  while (!condition() && Date.now() < deadline) {
    await act(async () => {
      await setImmediate()
    })
    await setup!.renderOnce()
  }
  if (!condition()) throw new Error("The public App state did not settle")
}
const mount = async (props: Partial<AppProps> = {}) => {
  await act(async () => {
    setup = await testRender(
      <App host={host} seat="replay:test" models={models} contextWindow={() => 10000} {...props} />,
      { width: 100, height: 30 }
    )
    await setImmediate()
  })
  await setup!.renderOnce()
}
const type = async (text: string) => {
  await act(async () => {
    await setup!.mockInput.typeText(text)
  })
  await setup!.renderOnce()
}
const enter = async () => {
  await act(async () => {
    await setup!.mockInput.pressKeys(["RETURN"])
  })
  await setup!.renderOnce()
}
const key = async (name: string, modifiers: { ctrl?: boolean; meta?: boolean } = {}) => {
  await act(async () => {
    setup!.mockInput.pressKey(name, modifiers)
  })
  await setup!.renderOnce()
}
const settle = async (index: number, outcome: Host.Outcome) => {
  const turn = turns[index]!
  await act(async () => {
    if (outcome._tag === "done") {
      turn.input.onEvent(
        new AgentEvent.Resolved({
          eventType: "flows.harness.resolved.v1",
          message: ModelRequest.Message.assistant(outcome.answer)
        })
      )
    }
    turn.settled = true
    turn.gate.resolve(outcome)
    await turn.gate.promise
    await setImmediate()
  })
  await setup!.renderOnce()
}
const controlledFlow = (schema: Schema.Top) => {
  const launch = Promise.withResolvers<string>()
  const remote = Promise.withResolvers<Settled>()
  const starts: unknown[] = []
  const watches: string[] = []
  releaseFlow = () => {
    launch.resolve("remote-review")
    remote.resolve({ kind: "cancelled" })
  }
  const port: Port = {
    discover: async () => [{
      name: "review",
      description: "Review",
      modelInvocable: true,
      kind: "module",
      flows: [],
      capabilities: [],
      path: join(cwd, "flows/review/flow.ts")
    }],
    input: async () => schema,
    body: async () => {
      throw new FlowError("refused", "Module flow")
    },
    plan: async (_flow, input) => ({ raw: input }),
    start: (card) => {
      starts.push(card.raw)
      return launch.promise
    },
    resume: async (runId) => ({ runId }),
    watch: (runId) => {
      watches.push(runId)
      return { done: remote.promise, close: () => {} }
    },
    events: async () => [],
    cancel: async () => {},
    dispose: async () => {}
  }
  return { port, launch, remote, starts, watches }
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tui-app-unit-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousSessionRoot = process.env.SMITHERS_TUI_SESSION_DIR
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  turns = []
  releaseFlow = undefined
  host = {
    cwd,
    judged: false,
    run: (input) => {
      const turn: OwnedTurn = {
        input,
        history: structuredClone(input.history),
        admittedRecords: records(),
        gate: Promise.withResolvers<Host.Outcome>(),
        settled: false,
        cancels: 0
      }
      turns.push(turn)
      return {
        done: turn.gate.promise,
        cancel: () => {
          turn.cancels++
          turn.settled = true
          turn.gate.resolve({ _tag: "cancelled" })
        }
      }
    },
    dispose: async () => {}
  }
})
afterEach(async () => {
  try {
    // Settle fixture-owned gates so failure cannot retain detached work. This
    // is harness cleanup, not evidence that App's quit path disposes its host.
    await act(async () => {
      releaseFlow?.()
      for (const turn of turns) {
        if (!turn.settled) {
          turn.settled = true
          turn.gate.resolve({ _tag: "cancelled" })
        }
      }
      await Promise.all(turns.map((turn) => turn.gate.promise))
      await setImmediate()
      setup?.renderer.destroy()
    })
  } finally {
    setup = undefined
    if (previousSessionRoot === undefined) delete process.env.SMITHERS_TUI_SESSION_DIR
    else process.env.SMITHERS_TUI_SESSION_DIR = previousSessionRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test("new conversation draws the composer and blank submission neither launches nor persists", async () => {
  await mount()
  expect(await draw()).toContain("Ask Smithers to change this repository")
  await enter()
  expect(turns).toHaveLength(0)
  expect(Session.list(cwd)).toEqual([])
})

test("the home screen names ? as the keys, and only ? opens them", async () => {
  await mount()
  const home = await draw()
  expect(home).toContain("/ commands  @ files  ! shell  ? keys")
  expect(home).not.toContain("ctrl+o")
  await key("o", { ctrl: true })
  expect(await draw()).not.toContain("Pick model")
  await key("?")
  await waitFor(() => setup!.captureCharFrame().includes("Pick model"))
  expect(turns).toHaveLength(0)
})

test("Ctrl+K finds undo with its key and says so when there is nothing to undo", async () => {
  await mount()
  await key("k", { ctrl: true })
  await type("undo")
  const listed = await draw()
  expect(listed).toMatch(/Undo…\s+alt\+u/)
  expect(listed).toContain("enter Choose  esc Back")
  await enter()
  await waitFor(() => setup!.captureCharFrame().includes("Nothing to undo"))
  expect(turns).toHaveLength(0)
})

test("Ctrl+K Run Claude Code puts the prompt line in the composer and parks the draft", async () => {
  await mount()
  await type("Draft kept")
  await key("k", { ctrl: true })
  await type("run claude")
  await enter()
  await waitFor(() => setup!.captureCharFrame().includes("/claude"))
  expect(setup!.captureCharFrame()).not.toContain("Draft kept")
  expect(turns).toHaveLength(0)
})

test("a mistyped command stays in the composer with the nearest command and reaches no one", async () => {
  await mount()
  await type("/flwo")
  expect(await draw()).toContain("No matching commands")
  await enter()
  const frame = await draw()
  expect(frame).toContain("Unknown command /flwo. Try /flow.")
  expect(frame).not.toContain("No matching commands")
  expect(frame).toMatch(/┃\s+\/flwo\s/)
  expect(turns).toHaveLength(0)
  expect(Session.list(cwd)).toEqual([])
  for (let at = 0; at < "/flwo".length; at++) await key("BACKSPACE")
  await type("/hotkeys")
  await key("RETURN", { meta: true })
  expect(await draw()).toContain("Unknown command /hotkeys")
  expect(turns).toHaveLength(0)
})

test("prompt is persisted while its turn remains unresolved and composer still accepts steering", async () => {
  await mount()
  await type("Fix the build")
  await enter()
  expect(turns).toHaveLength(1)
  expect(turns[0]?.input.prompt).toBe("Fix the build")
  expect(turns[0]?.history).toEqual([])
  expect(turns[0]?.admittedRecords.filter((record) => record.type === "user").map((record) => record.text)).toEqual([
    "Fix the build"
  ])
  expect(turns[0]?.settled).toBe(false)
  expect(records().filter((record) => record.type === "user")).toEqual([
    expect.objectContaining({ type: "user", text: "Fix the build" })
  ])
  expect(await draw()).toContain("Steer, or alt+enter to queue")
  await type("Check types too")
  expect(await draw()).toContain("Check types too")
  await enter()
  expect(turns).toHaveLength(1)
  expect(turns[0]?.settled).toBe(false)
  expect(
    records().filter((record) => record.type === "user").map((record) => ({
      text: record.text,
      steered: record.steered ?? false
    }))
  ).toEqual([{ text: "Fix the build", steered: false }, { text: "Check types too", steered: true }])
})

test("failed turn remains visible and the next submitted prompt can recover", async () => {
  await mount()
  await type("Run checks")
  await enter()
  await settle(0, { _tag: "failed", message: "Checks refused", detail: "Fixture failure" })
  expect(await draw()).toContain("✗ failed: Worker stopped unexpectedly")
  expect(records().filter((record) => record.type === "outcome").map((record) => record.outcome._tag)).toEqual([
    "failed"
  ])
  await type("Try again")
  await enter()
  expect(turns.map((turn) => turn.input.prompt)).toEqual(["Run checks", "Try again"])
  await settle(1, { _tag: "done", answer: "Checks passed" })
  await waitFor(() => setup!.captureCharFrame().includes("Checks passed"))
  expect(await draw()).toContain("Checks passed")
  expect(records().filter((record) => record.type === "outcome").map((record) => record.outcome._tag)).toEqual([
    "failed",
    "done"
  ])
})

test("distinct admissions of identical prompts persist separately and start in FIFO order", async () => {
  await mount()
  await type("First")
  await enter()
  for (const prompt of ["Second", "Second", "Third"]) {
    await type(prompt)
    await key("RETURN", { meta: true })
  }
  expect(turns).toHaveLength(1)
  expect(turns[0]?.settled).toBe(false)
  const queued = records().filter((record) => record.type === "queued")
  expect(queued.map((record) => ({ text: record.prompt.text, scope: record.prompt.scope }))).toEqual([
    { text: "Second", scope: "chat" },
    { text: "Second", scope: "chat" },
    { text: "Third", scope: "chat" }
  ])
  expect(new Set(queued.map((record) => record.prompt.id)).size).toBe(3)
  expect(await draw()).toContain("Follow-up:")
  await settle(0, { _tag: "done", answer: "First done" })
  expect(turns.map((turn) => turn.input.prompt)).toEqual(["First", "Second"])
  expect(turns[1]?.history).toEqual([{ kind: "exchange", user: "First", answer: "First done" }])
  expect(
    turns[1]?.admittedRecords.filter((record) => record.type === "dequeued").map((record) => ({
      id: record.id,
      reason: record.reason
    }))
  ).toEqual([{ id: queued[0]!.prompt.id, reason: "started" }])
  expect(turns[1]?.admittedRecords.filter((record) => record.type === "user").map((record) => record.text)).toEqual([
    "First",
    "Second"
  ])
  await settle(1, { _tag: "done", answer: "Second done" })
  expect(turns.map((turn) => turn.input.prompt)).toEqual(["First", "Second", "Second"])
  await settle(2, { _tag: "done", answer: "Repeated second done" })
  expect(turns.map((turn) => turn.input.prompt)).toEqual(["First", "Second", "Second", "Third"])
  expect(
    records().filter((record) => record.type === "dequeued").map((record) => ({ id: record.id, reason: record.reason }))
  ).toEqual(queued.map((record) => ({ id: record.prompt.id, reason: "started" })))
})

test("resuming keeps durable history without replaying a completed prompt", async () => {
  const saved = Session.create(cwd)
  saved.append({ type: "user", at: 100, text: "Saved request" })
  saved.append({
    type: "event",
    at: 101,
    event: new AgentEvent.Resolved({
      eventType: "flows.harness.resolved.v1",
      message: ModelRequest.Message.assistant("Saved answer")
    })
  })
  saved.append({ type: "outcome", at: 102, prompt: "Saved request", outcome: { _tag: "done", answer: "Saved answer" } })
  await mount({ resume: saved.file })
  await waitFor(() => setup!.captureCharFrame().includes("Saved answer"))
  expect(turns).toHaveLength(0)
  await type("Continue")
  await enter()
  expect(turns[0]?.history).toEqual([{ kind: "exchange", user: "Saved request", answer: "Saved answer" }])
  expect(Session.list(cwd).map((summary) => summary.file)).toEqual([saved.file])
})

test("new conversation is refused while work runs and succeeds after completion", async () => {
  await mount()
  await type("Work")
  await enter()
  await type("/new")
  await enter()
  expect(await draw()).toContain("Stop running work first")
  expect(turns).toHaveLength(1)
  const previousFile = Session.list(cwd)[0]!.file
  await settle(0, { _tag: "done", answer: "Done" })
  await type("/new")
  await enter()
  expect(await draw()).not.toContain("Stop running work first")
  await type("Fresh request")
  await enter()
  expect(turns[1]?.history).toEqual([])
  expect(Session.list(cwd)).toHaveLength(2)
  expect(
    Session.list(cwd).filter((summary) => summary.file !== previousFile).flatMap((summary) =>
      Session.load(summary.file)
    ).filter((record) => record.type === "user").map((record) => record.text)
  ).toEqual(["Fresh request"])
})

test("model picker closes back to the untouched draft and chosen seat reaches the next turn", async () => {
  await mount({ models: [...models, { seat: "replay:other", label: "Other", provider: "Fixture" }] })
  await type("Keep this draft")
  await key("l", { ctrl: true })
  expect(await draw()).toContain("Select model")
  await key("ARROW_DOWN")
  await enter()
  expect(await draw()).not.toContain("Select model")
  expect(await draw()).toContain("Keep this draft")
  await enter()
  expect(turns[0]?.input.seat).toBe("replay:other")
  expect(turns[0]?.input.prompt).toBe("Keep this draft")
})

test("background flow launch acknowledges durably while both launch and remote completion remain unresolved", async () => {
  const { port, launch, remote, starts, watches } = controlledFlow(Schema.Struct({}))
  await mount({ flows: port })
  await type("/flow review")
  await enter()
  await waitFor(() => starts.length === 1)
  expect(starts).toEqual([{}])
  expect(watches).toEqual([])
  const flowRecords = () => records().filter((record) => record.type === "flow").map((record) => record.run)
  expect(flowRecords().map((run) => ({ status: run.status, pendingCommand: run.pendingCommand }))).toEqual([
    { status: "requested", pendingCommand: true },
    { status: "requested", pendingCommand: undefined }
  ])
  await type("Chat during launch")
  expect(await draw()).toContain("Chat during launch")
  await enter()
  expect(turns[0]?.input.prompt).toBe("Chat during launch")
  expect(turns[0]?.settled).toBe(false)
  expect(watches).toEqual([])
  await act(async () => {
    launch.resolve("remote-review")
    await setImmediate()
  })
  await waitFor(() => watches.length === 1)
  expect(watches).toEqual(["remote-review"])
  expect(flowRecords().at(-1)).toMatchObject({ status: "running", runId: "remote-review" })
  await type("Chat during execution")
  await enter()
  expect(
    records().flatMap((record) =>
      record.type === "user"
        ? [record.text]
        : record.type === "run" && record.request !== undefined
        ? [record.request]
        : []
    )
  ).toEqual([
    "/flow review",
    "Chat during launch",
    "Chat during execution"
  ])
  expect(flowRecords().some((run) => run.status === "done")).toBe(false)
  await act(async () => {
    remote.resolve({ kind: "done", answer: "Review complete" })
    await setImmediate()
  })
  await waitFor(() => flowRecords().at(-1)?.status === "done")
  expect(flowRecords().at(-1)).toMatchObject({ status: "done", runId: "remote-review", answer: "Review complete" })
})

test.each(["/flow", "smithers.run", "extension key"] as const)(
  "%s settles through the same host Chat card",
  async (entry) => {
    const { port, launch, remote, starts, watches } = controlledFlow(Schema.Struct({}))
    await mount({ flows: port })
    if (entry === "/flow") {
      await type("/flow review")
      await enter()
    } else {
      await type("Count the result")
      await enter()
      if (entry === "smithers.run") {
        await act(async () => {
          turns[0]!.input.runtime!.flows!.run({ id: "owned", flow: "review", input: {} })
          await setImmediate()
        })
      } else {
        await act(async () => {
          turns[0]!.input.runtime!.publish({
            kind: "key",
            key: {
              id: "count",
              key: "alt+z",
              label: "Count",
              action: { kind: "flow", flow: "review", input: {} }
            }
          })
          await setImmediate()
        })
        await key("z", { meta: true })
      }
    }
    await waitFor(() => starts.length === 1)
    expect(await draw()).toContain("review · requested")
    await act(async () => {
      launch.resolve("remote-review")
      await setImmediate()
    })
    await waitFor(() => watches.length === 1)
    await act(async () => {
      remote.resolve({ kind: "done", answer: "5" })
      await setImmediate()
    })
    await waitFor(() => setup!.captureCharFrame().includes("→ 5"))
    const frame = await draw()
    expect(frame.match(/review ·/g)).toHaveLength(1)
    expect(frame).toContain("→ 5")
    expect(frame).not.toContain("◉")
    expect(records().filter((record) => record.type === "card" || record.type === "panel")).toEqual([])
    expect(records().filter((record) => record.type === "flow").at(-1)?.run.answer).toBe("5")
  }
)

test("Escape cancels the owned turn and restores queued prompts instead of launching them", async () => {
  await mount()
  await type("Running")
  await enter()
  await type("Queued next")
  await key("RETURN", { meta: true })
  await key("ESCAPE")
  await waitFor(() => records().some((record) => record.type === "outcome"))
  expect(turns[0]?.cancels).toBe(1)
  expect(turns).toHaveLength(1)
  expect(records().filter((record) => record.type === "outcome").map((record) => record.outcome._tag)).toEqual([
    "cancelled"
  ])
  expect(records().filter((record) => record.type === "dequeued").map((record) => record.reason)).toEqual(["restored"])
  expect(await draw()).toContain("Queued next")
  expect(await draw()).not.toContain("Follow-up:")
  await enter()
  expect(turns.map((turn) => turn.input.prompt)).toEqual(["Running", "Queued next"])
})

test("agent repeated flow request ID is deduplicated and changed input is refused", async () => {
  const { port, starts } = controlledFlow(Schema.Struct({}))
  await mount({ flows: port })
  await type("Delegate review")
  await enter()
  const flows = turns[0]!.input.runtime!.flows!
  await act(async () => {
    expect(flows.run({ id: "review-owned", flow: "review", input: {} })).toEqual({
      id: "review-owned",
      status: "requested"
    })
    expect(flows.run({ id: "review-owned", flow: "review", input: {} })).toEqual({
      id: "review-owned",
      status: "requested"
    })
    expect(() => flows.run({ id: "review-owned", flow: "review", input: { changed: true } })).toThrow("another request")
    await setImmediate()
  })
  await waitFor(() => starts.length === 1)
  expect(
    records().filter((record) => record.type === "flow").map((record) => ({
      id: record.run.id,
      input: record.run.input,
      status: record.run.status
    }))
  ).toEqual([{ id: "review-owned", input: {}, status: "requested" }])
  expect(starts).toEqual([{}])
  expect(turns[0]?.settled).toBe(false)
})

test.each(["worker", "flow"] as const)(
  "Ctrl+S from a failed %s tab opens Failed and keeps that row in the right pane",
  async (kind) => {
    const { port, launch, remote, starts, watches } = controlledFlow(Schema.Struct({}))
    await mount({ flows: port })
    await type("Coordinate review")
    await enter()
    await act(async () => {
      const runtime = turns[0]!.input.runtime!
      runtime.delegate!({ id: "visible", title: "Visible work", prompt: "Keep working" })
      if (kind === "worker") {
        runtime.delegate!({ id: "target", title: "Target review", prompt: "Review target" })
      } else {
        runtime.flows!.run({ id: "target", flow: "review", input: {} })
      }
      await setImmediate()
    })
    if (kind === "worker") {
      await settle(2, { _tag: "failed", message: "Target refused", detail: "Fixture refusal" })
    } else {
      await waitFor(() => starts.length === 1)
      await act(async () => {
        launch.resolve("remote-review")
        await setImmediate()
      })
      await waitFor(() => watches.length === 1)
      await act(async () => {
        remote.resolve({ kind: "failed", message: "Target refused" })
        await setImmediate()
      })
      await waitFor(() => records().some((record) => record.type === "flow" && record.run.status === "failed"))
    }
    await settle(0, { _tag: "done", answer: "Requested" })
    // A failed run leaves the strip: Summary -> Failed -> failed target (worker or flow).
    await key("s", { ctrl: true })
    expect(await draw()).toContain("Failed 1 ›")
    await key("ARROW_DOWN")
    await key("ARROW_DOWN")
    await key("RETURN")
    await key("ARROW_DOWN")
    await key("RETURN")
    const tabFrame = await draw()
    expect(tabFrame).toContain(kind === "worker" ? "Continue Target review" : "Target refused")
    await key("s", { ctrl: true })
    const summary = await draw()
    expect(summary).toContain("Failed 1")
    expect(summary).not.toContain("Failed 1 ›")
    // The left list also contains Visible work, so inspect only the right
    // pane below the tab strip. The old fallback displays Visible work here.
    const lines = summary.split("\n")
    const top = lines.findIndex((line) => line.includes("┌─tree"))
    const header = lines[top]!
    const rightStart = header.indexOf("┌", header.indexOf("┌") + 1)
    const bottom = lines.findIndex((line, index) => index > top && line.slice(rightStart).startsWith("└"))
    const rightPane = lines.slice(top, bottom + 1).map((line) => line.slice(rightStart)).join("\n")
    expect(rightPane).toContain(kind === "worker" ? "Target review" : "review")
    expect(rightPane).not.toContain("Visible work")
    // The same shortcut returns to the failed tab it came from.
    await key("s", { ctrl: true })
    expect(await draw()).toContain(kind === "worker" ? "Continue Target review" : "Target refused")
    expect(await draw()).not.toContain("Failed 1")
  }
)

test("Ctrl+S from a successful worker selects it while unrelated Failed rows stay collapsed", async () => {
  await mount()
  await type("Coordinate review")
  await enter()
  await act(async () => {
    const runtime = turns[0]!.input.runtime!
    runtime.delegate!({ id: "target", title: "Target review", prompt: "Review target" })
    runtime.delegate!({ id: "failed", title: "Other failure", prompt: "Review another file" })
    await setImmediate()
  })
  await settle(1, { _tag: "done", answer: "Target completed" })
  await settle(2, { _tag: "failed", message: "Other refused", detail: "Fixture refusal" })
  await settle(0, { _tag: "done", answer: "Requested" })
  // A finished worker leaves the strip: Summary -> Done -> the worker.
  await key("s", { ctrl: true })
  await key("ARROW_DOWN")
  await key("ARROW_DOWN")
  await key("RETURN")
  expect(await draw()).toContain("Continue Target review")
  await key("s", { ctrl: true })
  expect(await draw()).toContain("Failed 1 ›")
  expect(await draw()).toContain("┌─Target review")
  expect(await draw()).not.toContain("┌─Other failure")
})

test("required flow input parks in a visible form and only valid submission reaches launch", async () => {
  const { port, starts } = controlledFlow(Schema.Struct({ title: Schema.String.check(Schema.isMinLength(1)) }))
  await mount({ flows: port })
  await type("/flow review")
  await enter()
  await waitFor(() => records().some((record) => record.type === "flow" && record.run.status === "input"))
  expect(await draw()).toContain("Title")
  expect(starts).toEqual([])
  await enter()
  expect(starts).toEqual([])
  await type("Review the build")
  await enter()
  await waitFor(() => starts.length === 1)
  expect(starts).toEqual([{ title: "Review the build" }])
  expect(turns).toHaveLength(0)
  expect(
    records().filter((record) => record.type === "flow").map((record) => ({
      status: record.run.status,
      pendingCommand: record.run.pendingCommand
    }))
  ).toEqual([
    { status: "requested", pendingCommand: true },
    { status: "requested", pendingCommand: undefined },
    { status: "input", pendingCommand: undefined },
    { status: "requested", pendingCommand: undefined }
  ])
})

test("steering is delivered through the public boundary and consumed messages do not launch another turn", async () => {
  await mount()
  await type("Initial request")
  await enter()
  await type("Include tests")
  await enter()
  const source = turns[0]!.input.steering!
  const drain = await Effect.runPromise(source.drain({ boundary: "cell-1", wouldIdle: false }))
  expect(drain.inserts).toEqual([ModelRequest.Message.user("Include tests")])
  expect(drain.duplicate).toBe(false)
  expect((await Effect.runPromise(source.drain({ boundary: "cell-1", wouldIdle: false }))).duplicate).toBe(true)
  await act(async () => {
    turns[0]!.input.onEvent(
      new AgentEvent.SteeringDrained({ eventType: "flows.harness.steering-drained.v1", messages: drain.inserts })
    )
  })
  await settle(0, { _tag: "done", answer: "Finished including tests" })
  expect(turns).toHaveLength(1)
  await type("Next request")
  await enter()
  expect(turns[1]?.history).toEqual([{
    kind: "exchange",
    user: "Initial request\n\nInclude tests",
    answer: "Finished including tests"
  }])
  expect(records().filter((record) => record.type === "event" && record.event._tag === "steering-drained"))
    .toHaveLength(1)
})

test("undelivered steering is recovered before queued follow-ups when the original turn completes", async () => {
  await mount()
  await type("Original")
  await enter()
  await type("Still needed")
  await enter()
  await type("Queued later")
  await key("RETURN", { meta: true })
  await settle(0, { _tag: "done", answer: "Original done" })
  expect(turns.map((turn) => turn.input.prompt)).toEqual(["Original", "Still needed"])
  expect(records().filter((record) => record.type === "dequeued")).toEqual([])
  await settle(1, { _tag: "done", answer: "Recovered done" })
  expect(turns.map((turn) => turn.input.prompt)).toEqual(["Original", "Still needed", "Queued later"])
  expect(records().filter((record) => record.type === "dequeued").map((record) => record.reason)).toEqual(["started"])
})

test.each([
  {
    outcome: { kind: "failed", message: "Check exited 7" } satisfies Settled,
    status: "failed",
    failure: "Check exited 7."
  },
  {
    outcome: { kind: "failed", message: "Check exited 7: secret remote diagnostic" } satisfies Settled,
    status: "failed",
    failure: "The flow failed."
  },
  { outcome: { kind: "cancelled" } satisfies Settled, status: "cancelled" }
])(
  "remote $status receipt settles the flow without manufacturing a chat completion",
  async ({ outcome, status, failure }) => {
    const { port, launch, remote, watches } = controlledFlow(Schema.Struct({}))
    await mount({ flows: port })
    await type("/flow review")
    await enter()
    await act(async () => {
      launch.resolve("remote-review")
      await setImmediate()
    })
    await waitFor(() => watches.length === 1)
    await act(async () => {
      remote.resolve(outcome)
      await setImmediate()
    })
    await waitFor(() => records().some((record) => record.type === "flow" && record.run.status === status))
    const last = records().filter((record) => record.type === "flow").at(-1)!
    expect(last.run).toMatchObject({ status, runId: "remote-review" })
    if (outcome.kind === "failed") {
      expect(last.run.message).toBe(outcome.message)
      expect(last.run.failure).toBe(failure)
      await waitFor(() => setup!.captureCharFrame().includes(failure!))
      const frame = await draw()
      expect(frame).toContain("✗ review")
      expect(frame).toContain(failure!)
      if (outcome.message.includes("secret")) expect(frame).not.toContain(outcome.message)
      expect(frame.match(/review ·/g)).toHaveLength(1)
    } else {
      expect(last.run.failure).toBeUndefined()
      expect(await draw()).not.toContain("The flow failed.")
    }
    expect(last.run.answer).toBeUndefined()
    expect(records().filter((record) => record.type === "outcome")).toEqual([])
    await type("Chat after remote settlement")
    await enter()
    expect(turns[0]?.input.prompt).toBe("Chat after remote settlement")
  }
)

test.each([[80, 24], [110, 32]])(
  "Enter opens a visible settlement when eight notices overflow Chat at %s×%s",
  async (width, height) => {
    const gates = Array.from({ length: 8 }, () => Promise.withResolvers<Settled>())
    const names = gates.map((_, index) => `flow${index}`)
    const watched: string[] = []
    releaseFlow = () => gates.forEach((gate) => gate.resolve({ kind: "cancelled" }))
    const port: Port = {
      discover: async () =>
        names.map((name) => ({
          name,
          description: name,
          modelInvocable: true,
          kind: "module" as const,
          flows: [],
          capabilities: [],
          path: join(cwd, `flows/${name}/flow.ts`)
        })),
      input: async () => Schema.Struct({}),
      body: async () => {
        throw new FlowError("refused", "Module flow")
      },
      plan: async (flow) => ({ raw: flow }),
      start: async (card) => String(card.raw),
      resume: async (runId) => ({ runId }),
      watch: (runId) => {
        watched.push(runId)
        return { done: gates[names.indexOf(runId)]!.promise, close: () => {} }
      },
      events: async () => [],
      cancel: async () => {},
      dispose: async () => {}
    }
    await mount({ flows: port })
    await act(async () => setup!.renderer.resize(width, height))
    for (const name of names) {
      await type(`/flow ${name}`)
      await enter()
      await waitFor(() => records().some((record) => record.type === "flow" && record.run.flow === name))
    }
    expect(watched.length).toBeGreaterThan(0)
    await key("s", { ctrl: true })
    await act(async () => {
      gates.forEach((gate, index) => gate.resolve({ kind: "done", answer: `result-${index}` }))
      await setImmediate()
    })
    await waitFor(() =>
      names.every((name) =>
        records().some((record) => record.type === "flow" && record.run.flow === name && record.run.status === "done")
      )
    )
    await key("s", { ctrl: true })
    const chat = await draw()
    const visible = chat.split("\n").filter((row) => row.includes("enter") && /flow\d/.test(row))
      .map((row) => row.match(/flow\d/)![0])
    expect(visible.length).toBeGreaterThan(0)
    expect(visible.length).toBeLessThan(names.length)
    await enter()
    const opened = await draw()
    expect(opened).toContain(`result-${names.indexOf(visible[0]!)}`)
  }
)
