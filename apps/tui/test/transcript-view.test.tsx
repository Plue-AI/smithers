import { useRenderer } from "@opentui/react"
import { testRender } from "@opentui/react/test-utils"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import * as Cell from "@smthrs/harness/Cell"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { afterEach, expect, test } from "bun:test"
import { setImmediate, setTimeout as timerPhase } from "node:timers/promises"
import { act, useState } from "react"
import type * as Panels from "../src/panels.ts"
import * as Timeline from "../src/timeline.ts"
import { useTranscriptView } from "../src/transcript-view.ts"
import * as Transcript from "../src/transcript.ts"
import type { Tab } from "../src/workspace.ts"

type Input = Omit<Parameters<typeof useTranscriptView>[0], "renderer" | "setPanelFocus">
type Projection = ReturnType<typeof useTranscriptView>
let setup: Awaited<ReturnType<typeof testRender>> | undefined
let projection: Projection | undefined
let update: ((change: Partial<Input>) => void) | undefined
const panelFocus: boolean[] = []
const current = (): Projection => {
  if (projection === undefined) throw new Error("The mounted projection is unavailable")
  return projection
}
const Harness = ({ initial }: { readonly initial: Input }) => {
  const [input, setInput] = useState(initial)
  update = (change) => setInput((before) => ({ ...before, ...change }))
  projection = useTranscriptView({
    ...input,
    renderer: useRenderer(),
    setPanelFocus: (focused) => panelFocus.push(focused)
  })
  return (
    <box style={{ height: "100%", flexDirection: "column" }}>
      <text>{input.surface} · {projection.focusedCard ?? "no card"} · {projection.monitored?.id ?? "no activity"}</text>
      <scrollbox ref={projection.scroll} style={{ flexGrow: 1, minHeight: 0 }}>
        {Array.from({ length: 30 }, (_, index) => <text key={`filler-${index}`}>line {index}</text>)}
        {input.surface === "chat"
          ? projection.rows.map((row) => <text key={row.key} id={row.key}>{row.key}</text>)
          : null}
        {projection.cardKeys.filter((key) => key.startsWith("agent:")).map((key) => (
          <text key={key} id={key}>{key}</text>
        ))}
      </scrollbox>
    </box>
  )
}
const mount = async (options: Partial<Input> = {}) => {
  setup = await testRender(
    <Harness
      initial={{
        conversation: "fixture-conversation",
        transcript: Transcript.empty,
        tabs: [],
        worker: () => Transcript.empty,
        filter: Timeline.all,
        surface: "chat",
        panel: undefined,
        panelFocus: false,
        width: 80,
        ...options
      }}
    />,
    { width: 80, height: 12 }
  )
  await setup.renderOnce()
}
const change = async (options: Partial<Input>) => {
  await act(async () => {
    update!(options)
  })
  await setup!.renderOnce()
}
const action = async (run: (view: Projection) => void) => {
  await act(async () => {
    run(current())
  })
  await setup!.renderOnce()
}
afterEach(async () => {
  await act(async () => {
    setup?.renderer.destroy()
  })
  setup = undefined
  projection = undefined
  update = undefined
  panelFocus.length = 0
})

const panel: Panels.Panel = { id: "checks", title: "Checks", summary: "Passed", rows: [] }
const card = Transcript.card(Transcript.empty, panel, 0)
const tabs: ReadonlyArray<Tab> = ["w1", "w2", "w3", "w4"].map((id) => ({
  id,
  title: id,
  prompt: "Work",
  seat: "replay:test",
  file: `${id}.jsonl`,
  status: "running",
  startedAt: 1,
  depth: 0
}))
const running = (at: number) => {
  let transcript = Transcript.user(Transcript.empty, "Work", false, at)
  transcript = Transcript.apply(
    transcript,
    new AgentEvent.TurnOpened({
      eventType: "flows.harness.turn-opened.v1",
      seat: "replay:test",
      modelParams: {},
      activeToolNames: [],
      contextDigest: "context"
    }),
    at
  )
  return Transcript.apply(
    transcript,
    new AgentEvent.ModelDelta({
      eventType: "flows.harness.model-delta.v1",
      delta: { type: "text-delta", id: "reply", text: "Working\n```js\n1\n```" }
    }),
    at + 1
  )
}
const done = (at: number) => {
  const transcript = running(at)
  return Transcript.apply(
    transcript,
    new AgentEvent.Resolved({
      eventType: "flows.harness.resolved.v1",
      message: ModelRequest.Message.assistant("Done")
    }),
    at + 2
  )
}

