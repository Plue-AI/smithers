import { type Renderable, ScrollBoxRenderable, TextareaRenderable } from "@opentui/core"
import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, beforeEach, expect, test } from "bun:test"
import { Effect } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { act } from "react"
import { App } from "../src/app.tsx"
import type * as Host from "../src/host.ts"
import * as Session from "../src/session.ts"
import { seats } from "../src/workspace.ts"

// App boundary units with native headless rendering and real session storage.
// Only Host execution is controlled; no provider, shell or live agent runs.
let root = ""
let cwd = ""
let previousRoot: string | undefined
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let host: Host.Host
let settleCancellation = true
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
const key = async (name: string, modifiers: { ctrl?: boolean; meta?: boolean; shift?: boolean } = {}) => {
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
type Delegation = Parameters<NonNullable<NonNullable<Host.TurnInput["runtime"]>["delegate"]>>[0]
const delegate = async (input: Host.TurnInput, value: Delegation = request) => {
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
  process.env.SMITHERS_TUI_SESSION_DIR = join(root, "sessions")
  turns = []
  settleCancellation = true
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
          if (settleCancellation) turn.done.resolve({ _tag: "cancelled" })
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
  expect(frame()).toMatch(/Stop\s+alt\+x\s+Review one file/)
  expect(frame()).not.toMatch(/Stop\s+alt\+x\s+Other review/)
  await key("RETURN")
  expect(frame()).toContain("Stop Review one file?")
  expect(turns.map((turn) => turn.cancelled)).toEqual([0, 0, 0])
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
  expect(frame()).toContain("Stop Review one file?")
  await key("RETURN")
  await key("k", { ctrl: true })
  await type("review one")
  expect(frame()).not.toMatch(/Stop\s+alt\+x\s+Review one file/)
  expect(frame()).toMatch(/Resume\s+alt\+r\s+Review one file/)
  await closePalette()
  expect(turns.map((turn) => turn.cancelled)).toEqual([0, 1])
  await palette("resume review")
  await key("k", { ctrl: true })
  await type("review one")
  expect(frame()).not.toMatch(/Resume\s+alt\+r\s+Review one file/)
  expect(frame()).toMatch(/Stop\s+alt\+x\s+Review one file/)
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

const descendant = <T extends Renderable>(node: Renderable, kind: new(...args: never[]) => T): T | undefined => {
  if (node instanceof kind) return node
  for (const child of node.getChildren()) {
    const found = descendant(child, kind)
    if (found !== undefined) return found
  }
  return undefined
}
const composer = () => descendant(setup!.renderer.root, TextareaRenderable)!
const scroll = () => descendant(setup!.renderer.root, ScrollBoxRenderable)!
const openWorker = async () => {
  await key("ARROW_RIGHT", { ctrl: true })
  await key("ARROW_RIGHT", { ctrl: true })
  expect(frame()).toContain("Continue Review one file")
}
const opening = (input: Host.TurnInput) =>
  input.onEvent(
    new AgentEvent.TurnOpened({
      eventType: "flows.harness.turn-opened.v1",
      seat: input.seat,
      modelParams: {},
      activeToolNames: [],
      contextDigest: "fixture"
    })
  )
const stream = async (index: number, text: string) => {
  await act(async () => {
    opening(turns[index]!.input)
    turns[index]!.input.onEvent(
      new AgentEvent.ModelDelta({
        eventType: "flows.harness.model-delta.v1",
        delta: { type: "text-delta", id: `fixture-${index}`, text }
      })
    )
    await setImmediate()
  })
  await render()
}
const drainDeferredScroll = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100))
    await setImmediate()
  })
  await render()
}

