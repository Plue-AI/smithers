import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { Card } from "../state/AppState"
import { RunTraceBody } from "./RunTraceCard"

/*
 * The DevTools view (#2931): the node tree beside the selected node's
 * evidence, read off the shared projection over the journal the card holds.
 * Selection and the view are card payload changed through registered flows;
 * the pane holds no state, and a grown journal grows the tree and the frames
 * in place, because the card's subscription is the only source.
 */

GlobalRegistrator.register()
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mounted: Array<{ root: Root; host: HTMLElement }> = []
afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount())
    host.remove()
  }
})

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  await GlobalRegistrator.unregister()
})

const stamp = (sequence: number, kind: string, payload: Record<string, unknown>, at: number) => ({
  sequence,
  kind,
  occurredAt: at,
  payload: { ...payload, at }
})

const JOURNAL = [
  stamp(1, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, 1000),
  stamp(2, "control.agent.cell-produced", { language: "ts", text: "await ctx.call(\"files.read\", { path: \"README.md\" })" }, 1200),
  stamp(3, "control.agent.cell-call-started", { flowName: "files.read", input: { path: "README.md" } }, 1300),
  stamp(4, "control.agent.cell-call-settled", { flowName: "files.read", outcome: "success", value: "# Smithers" }, 1800),
  stamp(5, "control.agent.cell-call-started", { flowName: "target.run", input: { label: "//apps/app:unitTests" } }, 1900),
  stamp(6, "control.agent.cell-call-settled", { flowName: "target.run", outcome: "failure", message: "1 of 213 failed" }, 4300),
  stamp(7, "control.agent.cell-settled", { outcome: "success" }, 4400)
]
const LATER = [
  ...JOURNAL,
  stamp(8, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, 5000),
  stamp(9, "control.agent.cell-call-started", { flowName: "files.edit", input: { path: "src/x.ts" } }, 5100)
]

type RunCard = Extract<Card, { kind: "run-trace" }>
const runCard = (overrides: Partial<RunCard["payload"]>): RunCard => ({
  id: "flow-run-run-1",
  kind: "run-trace",
  title: "implement",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repo: "smithersai/smithers",
    runId: "run-1",
    workflow: "implement",
    phase: "running",
    steps: [],
    result: null,
    lastSeq: 1,
    traceView: "devtools",
    events: JOURNAL,
    ...overrides
  }
})

const render = (element: React.ReactElement, host: HTMLElement = document.createElement("div")): HTMLElement => {
  if (!host.isConnected) {
    document.body.append(host)
    const root = createRoot(host)
    mounted.push({ root, host })
    act(() => {
      root.render(element)
    })
    return host
  }
  const { root } = mounted.find((entry) => entry.host === host)!
  act(() => {
    root.render(element)
  })
  return host
}

const renderTrace = (overrides: Partial<RunCard["payload"]>, host?: HTMLElement) => {
  const dispatched: Array<{ name: string; args?: string }> = []
  const rendered = render(
    <RunTraceBody card={runCard(overrides)} onRunCommand={(name, args) => dispatched.push({ name, args })} />,
    host
  )
  return { host: rendered, dispatched }
}

const click = (element: Element | null): void => {
  act(() => {
    ;(element as HTMLElement).click()
  })
}

const nodes = (host: HTMLElement) => [...host.querySelectorAll("[data-devtools-node]")]
const labels = (host: HTMLElement) => nodes(host).map((node) => node.querySelector(".run-trace-label")?.textContent)