test("empty projection has no focus or activity and accepts harmless navigation", async () => {
  await mount()
  expect(current().cardKeys).toEqual([])
  expect(current().showActivity).toBe(false)
  await action((view) => {
    view.moveCard("next")
    view.inspectActivity(1)
    view.reveal("missing")
    view.followLive()
    view.clearInspection()
  })
  expect(current().focusedCard).toBeUndefined()
  expect(current().activeInspection).toBeUndefined()
  expect(panelFocus).toEqual([])
})

test.each([[35, "agent:w2"], [70, "agent:w2"], [140, "agent:w2"]] as const)(
  "card down at width %s follows the visible stack to %s",
  async (width, target) => {
    await mount({ transcript: card, tabs, width })
    expect(current().cardKeys).toEqual(["chat:0", "agent:w1", "agent:w2", "agent:w3", "agent:w4"])
    await action((view) => view.setCardFocus("agent:w1"))
    expect(current().focusedWorker).toBe(tabs[0])
    await action((view) => view.moveCard("down"))
    expect(current().focusedCard).toBe(target)
    expect(setup!.captureCharFrame()).toContain(target)
  }
)

test("focus disappears when its worker is removed, without moving onto another worker", async () => {
  await mount({ transcript: card, tabs })
  await action((view) => view.setCardFocus("agent:w2"))
  await change({ tabs: tabs.filter((tab) => tab.id !== "w2") })
  expect(current().focusedCard).toBeUndefined()
  expect(current().focusedWorker).toBeUndefined()
  await action((view) => view.moveCard("next"))
  expect(current().focusedCard).toBeUndefined()
})

test.each(["summary", "tab:w1"])("card navigation stays unavailable on %s", async (surface) => {
  await mount({ transcript: card, tabs, surface })
  await action((view) => view.setCardFocus("agent:w1"))
  expect(current().cardKeys).toEqual([])
  expect(current().focusedCard).toBeUndefined()
  await action((view) => view.moveCard("next"))
})

test("a panel hides chat cards and activity, while its worker tab retains worker activity", async () => {
  const worker = running(200)
  await mount({ transcript: card, tabs, worker: () => worker, panel })
  expect(current().cardKeys).toEqual([])
  expect(current().showActivity).toBe(false)
  await change({ surface: "tab:w2" })
  expect(current().showActivity).toBe(true)
  expect(current().monitored?.id).toBe("w2")
})

test("Chat keeps its own timeline while other runs execute", async () => {
  const chat = running(100)
  const completed = done(300)
  await mount({ transcript: chat, tabs, worker: () => completed })
  expect(current().monitored?.id).toBe("chat")
  await change({ transcript: done(300) })
  expect(current().monitored?.id).toBe("chat")
  await change({ transcript: Transcript.empty })
  expect(current().monitored).toBeUndefined()
})

test("inspection stays pinned against newer work and resets on a new turn's record identity", async () => {
  const original = running(100)
  await mount({ transcript: original })
  await action((view) => view.inspectActivity(1, false))
  expect(current().activeInspection?.seq).toBe(1)
  expect(current().jumpTarget).toBe("chat:1")
  expect(panelFocus).toEqual([false])
  await change({ tabs, worker: () => running(300) })
  expect(current().monitored?.id).toBe("chat")
  expect(current().activeInspection?.seq).toBe(1)
  await change({ transcript: running(400) })
  expect(current().activeInspection).toBeUndefined()
  expect(current().jumpTarget).toBeUndefined()
  expect(current().monitored?.id).toBe("chat")
})

