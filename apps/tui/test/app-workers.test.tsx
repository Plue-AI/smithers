import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"
import * as Theme from "../src/theme.ts"

// App boundary units with native headless rendering and real session storage.
// Only Host execution is controlled; no provider, shell or live agent runs.
let root = ""
let cwd = ""
let previousRoot: string | undefined
let previousTheme = Theme.activeTheme()
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let host: Host.Host
let turns: Array<{
  input: Host.TurnInput
  done: ReturnType<typeof Promise.withResolvers<Host.Outcome>>
  admitted: ReadonlyArray<Session.Record>
  cancelled: number
}> = []
const records = () => Session.list(cwd).flatMap((summary) => Session.load(summary.file))
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
const key = async (name: string, modifiers: { ctrl?: boolean } = {}) => {
  await act(async () => {
    setup!.mockInput.pressKey(name, modifiers)
    await setImmediate()
  })
  await render()
}
/** Esc closes the palette once the terminal parser gives up waiting for a longer sequence. */
const closePalette = async () => {
  await key("ESCAPE")
  const deadline = Date.now() + 2000
  while (frame().includes("esc Back")) {
    if (Date.now() > deadline) throw new Error("The palette did not close")
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    await render()
  }
}
/** Ctrl+K, the query, Enter: runs the first match. */
const palette = async (query: string) => {
  await key("k", { ctrl: true })
  await type(query)
  await key("RETURN")
}
const command = async (text: string) => {
  await type(text)
  await key("RETURN")
}
const request = { id: "review", title: "Review one file", prompt: "Review src/one.ts only." }
const delegate = async (input: Host.TurnInput, value = request) => {
  let receipt: unknown
  await act(async () => {
    receipt = input.runtime!.delegate!(value)
    await setImmediate()
  })
  await render()
  return receipt
}
const finish = async (index: number, outcome: Host.Outcome) => {
  await act(async () => {
    if (outcome._tag === "done") {
      turns[index]!.input.onEvent(
        new AgentEvent.Resolved({
          eventType: "flows.harness.resolved.v1",
          message: ModelRequest.Message.assistant(outcome.answer)
        })
      )
    }
    turns[index]!.done.resolve(outcome)
    await setImmediate()
  })
  await render()
}
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "tui-app-workers-"))
  cwd = join(root, "workspace")
  mkdirSync(cwd)
  previousRoot = process.env.SMITHERS_TUI_SESSION_DIR
  previousTheme = Theme.activeTheme()
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  turns = []
  host = {
    cwd,
    judged: false,
    dispose: async () => {},
    run: (input) => {
      const turn = {
        input,
        done: Promise.withResolvers<Host.Outcome>(),
        admitted: records(),
        cancelled: 0
      }
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
  await act(async () => {
    setup = await testRender(
      <App
        host={host}
        seat="replay:chat"
        workerSeat="replay:worker"
        models={[{ seat: "replay:chat", label: "Replay", provider: "Fixture" }]}
        contextWindow={() => 10000}
      />,
      { width: 140, height: 35, exitOnCtrlC: false }
    )
  })
  await command("Coordinate a review")
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

test("delegation persists its requested receipt before worker admission and preserves the composer", async () => {
  await type("Keep drafting")
  const receipt = await delegate(turns[0]!.input)
  expect(receipt).toEqual({ id: "review", status: "requested" })
  const worker = turns[1]!
  expect({ prompt: worker.input.prompt, seat: worker.input.seat, role: worker.input.role, source: worker.input.source })
    .toEqual({ prompt: "Review src/one.ts only.", seat: "replay:worker", role: "worker", source: "review" })
  expect(
    worker.admitted.filter((record) => record.type === "tab").slice(-1).map((record) => ({
      id: record.tab.id,
      status: record.tab.status,
      prompt: record.tab.prompt
    }))
  ).toEqual([{ id: "review", status: "requested", prompt: "Review src/one.ts only." }])
  const saved = tabs().at(-1)!.tab
  expect(Session.load(saved.file).filter((record) => record.type === "user").map((record) => record.text))
    .toEqual(["Review src/one.ts only."])
  expect(saved.status).toBe("running")
  expect(frame()).toContain("Review one file")
  await type(" intact")
  expect(frame()).toContain("Keep drafting intact")
  expect(turns).toHaveLength(2)
  expect(worker.cancelled).toBe(0)
})

test("a settled coordinator admits the next chat while its worker remains unresolved", async () => {
  await delegate(turns[0]!.input)
  await finish(0, { _tag: "done", answer: "Review delegated" })
  await command("Continue in chat")
  expect(turns.map((turn) => ({ prompt: turn.input.prompt, seat: turn.input.seat }))).toEqual([
    { prompt: "Coordinate a review", seat: "replay:chat" },
    { prompt: "Review src/one.ts only.", seat: "replay:worker" },
    { prompt: "Continue in chat", seat: "replay:chat" }
  ])
  expect(turns[2]!.input.background).toContain("Review one file")
  expect(tabs().at(-1)!.tab.status).toBe("running")
  expect(turns[1]!.cancelled).toBe(0)
  await type("More chat draft")
  expect(frame()).toContain("More chat draft")
})

test("same worker admission deduplicates while conflicting reuse refuses without another record or run", async () => {
  await delegate(turns[0]!.input)
  const count = tabs().length
  expect(await delegate(turns[0]!.input)).toEqual({ id: "review", status: "running" })
  expect(() => turns[0]!.input.runtime!.delegate!({ ...request, prompt: "Change src/two.ts instead." }))
    .toThrow("Request id already belongs to another request")
  expect(tabs()).toHaveLength(count)
  expect(turns.map((turn) => turn.input.prompt)).toEqual(["Coordinate a review", "Review src/one.ts only."])
  expect(tabs().at(-1)!.tab.prompt).toBe("Review src/one.ts only.")
})

test("Ctrl+K stop cancels only its named worker and resume reuses its prompt and chosen seat", async () => {
  await delegate(turns[0]!.input)
  await delegate(turns[0]!.input, { id: "other", title: "Other review", prompt: "Review src/two.ts only." })
  await key("k", { ctrl: true })
  await type("stop review one")
  expect(frame()).toMatch(/Stop\s+x\s+Review one file/)
  expect(frame()).not.toMatch(/Stop\s+x\s+Other review/)
  await key("RETURN")
  expect(turns.map((turn) => turn.cancelled)).toEqual([0, 1, 0])
  expect(tabs().filter((record) => record.tab.id === "review").at(-1)!.tab.status).toBe("cancelled")
  expect(tabs().filter((record) => record.tab.id === "other").at(-1)!.tab.status).toBe("running")
  await palette("resume review one")
  expect(turns[3]!.input.prompt).toBe("Review src/one.ts only.")
  expect(turns[3]!.input.seat).toBe("replay:worker")
  expect(turns[3]!.input.source).toBe("review")
  expect(turns[3]!.admitted.filter((record) => record.type === "tab").at(-1)!.tab.status).toBe("requested")
  expect(turns[0]!.cancelled).toBe(0)
  expect(turns[2]!.cancelled).toBe(0)
})

test("the removed /stop and /retry commands keep their line and never act", async () => {
  await delegate(turns[0]!.input)
  await command("/stop review")
  expect(frame()).toContain("Unknown command /stop")
  expect(frame()).toContain("/stop review")
  await key("c", { ctrl: true })
  await command("/retry review")
  expect(frame()).toContain("Unknown command /retry")
  expect(turns.map((turn) => turn.cancelled)).toEqual([0, 0])
  expect(turns).toHaveLength(2)
  expect(tabs().at(-1)!.tab.status).toBe("running")
})

test("each worker delegates and lists its own child when two parents reuse the same local child id", async () => {
  await delegate(turns[0]!.input)
  await delegate(turns[0]!.input, { id: "other", title: "Other review", prompt: "Review src/two.ts only." })
  expect(await delegate(turns[1]!.input, { id: "check", title: "Check first", prompt: "Check src/one.ts only." }))
    .toEqual({ id: "review/check", status: "requested" })
  expect(await delegate(turns[2]!.input, { id: "check", title: "Check second", prompt: "Check src/two.ts only." }))
    .toEqual({ id: "other/check", status: "requested" })
  expect(turns.slice(3).map((turn) => ({ source: turn.input.source, prompt: turn.input.prompt }))).toEqual([
    { source: "review/check", prompt: "Check src/one.ts only." },
    { source: "other/check", prompt: "Check src/two.ts only." }
  ])
  const firstChildren = turns[1]!.input.runtime!.list!()
  const secondChildren = turns[2]!.input.runtime!.list!()
  expect(firstChildren).toHaveLength(1)
  expect(secondChildren).toHaveLength(1)
  expect(firstChildren).toMatchObject([
    { id: "review/check", parent: "review", prompt: "Check src/one.ts only.", status: "running" }
  ])
  expect(secondChildren).toMatchObject([
    { id: "other/check", parent: "other", prompt: "Check src/two.ts only.", status: "running" }
  ])
  await type("Keep coordinating")
  expect(frame()).toContain("Keep coordinating")
  expect(turns.map((turn) => turn.cancelled)).toEqual([0, 0, 0, 0, 0])
})

test.each([
  { outcome: { _tag: "done", answer: "One file checked" } satisfies Host.Outcome, status: "done" },
  {
    outcome: { _tag: "failed", message: "Review refused", detail: "Fixture refusal" } satisfies Host.Outcome,
    status: "failed"
  },
  { outcome: { _tag: "cancelled" } satisfies Host.Outcome, status: "cancelled" }
])(
  "worker $status settles its own durable result while the coordinator and draft remain live",
  async ({ outcome, status }) => {
    await delegate(turns[0]!.input)
    await type("Continue drafting")
    await finish(1, outcome)
    const tab = tabs().at(-1)!.tab
    expect(tab.status).toBe(status)
    expect(Session.load(tab.file).filter((record) => record.type === "outcome").map((record) => record.outcome._tag))
      .toEqual([status])
    expect(turns).toHaveLength(2)
    expect(turns[0]!.cancelled).toBe(0)
    expect(frame()).toContain("Continue drafting")
    await type(" intact")
    expect(frame()).toContain("Continue drafting intact")
    await finish(0, { _tag: "done", answer: "Coordinator finished" })
    await key("RETURN")
    expect(turns[2]!.input.prompt).toBe("Continue drafting intact")
    expect(turns[2]!.input.seat).toBe("replay:chat")
    expect(turns[2]!.input.background).toContain("Review one file")
    if (outcome._tag === "done") expect(turns[2]!.input.background).toContain("One file checked")
    if (outcome._tag === "failed") expect(turns[2]!.input.background).toContain("Review refused")
  }
)

test("Ctrl+K lists stop only while a worker runs and resume only once it stopped, so neither repeats", async () => {
  await delegate(turns[0]!.input)
  await palette("stop review")
  await key("k", { ctrl: true })
  await type("review one")
  expect(frame()).not.toMatch(/Stop\s+x\s+Review one file/)
  expect(frame()).toMatch(/Resume\s+r\s+Review one file/)
  await closePalette()
  expect(turns.map((turn) => turn.cancelled)).toEqual([0, 1])
  await palette("resume review")
  await key("k", { ctrl: true })
  await type("review one")
  expect(frame()).not.toMatch(/Resume\s+r\s+Review one file/)
  expect(frame()).toMatch(/Stop\s+x\s+Review one file/)
  await closePalette()
  expect(turns.map((turn) => turn.input.prompt)).toEqual([
    "Coordinate a review",
    "Review src/one.ts only.",
    "Review src/one.ts only."
  ])
  expect(tabs().at(-1)!.tab.status).toBe("running")
  expect(turns[2]!.cancelled).toBe(0)
})

test("a failed worker is retried in a new linked session and its repaired answer reaches later chat context", async () => {
  await delegate(turns[0]!.input)
  const failedFile = tabs().at(-1)!.tab.file
  await finish(1, { _tag: "failed", message: "Review refused", detail: "Fixture refusal" })
  expect(tabs().at(-1)!.tab.status).toBe("failed")
  await palette("resume review")
  const replacement = tabs().at(-1)!.tab
  expect(replacement.file).not.toBe(failedFile)
  expect(Session.load(replacement.file)[0]).toMatchObject({ type: "session", parent: failedFile })
  expect(turns[2]!.input.prompt).toBe("Review src/one.ts only.")
  expect(turns[2]!.input.seat).toBe("replay:worker")
  await finish(2, { _tag: "done", answer: "Recovered review answer" })
  expect(tabs().at(-1)!.tab.status).toBe("done")
  await finish(0, { _tag: "done", answer: "Coordinator finished" })
  await command("Use the review result")
  expect(turns[3]!.input.background).toContain("Recovered review answer")
  expect(turns[3]!.input.background).not.toContain("Review refused")
  expect(turns.map((turn) => turn.cancelled)).toEqual([0, 0, 0, 0])
})

test("worker steering drains only from the selected worker and never from the coordinator", async () => {
  await delegate(turns[0]!.input)
  await palette("steer review")
  await command("Check the tests too")
  const workerDrain = Effect.runSync(turns[1]!.input.steering!.drain({ boundary: "worker-cell", wouldIdle: false }))
  const chatDrain = Effect.runSync(turns[0]!.input.steering!.drain({ boundary: "chat-cell", wouldIdle: false }))
  expect(
    workerDrain.inserts.map((message) =>
      message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")
    )
  ).toEqual(["Check the tests too"])
  expect(chatDrain.inserts).toEqual([])
  const tab = tabs().at(-1)!.tab
  expect(Session.load(tab.file).filter((record) => record.type === "user").map((record) => record.text)).toEqual([
    "Review src/one.ts only.",
    "Check the tests too"
  ])
  expect(records().filter((record) => record.type === "user").map((record) => record.text))
    .toEqual(["Coordinate a review"])
  expect(turns).toHaveLength(2)
  await finish(1, { _tag: "done", answer: "Worker checks done" })
  await finish(0, { _tag: "done", answer: "Coordinator done" })
  expect(turns).toHaveLength(2)
})