describe("the DevTools view", () => {
  test("lists every node of the fold with its status and timing, and inspects the newest frame while live", () => {
    const { host } = renderTrace({})
    const pane = host.querySelector("[data-testid='run-devtools-run-1']")!
    expect(pane).not.toBeNull()
    expect(host.querySelector(".run-trace")?.getAttribute("data-view")).toBe("devtools")
    expect(labels(host)).toEqual(["run run-1 · implement", "frame 1 · openai:gpt-5.6-sol", "cell · ts", "files.read", "target.run"])
    expect(nodes(host).map((node) => node.getAttribute("data-depth"))).toEqual(["0", "1", "2", "3", "3"])
    const failed = nodes(host).find((node) => node.getAttribute("data-devtools-node") === "call-2")!
    expect(failed.getAttribute("data-status")).toBe("failed")
    expect(failed.querySelector(".run-trace-status")?.textContent).toBe("failed")
    expect(failed.querySelector(".run-trace-duration")?.textContent).toBe("2.4s")
    const read = nodes(host).find((node) => node.getAttribute("data-devtools-node") === "call-1")!
    expect(read.querySelector(".run-trace-status")?.textContent).toBe("")
    expect(read.querySelector(".run-trace-duration")?.textContent).toBe("500ms")
    // Live tail: the newest frame is inspected without a selection.
    const inspect = host.querySelector("[data-testid='run-devtools-inspect-run-1']")!
    expect(inspect.getAttribute("data-span")).toBe("frame-1")
    expect(nodes(host).find((node) => node.getAttribute("aria-pressed") === "true")?.getAttribute("data-devtools-node")).toBe("frame-1")
    expect(inspect.querySelector(".run-trace-pane-title")?.textContent).toContain("frame · run run-1 · implement / frame 1 · openai:gpt-5.6-sol")
    const kv = [...inspect.querySelectorAll(".run-trace-kv dt")].map((dt) => dt.textContent)
    expect(kv).toEqual(["started", "duration", "seat", "journal", "children"])
    expect(host.querySelector("[data-testid='run-devtools-frames-run-1']")?.textContent).toBe("7")
    expect([...inspect.querySelectorAll("[data-frame]")].map((frame) => frame.getAttribute("data-frame"))).toEqual(["1", "2", "3", "4", "5", "6", "7"])
    expect(host.querySelector("[data-testid='run-trace-devtools-facts-run-1']")?.textContent).toBe("4 spans · 1 running · 1 failed · t = 3.4s")
  })

  test("a selected call shows its input, output or failure, fields and the frames written while it was open", () => {
    const { host } = renderTrace({ selection: "call-2", liveTail: false })
    const inspect = host.querySelector("[data-testid='run-devtools-inspect-run-1']")!
    expect(inspect.getAttribute("data-span")).toBe("call-2")
    expect(inspect.querySelector("[aria-label='Input']")?.textContent).toBe(JSON.stringify({ label: "//apps/app:unitTests" }, null, 2))
    expect(inspect.querySelector("[data-testid='run-trace-failure']")?.textContent).toContain("This call failed. Not your fault.")
    expect(inspect.querySelector("[aria-label='Output']")).toBeNull()
    expect([...inspect.querySelectorAll("[data-frame]")].map((frame) => frame.getAttribute("data-frame"))).toEqual(["5", "6"])
    expect(inspect.querySelector("[data-frame='6'] .run-devtools-payload")?.textContent).toContain("\"outcome\":\"failure\"")
    const read = renderTrace({ selection: "call-1", liveTail: false })
    const pane = read.host.querySelector("[data-testid='run-devtools-inspect-run-1']")!
    expect(pane.querySelector("[aria-label='Output']")?.textContent).toBe("# Smithers")
    expect(pane.querySelector("[data-testid='run-trace-failure']")).toBeNull()
    const cell = renderTrace({ selection: "cell-2", liveTail: false })
    const script = cell.host.querySelector("[data-testid='run-devtools-inspect-run-1'] [aria-label='Script']")
    expect(script?.textContent).toBe("await ctx.call(\"files.read\", { path: \"README.md\" })")
  })

  test("a node press selects it at the live tail, a second press returns to the run, and the bar returns to the timeline", () => {
    const { host, dispatched } = renderTrace({ selection: "call-1", liveTail: false })
    click(nodes(host).find((node) => node.getAttribute("data-devtools-node") === "call-2")!)
    expect(dispatched.at(-1)).toEqual({ name: "runs.trace.select", args: "sourceCard=flow-run-run-1 run-1 call-2 7" })
    click(nodes(host).find((node) => node.getAttribute("data-devtools-node") === "call-1")!)
    expect(dispatched.at(-1)).toEqual({ name: "runs.trace.select", args: "sourceCard=flow-run-run-1 run-1 run:run-1 7" })
    const bar = host.querySelector(".run-trace-bar[data-view='devtools']")!
    expect(bar.querySelector(".run-trace-bar-title")?.textContent).toBe("DevTools")
    click([...bar.querySelectorAll("button")].find((button) => button.textContent === "Timeline")!)
    expect(dispatched.at(-1)).toEqual({ name: "runs.trace.view", args: "sourceCard=flow-run-run-1 run-1 turns" })
  })

  test("the timeline bar offers DevTools, and the view survives as card payload", () => {
    const { host, dispatched } = renderTrace({ traceView: "turns" })
    expect(host.querySelector("[data-testid='run-devtools-run-1']")).toBeNull()
    const button = [...host.querySelectorAll(".run-trace-bar[data-view='turns'] button")].find((each) => each.textContent === "DevTools")!
    click(button)
    expect(dispatched.at(-1)).toEqual({ name: "runs.trace.view", args: "sourceCard=flow-run-run-1 run-1 devtools" })
  })

  test("a grown journal grows the tree and the frames in place, past any parked cursor", () => {
    const { host } = renderTrace({ cursorSeq: 3, liveTail: false, selection: "run:run-1" })
    expect(labels(host)).toHaveLength(5)
    expect(host.querySelector("[data-testid='run-devtools-frames-run-1']")?.textContent).toBe("7")
    renderTrace({ cursorSeq: 3, liveTail: false, selection: "run:run-1", events: LATER, phase: "running" }, host)
    expect(labels(host)).toEqual([
      "run run-1 · implement",
      "frame 1 · openai:gpt-5.6-sol",
      "cell · ts",
      "files.read",
      "target.run",
      "frame 2 · openai:gpt-5.6-sol",
      "files.edit"
    ])
    expect(host.querySelector("[data-testid='run-devtools-frames-run-1']")?.textContent).toBe("9")
    const open = nodes(host).find((node) => node.getAttribute("data-devtools-node") === "call-3")!
    expect(open.getAttribute("data-status")).toBe("running")
    expect(host.querySelector("[data-testid='run-trace-devtools-facts-run-1']")?.textContent).toBe("6 spans · 2 running · 1 failed · t = 4.1s")
    // The selection presses park the cursor at the newest sequence the card now holds.
    const dispatched: Array<{ name: string; args?: string }> = []
    const again = render(<RunTraceBody card={runCard({ events: LATER })} onRunCommand={(name, args) => dispatched.push({ name, args })} />, host)
    click(nodes(again).find((node) => node.getAttribute("data-devtools-node") === "call-3")!)
    expect(dispatched.at(-1)).toEqual({ name: "runs.trace.select", args: "sourceCard=flow-run-run-1 run-1 call-3 9" })
  })

  test("a run without a journal is the run alone", () => {
    const { host } = renderTrace({ events: [], phase: "launching" })
    expect(labels(host)).toEqual(["run run-1 · implement"])
    expect(host.querySelector("[data-testid='run-devtools-frames-run-1']")?.textContent).toBe("0")
    expect(host.querySelector(".run-devtools-frames")).toBeNull()
    expect(host.querySelector("[data-testid='run-trace-devtools-facts-run-1']")?.textContent).toBe("no journal yet")
  })
})