test("successful request-only Chat activity gives way to the host card", async () => {
  const original = done(100)
  const worker = running(200)
  const requested: Transcript.Transcript = {
    ...original,
    items: [...original.items, {
      kind: "cell",
      id: "request",
      index: 1,
      prose: "Requested.",
      source: "",
      printed: "",
      status: "done",
      startedAt: 101,
      calls: [{ flow: "agent.delegate", subject: "w1", status: "ok", startedAt: 101 }]
    }]
  }
  await mount({ transcript: requested, tabs: [tabs[0]!], worker: () => worker })
  expect(current().showActivity).toBe(false)
  expect(current().monitored).toBeUndefined()
  for (const [flow, status] of [["read", "ok"], ["agent.delegate", "failed"], ["agent.delegate", "stopped"]] as const) {
    await change({
      transcript: {
        ...requested,
        items: requested.items.map((item) =>
          item.id !== "request" || item.kind !== "cell"
            ? item
            : { ...item, calls: [{ ...item.calls[0]!, flow, status }] }
        )
      }
    })
    expect(current().showActivity).toBe(true)
    expect(current().monitored?.id).toBe("chat")
  }
})

test("worker inspection retains its current tab and exposes only that worker's jump target", async () => {
  const worker = running(200)
  await mount({ transcript: done(100), tabs: [tabs[0]!], worker: () => worker, surface: "tab:w1" })
  await action((view) => view.inspectActivity(1))
  expect(panelFocus).toEqual([false])
  expect(current().workerJump("w1")).toBe("1")
  expect(current().workerJump("w2")).toBeUndefined()
  expect(current().jumpTarget).toBeUndefined()
  await action((view) => view.inspectActivity(1))
  await action((view) => view.clearInspection())
  expect(current().activeInspection).toBeUndefined()
  expect(current().workerJump("w1")).toBeUndefined()
})

test("reveal uses the mounted scroll box and ending inspection restores its original scroll", async () => {
  await mount({ transcript: running(100) })
  const box = current().scroll.current!
  expect(box.scrollTop).toBe(0)
  await action((view) => view.reveal("chat:1"))
  expect(box.scrollTop).toBeGreaterThan(0)
  expect(setup!.captureCharFrame()).toContain("chat:1")
  const position = box.scrollTop
  await action((view) => view.reveal("unknown"))
  expect(box.scrollTop).toBe(position)
  await action((view) => view.inspectActivity(1, false))
  await action((view) => view.followLive())
  expect(current().activeInspection).toBeUndefined()
  expect(box.scrollTop).toBe(position)
  await action((view) => view.snapToLive())
  expect(box.scrollTop).toBe(box.scrollHeight - box.viewport.height)
})

test("Summary cannot switch views through timeline inspection", async () => {
  await mount({ transcript: running(100), surface: "summary" })
  await action((view) => view.inspectActivity(1))
  expect(current().showActivity).toBe(false)
  expect(current().activeInspection).toBeUndefined()
  expect(current().jumpTarget).toBeUndefined()
})

test("a recorded opening without a produced cell can be inspected without inventing a jump", async () => {
  const transcript = Transcript.apply(
    Transcript.empty,
    new AgentEvent.TurnOpened({
      eventType: "flows.harness.turn-opened.v1",
      seat: "replay:test",
      modelParams: {},
      activeToolNames: [],
      contextDigest: "context"
    }),
    100
  )
  await mount({ transcript })
  await action((view) => view.inspectActivity(1))
  expect(current().showActivity).toBe(true)
  expect(current().activeInspection?.seq).toBe(1)
  expect(current().jumpTarget).toBeUndefined()
  expect(panelFocus).toEqual([false])
})

const longTranscript = (at: number) => {
  let transcript = running(at)
  for (let index = 0; index < 30; index++) transcript = Transcript.note(transcript, `Update ${index}`, at + index + 2)
  return transcript
}
// This later real timer drains the existing 60 ms deferred reveal before
// assertions/renderer teardown. It is an ordering barrier, not a speed claim.
const drainReveal = async () => {
  await act(async () => {
    await timerPhase(100)
    await setImmediate()
  })
  await setup?.renderOnce()
}