test.each([false, true])(
  "worker opens its native composer and printable action letters type, rows=%s",
  async (rows) => {
    await delegate(turns[0]!.input)
    await key("ARROW_RIGHT", { ctrl: true })
    // The focus key and later bytes arrive in one terminal write, before React's
    // next render. The native editor must own all of the following characters.
    await act(async () => {
      setup!.mockInput.pressKey("ARROW_RIGHT", { ctrl: true })
      if (rows) setup!.mockInput.pressKey("TAB")
      await setup!.mockInput.pressKeys(Array.from("explain rxstmawudvjkhl 😀"))
    })
    await render()
    expect(composer().focused).toBe(true)
    expect(composer().plainText).toBe("explain rxstmawudvjkhl 😀")
    expect(turns.map((turn) => turn.cancelled)).toEqual([0, 0])
    expect(tabs().at(-1)!.tab.status).toBe("running")
    expect(turns).toHaveLength(2)
    await key("RETURN")
    const inserts =
      Effect.runSync(turns[1]!.input.steering!.drain({ boundary: "worker-cell", wouldIdle: false })).inserts
    expect(
      inserts.map((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join(""))
    )
      .toEqual(["explain rxstmawudvjkhl 😀"])
    expect(Effect.runSync(turns[0]!.input.steering!.drain({ boundary: "chat-cell", wouldIdle: false })).inserts)
      .toEqual([])
  }
)

test("printable retry letters in a finished worker tab remain an unsent draft", async () => {
  await delegate(turns[0]!.input)
  await finish(1, { _tag: "done", answer: "Review complete" })
  await openWorker()
  await type("rerun explanation")
  expect(composer().plainText).toBe("rerun explanation")
  expect(composer().focused).toBe(true)
  expect(turns).toHaveLength(2)
  expect(tabs().at(-1)!.tab.status).toBe("done")
})

test.each(["escape", "cancel", "confirm"] as const)(
  "Stop %s confirms only the selected run and preserves its draft",
  async (choice) => {
    await delegate(turns[0]!.input)
    await delegate(turns[0]!.input, { id: "other", title: "Other review", prompt: "Review another file." })
    await openWorker()
    await type("Keep this draft")
    await key("x", { meta: true })
    expect(frame()).toContain("Stop Review one file?")
    expect(turns.map((turn) => turn.cancelled)).toEqual([0, 0, 0])
    if (choice === "escape") {
      await key("ESCAPE")
      await drainDeferredScroll()
    } else {
      if (choice === "cancel") await key("ARROW_DOWN")
      await key("RETURN")
    }
    expect(composer().plainText).toBe("Keep this draft")
    expect(turns.map((turn) => turn.cancelled)).toEqual([0, choice === "confirm" ? 1 : 0, 0])
    expect(frame()).not.toContain("Stop Review one file?")
    if (choice === "confirm") {
      await key("x", { meta: true })
      expect(frame()).not.toContain("Stop Review one file?")
      expect(turns[1]!.cancelled).toBe(1)
      await key("r", { meta: true })
      expect(turns).toHaveLength(4)
      await key("x", { meta: true })
      expect(frame()).toContain("Stop Review one file?")
      expect(turns[3]!.cancelled).toBe(0)
      await key("RETURN")
      expect(turns[3]!.cancelled).toBe(1)
    }
  }
)

test("a run that completes while its Stop confirmation is open cannot be cancelled afterward", async () => {
  await delegate(turns[0]!.input)
  await openWorker()
  await key("x", { meta: true })
  await finish(1, { _tag: "done", answer: "Finished while confirming" })
  await key("RETURN")
  expect(turns[1]!.cancelled).toBe(0)
  expect(tabs().at(-1)!.tab.status).toBe("done")
  expect(frame()).not.toContain("Stop Review one file?")
})

test("an unresolved Stop is confirmed once across keyboard, palette and chip requests; a new run confirms anew", async () => {
  settleCancellation = false
  await delegate(turns[0]!.input)
  await openWorker()
  await key("x", { meta: true })
  await key("RETURN")
  expect(turns[1]!.cancelled).toBe(1)
  expect(tabs().at(-1)!.tab.status).toBe("running")
  await key("x", { meta: true })
  expect(frame()).not.toContain("Stop Review one file?")
  await palette("stop review")
  expect(frame()).not.toContain("Stop Review one file?")
  const lines = frame().split("\n")
  const y = lines.findIndex((line) => line.includes("alt+x Stop"))
  expect(y).toBeGreaterThanOrEqual(0)
  await act(async () => {
    await setup!.mockMouse.click(lines[y]!.indexOf("alt+x Stop") + 6, y)
  })
  await render()
  expect(frame()).not.toContain("Stop Review one file?")
  expect(turns[1]!.cancelled).toBe(1)
  await finish(1, { _tag: "cancelled" })
  await key("r", { meta: true })
  expect(turns).toHaveLength(3)
  await key("x", { meta: true })
  expect(frame()).toContain("Stop Review one file?")
  expect(turns[2]!.cancelled).toBe(0)
  await key("RETURN")
  expect(turns[2]!.cancelled).toBe(1)
})

test.each([false, true])("a contributed panel key keeps its owning worker and row context, rows=%s", async (rows) => {
  await delegate(turns[0]!.input)
  await delegate(turns[0]!.input, { id: "other", title: "Other review", prompt: "Review another file." })
  await act(async () => {
    turns[1]!.input.runtime!.publish({
      kind: "key",
      key: { id: "back", key: "alt+z", label: "Back", context: "panel", action: { kind: "open", surface: "chat" } }
    })
    await setImmediate()
  })
  await render()
  await palette("tab:Other review")
  if (rows) await key("TAB")
  await key("z", { meta: true })
  expect(frame()).toContain("Subagent · Other review")
  expect(turns).toHaveLength(3)
  await palette("tab:Review one file")
  await key("z", { meta: true })
  expect(frame()).toContain("Subagent · Review one file")
  await key("TAB")
  await key("z", { meta: true })
  expect(frame()).not.toContain("Subagent · Review one file")
  expect(frame()).toContain("Coordinate a review")
  expect(frame()).not.toContain("steer ↳ Review one file")
  expect(turns).toHaveLength(3)
})

test("Stop confirmation for a failed run cannot cancel its replacement", async () => {
  await delegate(turns[0]!.input)
  await openWorker()
  await key("x", { meta: true })
  await finish(1, { _tag: "failed", message: "Fixture failure", detail: "Failed while confirming" })
  await act(async () => {
    turns[0]!.input.runtime!.retry!("review")
    await setImmediate()
  })
  await render()
  expect(turns).toHaveLength(3)
  await key("RETURN")
  expect(turns.map((turn) => turn.cancelled)).toEqual([0, 0, 0])
  expect(tabs().at(-1)!.tab.status).toBe("running")
  expect(frame()).not.toContain("Stop Review one file?")
})

test("printable answer keys in a worker's form fill its answer without steering or stopping", async () => {
  await delegate(turns[0]!.input)
  await openWorker()
  let answer: Promise<unknown> | undefined
  await act(async () => {
    answer = turns[1]!.input.runtime!.ask!({ question: "Which path?", to: "person" })
    await setImmediate()
  })
  await render()
  await key("a", { meta: true })
  expect(frame()).toContain("Which path?")
  await type("explain rxstmawudvjkhl")
  await key("RETURN")
  expect(await answer).toEqual({ answer: "explain rxstmawudvjkhl", approved: true })
  expect(turns.map((turn) => turn.cancelled)).toEqual([0, 0])
  expect(Effect.runSync(turns[1]!.input.steering!.drain({ boundary: "worker-cell", wouldIdle: false })).inserts)
    .toEqual([])
  expect(Effect.runSync(turns[0]!.input.steering!.drain({ boundary: "chat-cell", wouldIdle: false })).inserts).toEqual(
    []
  )
})

const steered = (index: number, boundary: string) =>
  Effect.runSync(turns[index]!.input.steering!.drain({ boundary, wouldIdle: false })).inserts
const until = async (check: () => boolean, ms = 5000) => {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out:\n${frame()}`)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    await render()
  }
}

test("Alt+Enter in a running agent tab queues the message until that agent finishes", async () => {
  await delegate(turns[0]!.input)
  await openWorker()
  expect(frame()).toContain("enter Steer  alt+enter Queue")
  await type("Then list the files you read")
  await key("RETURN", { meta: true })
  expect(composer().plainText).toBe("")
  expect(frame()).toContain("Follow-up: Then list the files you read")
  // Nothing reaches the running agent, or Chat, before it finishes.
  expect(steered(1, "worker-cell")).toEqual([])
  expect(steered(0, "chat-cell")).toEqual([])
  expect(turns).toHaveLength(2)
  await stream(1, "Still reviewing")
  expect(turns).toHaveLength(2)
  await finish(1, { _tag: "done", answer: "Reviewed" })
  await until(() => turns.length === 3)
  expect(turns[2]!.input).toMatchObject({ prompt: "Then list the files you read", source: "review" })
  expect(frame()).not.toContain("Follow-up:")
  expect(records().filter((record) => record.type === "queued").map((record) => record.prompt))
    .toMatchObject([{ text: "Then list the files you read", scope: "tab:review" }])
})

test("a stopped agent keeps its queued message for Alt+Up and never starts it", async () => {
  await delegate(turns[0]!.input)
  await openWorker()
  await type("Queued note")
  await key("RETURN", { meta: true })
  await finish(1, { _tag: "cancelled" })
  expect(turns).toHaveLength(2)
  expect(frame()).toContain("Follow-up: Queued note")
  await key("ARROW_UP", { meta: true })
  expect(composer().plainText).toBe("Queued note")
  expect(frame()).not.toContain("Follow-up:")
  expect(turns).toHaveLength(2)
})

test("an agent's queue stays in its tab, and Chat's in Chat", async () => {
  await delegate(turns[0]!.input)
  await type("Chat follow-up")
  await key("RETURN", { meta: true })
  expect(frame()).toContain("Follow-up: Chat follow-up")
  await openWorker()
  expect(frame()).not.toContain("Follow-up: Chat follow-up")
  await type("Agent follow-up")
  await key("RETURN", { meta: true })
  expect(frame()).toContain("Follow-up: Agent follow-up")
  await key("ARROW_UP", { meta: true })
  expect(composer().plainText).toBe("Agent follow-up")
  await key("c", { ctrl: true })
  await key("ESCAPE")
  await until(() => frame().includes("Follow-up: Chat follow-up"))
  expect(frame()).not.toContain("Agent follow-up")
  // Chat's queue still runs after Chat's turn, never in the agent.
  await finish(0, { _tag: "done", answer: "Coordinated" })
  expect(turns.at(-1)!.input).toMatchObject({ prompt: "Chat follow-up", seat: "replay:chat" })
})

test("Enter on an agent waiting for a seat queues for after it finishes, never to Chat", async () => {
  for (let index = 0; index < seats; index++) {
    await delegate(turns[0]!.input, {
      id: `active-${index}`,
      title: `Active ${index}`,
      prompt: `Review file ${index}.`
    })
  }
  await delegate(turns[0]!.input, { id: "queued", title: "Queued review", prompt: "Review the queued file." })
  await palette("tab:Queued review")
  expect(tabs().findLast((record) => record.tab.id === "queued")!.tab.status).toBe("queued")
  expect(frame()).toContain("enter Queue  esc Chat")
  await type("Keep this with the queued review")
  await key("RETURN")
  expect(composer().plainText).toBe("")
  expect(frame()).toContain("Follow-up: Keep this with the queued review")
  expect(turns).toHaveLength(seats + 1)
  expect(steered(0, "chat-cell")).toEqual([])
  expect(records().filter((record) => record.type === "user").map((record) => record.text))
    .not.toContain("Keep this with the queued review")
  await finish(1, { _tag: "done", answer: "Done" })
  await until(() => turns.some((turn) => turn.input.prompt === "Review the queued file."))
  const started = turns.findIndex((turn) => turn.input.prompt === "Review the queued file.")
  expect(steered(started, "worker-cell")).toEqual([])
  await finish(started, { _tag: "done", answer: "Queued reviewed" })
  await until(() => turns.some((turn) => turn.input.prompt === "Keep this with the queued review"))
  expect(turns.find((turn) => turn.input.prompt === "Keep this with the queued review")!.input.source).toBe("queued")
})

test.each(["codex", "claude"] as const)(
  "Enter in a running wrapped %s agent queues the message and hands it to the vendor once its run completes",
  async (vendor) => {
    const saved = {
      PATH: process.env.PATH,
      FAKE_VENDOR_LOG: process.env.FAKE_VENDOR_LOG,
      FAKE_VENDOR_PAUSE: process.env.FAKE_VENDOR_PAUSE
    }
    const log = join(root, "vendor.log")
    process.env.PATH = `${join(import.meta.dir, "fixtures", "vendor")}:${saved.PATH}`
    process.env.FAKE_VENDOR_LOG = log
    process.env.FAKE_VENDOR_PAUSE = "0.6"
    const launches = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []
    try {
      await delegate(turns[0]!.input, { id: "wrapped", title: "Wrapped review", prompt: "Fix it.", harness: vendor })
      await until(() => launches().length === 1)
      await key("ARROW_RIGHT", { ctrl: true })
      await key("ARROW_RIGHT", { ctrl: true })
      expect(frame()).toContain("Continue Fix it.")
      expect(frame()).toContain("enter Queue  esc Chat")
      await type("Then add a test")
      await key("RETURN")
      expect(composer().plainText).toBe("")
      expect(frame()).toContain("Follow-up: Then add a test")
      expect(launches()).toHaveLength(1)
      expect(launches()[0]).toContain("<<< Fix it.")
      await until(() => launches().length === 2, 10_000)
      expect(launches()[1]).toContain("<<< Then add a test")
      expect(frame()).not.toContain("Follow-up:")
      expect(steered(0, "chat-cell")).toEqual([])
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  },
  20_000
)

test("Escape after Chat timeline inspection restores its scroll and sends to Chat, even when inspection opened a worker", async () => {
  await stream(0, "Earlier chat line\n".repeat(50))
  await delegate(turns[0]!.input)
  await stream(1, "Worker line\n".repeat(35))
  // A live step shows its prose only expanded.
  await key("o", { ctrl: true })
  await type("Chat draft")
  await key("\u001b[5~")
  const position = scroll().scrollTop
  expect(position).toBeLessThan(scroll().scrollHeight - scroll().viewport.height)
  await key("t", { ctrl: true })
  await key("ARROW_LEFT")
  await drainDeferredScroll()
  expect(frame()).toContain("steer ↳ Review one file")
  await key("ESCAPE")
  await drainDeferredScroll()
  expect(frame()).not.toContain("steer ↳ Review one file")
  expect(scroll().scrollTop).toBe(position)
  expect(composer().plainText).toBe("Chat draft")
  expect(composer().focused).toBe(true)
  await type(" restored")
  await key("RETURN")
  expect(Effect.runSync(turns[1]!.input.steering!.drain({ boundary: "worker-cell", wouldIdle: false })).inserts)
    .toEqual([])
  const inserts = Effect.runSync(turns[0]!.input.steering!.drain({ boundary: "chat-cell", wouldIdle: false })).inserts
  expect(inserts.map((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")))
    .toEqual(["Chat draft restored"])
})

test("Escape after worker timeline inspection restores the worker's scroll, draft and composer target", async () => {
  await delegate(turns[0]!.input)
  await stream(1, "Worker line\n".repeat(50))
  await key("o", { ctrl: true })
  await openWorker()
  await type("Worker draft")
  await key("\u001b[5~")
  const position = scroll().scrollTop
  await key("t", { ctrl: true })
  await key("ARROW_LEFT")
  await drainDeferredScroll()
  await key("ESCAPE")
  await drainDeferredScroll()
  expect(scroll().scrollTop).toBe(position)
  expect(composer().plainText).toBe("Worker draft")
  expect(composer().focused).toBe(true)
  await type(" restored")
  await key("RETURN")
  const inserts = Effect.runSync(turns[1]!.input.steering!.drain({ boundary: "worker-cell", wouldIdle: false })).inserts
  expect(inserts.map((message) => message.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("")))
    .toEqual(["Worker draft restored"])
  expect(Effect.runSync(turns[0]!.input.steering!.drain({ boundary: "chat-cell", wouldIdle: false })).inserts).toEqual(
    []
  )
})

test.each(["chat", "worker"] as const)(
  "Enter while %s is scrolled up reveals the person's new message",
  async (target) => {
    await stream(0, "Old chat content\n".repeat(50))
    if (target === "worker") {
      await delegate(turns[0]!.input)
      await stream(1, "Old worker content\n".repeat(50))
      await key("o", { ctrl: true })
      await openWorker()
    } else await finish(0, { _tag: "done", answer: "Old chat content\n".repeat(50) })
    await key("\u001b[5~")
    await key("\u001b[5~")
    expect(scroll().scrollTop).toBeLessThan(scroll().scrollHeight - scroll().viewport.height)
    await type("Reply with exactly: hello")
    await key("RETURN")
    await drainDeferredScroll()
    expect(frame()).toContain("Reply with exactly: hello")
    expect(scroll().scrollTop).toBe(scroll().scrollHeight - scroll().viewport.height)
    if (target === "chat") {
      await finish(1, { _tag: "done", answer: "hello" })
      expect(frame()).toContain("hello")
    } else {
      expect(turns).toHaveLength(2)
      expect(Effect.runSync(turns[1]!.input.steering!.drain({ boundary: "worker-cell", wouldIdle: false })).inserts)
        .toHaveLength(1)
    }
  }
)