test("inspection begun in another worker replaces the stale return surface and focus", async () => {
  const worker = running(100)
  await mount({ tabs, worker: () => worker, surface: "tab:w1" })
  await action((view) => view.inspectActivity(1, false))
  await change({ surface: "tab:w2", panelFocus: true })
  expect(current().activeInspection).toBeUndefined()
  expect(current().inspectionInterrupted).toBe(true)
  await action((view) => view.inspectActivity(1, false))
  expect(current().activeInspection?.source).toBe("w2")
  expect(current().inspectionInterrupted).toBe(false)
  await action((view) => view.followLive())
  await drainReveal()
  expect(panelFocus).toEqual([false, false, true])
  expect(current().activeInspection).toBeUndefined()
})

test.each([Transcript.empty, Transcript.user(Transcript.empty, "Work", false, 200)])(
  "manual navigation to a worker without activity cancels the inherited timeline and return target",
  async (emptyWorker) => {
    const firstWorker = running(100)
    await mount({ tabs, worker: (id) => id === "w1" ? firstWorker : emptyWorker, surface: "tab:w1" })
    await action((view) => view.inspectActivity(1, false))
    expect(current().activeInspection?.source).toBe("w1")
    await change({ surface: "tab:w2" })
    expect(current().activeInspection).toBeUndefined()
    expect(current().monitored).toBeUndefined()
    expect(current().showActivity).toBe(false)
    expect(current().inspectionInterrupted).toBe(true)
    await action((view) => view.followLive())
    await drainReveal()
    expect(current().inspectionInterrupted).toBe(false)
    expect(setup!.captureCharFrame()).toContain("no activity")
    await action((view) => view.inspectActivity(1))
    expect(current().activeInspection).toBeUndefined()
  }
)

test("another manual navigation clears the interrupted dismissal without resurrecting its origin", async () => {
  const worker = running(100)
  await mount({ tabs, worker: (id) => id === "w1" ? worker : Transcript.empty, surface: "tab:w1" })
  await action((view) => view.inspectActivity(1, false))
  await change({ surface: "tab:w2" })
  expect(current().inspectionInterrupted).toBe(true)
  await change({ surface: "tab:w3" })
  expect(current().inspectionInterrupted).toBe(false)
  await action((view) => view.followLive())
})

test("manual navigation cancels a delayed reveal before it can move the destination viewport", async () => {
  await mount({ transcript: longTranscript(100), tabs })
  await action((view) => view.inspectActivity(1))
  await change({ surface: "tab:w2" })
  const box = current().scroll.current!
  box.scrollTop = 0
  await drainReveal()
  expect(box.scrollTop).toBe(0)
  expect(current().activeInspection).toBeUndefined()
  await action((view) => view.followLive())
  await drainReveal()
  expect(box.scrollTop).toBe(0)
})

test("a new activity identity captures the current return position instead of a stale inspection origin", async () => {
  await mount({ transcript: longTranscript(100) })
  await action((view) => view.inspectActivity(1, false))
  await change({ transcript: longTranscript(500) })
  const box = current().scroll.current!
  box.scrollTop = 10
  const prior = box.scrollTop
  await action((view) => view.inspectActivity(1))
  expect(box.scrollTop).not.toBe(prior)
  await action((view) => view.followLive())
  await drainReveal()
  expect(box.scrollTop).toBe(prior)
})

test("ending inspection invalidates an earlier delayed reveal and restores the prior scroll", async () => {
  await mount({ transcript: longTranscript(100) })
  const prior = current().scroll.current!.scrollTop
  await action((view) => view.inspectActivity(1))
  await action((view) => view.followLive())
  const box = current().scroll.current!
  expect(box.scrollTop).toBe(prior)
  await drainReveal()
  expect(current().activeInspection).toBeUndefined()
  expect(box.scrollTop).toBe(prior)
})

test("restoring a new session with reused row IDs must invalidate the old delayed reveal", async () => {
  await mount({ transcript: longTranscript(100) })
  await action((view) => view.inspectActivity(1))
  await action((view) => view.clearInspection())
  await change({ transcript: longTranscript(500) })
  await action((view) => view.snapToLive())
  const box = current().scroll.current!
  const liveEdge = box.scrollHeight - box.viewport.height
  expect(current().activeInspection).toBeUndefined()
  expect(box.scrollTop).toBe(liveEdge)
  await drainReveal()
  expect(box.scrollTop).toBe(liveEdge)
})

test("inspection without jumping must invalidate a pending earlier scroll", async () => {
  await mount({ transcript: longTranscript(100) })
  await action((view) => view.inspectActivity(1))
  const box = current().scroll.current!
  box.scrollTop = box.scrollHeight
  const position = box.scrollTop
  await action((view) => view.inspectActivity(1, false))
  await drainReveal()
  expect(current().activeInspection?.seq).toBe(1)
  expect(box.scrollTop).toBe(position)
})

test("new activity identity fences a pending reveal even without an explicit clear", async () => {
  await mount({ transcript: longTranscript(100) })
  await action((view) => view.inspectActivity(1))
  await change({ transcript: longTranscript(500) })
  const box = current().scroll.current!
  box.scrollTop = box.scrollHeight
  const position = box.scrollTop
  await drainReveal()
  expect(current().activeInspection).toBeUndefined()
  expect(box.scrollTop).toBe(position)
})

test("unmount releases the scroll ref and pending reveal cannot change the destroyed viewport", async () => {
  await mount({ transcript: longTranscript(100) })
  const view = current()
  const box = view.scroll.current!
  await action((value) => value.inspectActivity(1))
  await act(async () => {
    setup!.renderer.destroy()
  })
  setup = undefined
  const position = box.scrollTop
  await drainReveal()
  expect(box.isDestroyed).toBe(true)
  expect(view.scroll.current).toBeNull()
  expect(box.scrollTop).toBe(position)
})

test("a later inspection retains its own target after both delayed deadlines", async () => {
  let transcript = running(100)
  transcript = Transcript.apply(
    transcript,
    new AgentEvent.CellProduced({ eventType: "flows.harness.cell-produced.v1", cell: Cell.source("1") }),
    102
  )
  for (let index = 0; index < 20; index++) {
    transcript = Transcript.note(transcript, `First update ${index}`, 103 + index)
  }
  transcript = Transcript.apply(
    transcript,
    new AgentEvent.TurnOpened({
      eventType: "flows.harness.turn-opened.v1",
      seat: "replay:test",
      modelParams: {},
      activeToolNames: [],
      contextDigest: "context-two"
    }),
    200
  )
  transcript = Transcript.apply(
    transcript,
    new AgentEvent.ModelDelta({
      eventType: "flows.harness.model-delta.v1",
      delta: { type: "text-delta", id: "next", text: "Next\n```js\n2\n```" }
    }),
    201
  )
  for (let index = 0; index < 20; index++) {
    transcript = Transcript.note(transcript, `Second update ${index}`, 202 + index)
  }
  await mount({ transcript })
  await action((view) => view.inspectActivity(1))
  await action((view) => view.inspectActivity(4))
  const position = current().scroll.current!.scrollTop
  await drainReveal()
  expect(current().activeInspection?.seq).toBe(4)
  expect(current().jumpTarget).toBe("chat:22")
  expect(current().scroll.current!.scrollTop).toBe(position)
  await setup!.renderOnce()
  expect(setup!.captureCharFrame()).toContain("chat:22")
})

const batchHistory = (count: number, parent?: string) => {
  let transcript = Transcript.empty
  const tabs: Tab[] = []
  for (let index = 0; index < count; index++) {
    transcript = Transcript.note(transcript, `ask ${index}`, index * 10)
    tabs.push({
      id: `child-${index}`,
      title: `Child ${index}`,
      prompt: "Work",
      seat: "replay:test",
      file: `child-${index}.jsonl`,
      status: "done",
      startedAt: index * 10 + 1,
      endedAt: index * 10 + 2,
      depth: parent === undefined ? 0 : 1,
      ...(parent === undefined ? {} : { parent })
    })
  }
  return { transcript, tabs }
}

test("earlier row joins native card focus only after ten batches and expands in its own conversation", async () => {
  const ten = batchHistory(10), eleven = batchHistory(11)
  await mount({ ...ten })
  expect(current().cardKeys).not.toContain("subagents:earlier")
  await change(eleven)
  expect(current().cardKeys[0]).toBe("subagents:earlier")
  expect(current().cardKeys).toHaveLength(11)
  await action((view) => view.setCardFocus("subagents:earlier"))
  expect(current().focusedCard).toBe("subagents:earlier")
  await action((view) => view.openEarlier())
  expect(current().lines.filter((line) => line.kind === "grid")).toHaveLength(11)
  expect(current().cardKeys).not.toContain("subagents:earlier")
  expect(current().focusedCard).toBeUndefined()
  await change({ conversation: "other-conversation" })
  expect(current().cardKeys[0]).toBe("subagents:earlier")
})

test("a worker's earlier row expands without opening the parent's batches or a main panel", async () => {
  const root = batchHistory(11), children = batchHistory(11, "parent")
  const parent: Tab = { ...tabs[0]!, id: "parent" }
  await mount({
    ...root,
    tabs: [...root.tabs, parent, ...children.tabs],
    worker: () => children.transcript,
    surface: "tab:parent",
    panel
  })
  expect(current().cardKeys).toEqual(["subagents:earlier:parent"])
  await action((view) => view.setCardFocus("subagents:earlier:parent"))
  expect(current().focusedCard).toBe("subagents:earlier:parent")
  await action((view) => view.openEarlier())
  expect(current().earlierOpen("parent")).toBe(true)
  expect(current().earlierOpen()).toBe(false)
  expect(current().cardKeys).toEqual([])
  expect(current().lines.some((line) => line.kind === "earlier")).toBe(true)
  await change({ surface: "chat", panel: undefined })
  expect(current().cardKeys[0]).toBe("subagents:earlier")
  await change({ surface: "tab:parent", panel: { ...panel, placement: "main" } })
  expect(current().cardKeys).toEqual([])
})

test("root and worker disclosures keep independent chrome, including a worker named chat and conversation switches", async () => {
  const root = batchHistory(11), children = batchHistory(11, "chat")
  const parent: Tab = { ...tabs[0]!, id: "chat" }
  await mount({ ...root, tabs: [...root.tabs, parent, ...children.tabs], worker: () => children.transcript })
  await action((view) => view.showEarlier())
  expect(current().earlierOpen()).toBe(true)
  expect(current().earlierOpen("chat")).toBe(false)
  await change({ surface: "tab:chat", panel })
  expect(current().cardKeys).toEqual(["subagents:earlier:chat"])
  await action((view) => view.openEarlier())
  expect(current().earlierOpen()).toBe(true)
  expect(current().earlierOpen("chat")).toBe(true)
  await change({ conversation: "other" })
  expect(current().earlierOpen()).toBe(false)
  expect(current().earlierOpen("chat")).toBe(false)
  await change({ conversation: "fixture-conversation" })
  expect(current().earlierOpen()).toBe(true)
  expect(current().earlierOpen("chat")).toBe(true)
})

test("growing from ten to eleven batches hides the oldest focus, and mouse expansion cannot revive it", async () => {
  const ten = batchHistory(10), eleven = batchHistory(11)
  await mount(ten)
  await action((view) => view.setCardFocus("agent:child-0"))
  expect(current().focusedCard).toBe("agent:child-0")
  await change(eleven)
  expect(current().focusedCard).toBeUndefined()
  expect(current().cardKeys).not.toContain("agent:child-0")
  await action((view) => view.showEarlier())
  expect(current().cardKeys).toContain("agent:child-0")
  expect(current().focusedCard).toBeUndefined()
  await change(ten)
  expect(current().lines.some((line) => line.kind === "earlier")).toBe(false)
})
