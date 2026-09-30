/*
 * The run's graph, drawn.
 *
 * The card's own journal is the recorded one: `fixtures/GraphRunJournal.json`
 * is what a completed `gateway/GraphFixture` run wrote on the bridged stack,
 * so every node, edge and state word below is one the engine produced.
 *
 * The canvas is imported directly rather than through the card's Suspense
 * boundary, because that boundary is exactly what keeps xyflow out of the main
 * chunk: a card test that awaited the chunk would prove the opposite of what
 * the lazy import is for.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import dagre from "dagre"
import { readFileSync } from "node:fs"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import type { Card } from "../state/AppState"
import { FlowRunGraph, focusedRunNode, observedAtOf, runGraphOfCard } from "./FlowRunGraph"
import { FlowRunGraphSurface, layoutRunGraph, stateWord } from "./FlowRunGraphSurface"
import type { NodeRun, RunGraphEdge, RunGraphNode } from "./FlowGraphStatus"
import { RunTraceBody } from "./RunTraceCard"
import { graphEventsOf } from "./RunForest"

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
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT
  await GlobalRegistrator.unregister()
})

type RunTraceCard = Extract<Card, { kind: "run-trace" }>

interface Recorded {
  readonly flow: string
  readonly plan: NonNullable<RunTraceCard["payload"]["plan"]>
  readonly rows: Array<Record<string, unknown>>
}
const RECORDED: Recorded = JSON.parse(readFileSync(new URL("./fixtures/GraphRunJournal.json", import.meta.url), "utf8"))

const runCard = (payload: Partial<RunTraceCard["payload"]>): RunTraceCard => ({
  id: "flow-run-run-1",
  kind: "run-trace",
  title: RECORDED.flow,
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: {
    repo: "codeplanesmithers/smithers-demo",
    runId: "run-1",
    workflow: RECORDED.flow,
    phase: "running",
    steps: [],
    result: null,
    lastSeq: 1,
    ...payload
  }
})

const render = (element: React.ReactElement): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(element))
  return host
}

const drawn = (host: HTMLElement) => [...host.querySelectorAll("[data-node]")]
const wordOf = (element: Element): string | undefined =>
  element.querySelector(".flow-graph-node-word")?.textContent ?? undefined

const node = (id: string, dependsOn: ReadonlyArray<string> = [], over: Partial<RunGraphNode> = {}): RunGraphNode => ({
  id,
  kind: "ActionCall",
  dependsOn,
  tier: "sealed",
  ...over
})

test("graph at a retained cursor shows only evidence available before settlement", () => {
  const nodeId = "root.flow.then.map.all.steady"
  const card = runCard({ plan: RECORDED.plan, events: RECORDED.rows, cursorSeq: 37, liveTail: false, traceView: "graph" })
  const view = runGraphOfCard(card)!
  expect(view.status.get(nodeId)?.status).toBe("running")
  expect(view.status.get(nodeId)?.result).toBeUndefined()
  const visible = graphEventsOf(card)
  expect(visible.every((row) => typeof row.sequence === "number" && row.sequence <= 37)).toBe(true)
  expect(visible.length).toBeLessThan(RECORDED.rows.length)
  expect(visible.some((row) => row.sequence === 38)).toBe(false)
  expect(observedAtOf(visible)).toBeLessThan(observedAtOf(RECORDED.rows)!)
  const host = render(<FlowRunGraphSurface nodes={view.nodes} edges={view.edges} status={view.status} />)
  expect(host.querySelector(`[data-node="${nodeId}"]`)?.getAttribute("data-state")).toBe("running")
  const latest = runGraphOfCard(runCard({ ...card.payload, cursorSeq: undefined, liveTail: true }))!
  expect(latest.status.get(nodeId)?.outcome).toBe("built")
})

test("a selected node keeps its historical events on reload and returns to Latest", () => {
  const nodeId = "root.flow.then.map.all.steady"
  const payload = { plan: RECORDED.plan, events: RECORDED.rows, cursorSeq: 37, liveTail: false, traceView: "graph" as const,
    graph: { node: nodeId, tab: "events" as const } }
  const card = runCard(payload)
  const view = runGraphOfCard(card)!
  const records = graphEventsOf(card)
  const host = render(<FlowRunGraphSurface nodes={view.nodes} edges={view.edges} status={view.status}
    records={records} observedAt={observedAtOf(records)} frozenClock
    executionId={view.executionId}
    drill={{ repo: card.payload.repo, doors: { select: "runs.graph.select", tab: "runs.graph.tab", target: "run-1" },
      selected: nodeId, tab: "events", files: [], onRunCommand: () => {} }} />)
  expect(host.querySelector(`[data-node="${nodeId}"]`)?.getAttribute("data-state")).toBe("running")
  expect([...host.querySelectorAll(".flow-graph-events li")].map((row) => row.querySelector(".flow-graph-event-type")?.textContent))
    .toEqual(["node-scheduled"])
  expect(host.textContent).not.toContain("steady:recorded")
  const reloaded = runGraphOfCard(runCard({ ...payload }))!
  expect(reloaded.status.get(nodeId)?.status).toBe("running")
  const latest = runGraphOfCard(runCard({ ...payload, cursorSeq: undefined, liveTail: true }))!
  expect(latest.status.get(nodeId)?.outcome).toBe("built")
  expect(graphEventsOf(runCard({ ...payload, cursorSeq: undefined })).some((row) => row.sequence === 38)).toBe(true)
})

test("a running node ticks without another engine event and stops when it settles", () => {
  let now = 0
  let tick: (() => void) | undefined
  const clock = spyOn(performance, "now").mockImplementation(() => now)
  const intervals = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
    tick = callback
    return 123
  }) as typeof setInterval)
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {})
  try {
    const nodes = [node("a")]
    const host = render(<FlowRunGraphSurface nodes={nodes} edges={[]} observedAt={1000}
      status={new Map([["a", { status: "running", attempts: 1, startedAt: 1000 }]])} />)
    const root = mounted.at(-1)!.root
    act(() => { now = 2000; tick?.() })
    expect(host.querySelector(".flow-graph-node-eta")?.textContent).toBe("2.0s")
    act(() => root.render(<FlowRunGraphSurface nodes={nodes} edges={[]} observedAt={3000}
      status={new Map([["a", { status: "settled", outcome: "built", attempts: 1, startedAt: 1000, settledAt: 3000 }]])} />))
    expect(clear).toHaveBeenCalledWith(123)
    act(() => { now = 10000; tick?.() })
    expect(host.querySelector(".flow-graph-node-eta")?.textContent).toBe("2.0s")
  } finally { clock.mockRestore(); intervals.mockRestore(); clear.mockRestore() }
})

test("status, timing, and selection updates decorate a stable topology without running dagre", () => {
  const layout = spyOn(dagre, "layout")
  try {
    const nodes = [node("a"), node("b", ["a"])]
    const edges: RunGraphEdge[] = [{ from: "a", to: "b", reason: "value" }]
    const host = render(<FlowRunGraphSurface nodes={nodes} edges={edges} status={new Map()} />)
    const root = mounted.at(-1)!.root
    expect(layout).toHaveBeenCalledTimes(1)
    act(() => root.render(<FlowRunGraphSurface nodes={nodes.map(n => ({ ...n }))} edges={edges.map(e => ({ ...e }))}
      status={new Map([["a", { status: "running", attempts: 1, startedAt: 1000 }]])} observedAt={2000} />))
    expect(wordOf(drawn(host)[0]!)).toBe("running")
    expect(layout).toHaveBeenCalledTimes(1)
    act(() => root.render(<FlowRunGraphSurface nodes={[...nodes, node("c", ["b"])]}
      edges={[...edges, { from: "b", to: "c", reason: "value" }]} status={new Map()} />))
    expect(layout).toHaveBeenCalledTimes(2)
  } finally { layout.mockRestore() }
})

describe("the run graph's layout", () => {
  const nodes = [node("a"), node("b", ["a"]), node("c", ["a"])]
  const edges: ReadonlyArray<RunGraphEdge> = [
    { from: "a", to: "b", reason: "value" },
    { from: "a", to: "c", reason: "continuation" }
  ]

  test("ranks top to bottom, at whole pixels (D-034)", () => {
    const laid = layoutRunGraph(nodes, edges, new Map())
    const at = new Map(laid.nodes.map((drawn) => [drawn.id, drawn.position]))
    expect(at.get("b")!.y).toBeGreaterThan(at.get("a")!.y)
    expect(at.get("c")!.y).toBe(at.get("b")!.y)
    expect(laid.nodes.every((drawn) => Number.isInteger(drawn.position.x) && Number.isInteger(drawn.position.y))).toBe(true)
    // The same graph twice is the same bytes, so a poll that changed nothing
    // re-renders nothing.
    expect(layoutRunGraph(nodes, edges, new Map())).toEqual(laid)
  })

  test("drops an edge naming a node this graph does not carry, and draws each edge once", () => {
    const laid = layoutRunGraph(nodes, [...edges, ...edges, { from: "a", to: "ghost", reason: "failure" }], new Map())
    expect(laid.edges.map((edge) => edge.id)).toEqual(["a->b", "a->c"])
    expect(laid.edges.map((edge) => edge.className)).toEqual([
      "flow-graph-edge flow-graph-edge-value",
      "flow-graph-edge flow-graph-edge-continuation"
    ])
  })

  /* An edge whose source stated no reason is drawn, and says nothing about
   * why: there is no class and no datum for a reason nobody gave. */
  test("an unlabelled edge wears the base class alone and carries no reason", () => {
    const laid = layoutRunGraph(nodes, [{ from: "a", to: "b" }], new Map())
    expect(laid.edges.map((edge) => edge.className)).toEqual(["flow-graph-edge"])
    expect(laid.edges[0]?.data.reason).toBeUndefined()
  })

  /* The three things a node says about itself, in the order the box shows
   * them: the action it dispatches, the id it was keyed under, and the word
   * it is at (flowGraph/NodeAria.ts). */
  test("labels every node with what it dispatches, its id and the word for its state", () => {
    const status = new Map<string, NodeRun>([["a", { status: "settled", outcome: "failed", attempts: 1 }]])
    const laid = layoutRunGraph([node("a", [], { action: "graph/Doomed" })], [], status)
    expect(laid.nodes[0]?.ariaLabel).toBe("graph/Doomed a failed")
  })

  test("says pending for a node no record has named, and never nothing (D-026)", () => {
    expect(stateWord(undefined)).toBe("pending")
    expect(stateWord({ status: "running", attempts: 1 })).toBe("running")
    expect(stateWord({ status: "unproven", attempts: 0 })).toBe("unproven")
    expect(stateWord({ status: "settled", outcome: "clean", attempts: 1 })).toBe("clean")
  })
})

describe("what a run card can draw", () => {
  test("nothing at all before a plan or a record arrives", () => {
    expect(runGraphOfCard(runCard({}))).toBeUndefined()
    expect(runGraphOfCard(runCard({ events: [] }))).toBeUndefined()
  })

  test("the launch's plan, before the first event", () => {
    const view = runGraphOfCard(runCard({ plan: RECORDED.plan }))
    expect(view?.nodes.map((node) => node.id)).toEqual(RECORDED.plan.nodes.map((node) => node.id))
    /*
     * This snapshot carries no labelled edges, so `dependsOn` is the whole
     * edge set it can draw — and `dependsOn` states no reason. Every edge is
     * drawn and none of them claims one.
     */
    expect(view?.edges.length).toBeGreaterThan(0)
    expect(view?.edges.every((edge) => edge.reason === undefined)).toBe(true)
    expect(view?.edges.some((edge) => "reason" in edge)).toBe(false)
    expect(view?.status.size).toBe(0)
    expect(view?.focusId).toBeUndefined()
  })

  /*
   * The same answer the plan door decodes carries the reasons and the
   * declaration sites (ControlSchema.PlanGraph). A launch that kept them puts
   * both on the card, so the graph drawn before the first event says why each
   * node waits and the drawer can open the code.
   */
  test("the labelled edges and declaration sites the launch snapshotted", () => {
    const [first, second] = RECORDED.plan.nodes
    const view = runGraphOfCard(runCard({
      plan: {
        ...RECORDED.plan,
        nodes: [first!, second!],
        graph: {
          edges: [{ from: first!.id, to: second!.id, reason: "continuation" }],
          nodes: [{ id: first!.id, declaredAt: { path: "gateway/GraphFixture.ts", line: 12 } }]
        }
      }
    }))
    expect(view?.edges).toEqual([{ from: first!.id, to: second!.id, reason: "continuation" }])
    expect(view?.nodes.find((node) => node.id === first!.id)?.declaredAt)
      .toEqual({ path: "gateway/GraphFixture.ts", line: 12 })
    // A node the builder placed nowhere carries no site rather than a guess.
    expect(view?.nodes.find((node) => node.id === second!.id)).not.toHaveProperty("declaredAt")
  })

  test("a snapshot that labelled nothing draws dependsOn, and never both edge sets", () => {
    const [first, second] = RECORDED.plan.nodes
    const view = runGraphOfCard(runCard({
      plan: { ...RECORDED.plan, nodes: [first!, second!], graph: { edges: [] } }
    }))
    expect(view?.edges).toEqual(second!.dependsOn.map((from) => ({ from, to: second!.id })))
  })

  test("the graph the engine recorded, once its records land", () => {
    const view = runGraphOfCard(runCard({ plan: RECORDED.plan, events: RECORDED.rows }))
    expect(view?.nodes.map((node) => node.id).sort()).toEqual(RECORDED.plan.nodes.map((node) => node.id).sort())
    // Recorded edges carry the reason the builder drew them, which no plan does.
    expect(new Set(view?.edges.map((edge) => edge.reason))).toEqual(new Set(["value", "continuation", "failure"]))
    expect([...view?.status.values() ?? []].every((run) => run.status === "settled")).toBe(true)
  })

  test("the graph of a run launched elsewhere, joined by the flow it ran", () => {
    const view = runGraphOfCard(runCard({ events: RECORDED.rows }))
    expect(view?.nodes.map((node) => node.id).sort()).toEqual(RECORDED.plan.nodes.map((node) => node.id).sort())
  })

  test("points the camera at the node the run is on, not at what is waiting for it", () => {
    const settled = new Set(["flows.engine.node-settled"])
    const running = RECORDED.rows.filter((row) =>
      row.kind !== "control.engine.event" ||
      !settled.has(String((row.payload as { eventType?: string }).eventType))
    )
    const view = runGraphOfCard(runCard({ plan: RECORDED.plan, events: running }))
    const focus = view?.status.get(view.focusId ?? "")
    expect(focus?.status).toBe("running")
    /*
     * Every settlement stripped, so the whole recorded graph reads running at
     * once: the containment case at its widest. Ten of the eleven are waiting
     * on another running node, and the gate is the one they are all waiting
     * on, so the gate is where the run is.
     */
    expect(view?.focusId).toBe("root.flow.andThen")
    // And it is not the NEWEST: the fan-out's arms carry later stamps, and
    // every one of them is waiting on this node.
    const started = [...view?.status.values() ?? []].map((run) => run.startedAt ?? 0)
    expect(focus?.startedAt).toBeLessThan(Math.max(...started))
  })

  /*
   * The camera on a parked run, which is what the flow-graph tier drives: a
   * gate waiting for a person, and the two compositions that are running only
   * because it is. `root` waits on `root.flow` waits on the gate, and the
   * engine stamps all three inside the same millisecond, so "the newest
   * running node" was a coin toss between the gate and `root` — and `root` is
   * the flow's own box, which frames nothing a reader came for.
   */
  test("a container waiting on a running node is never where the run is", () => {
    // The three nodes a parked gate really leaves running, with the engine's
    // own stamps tied to the millisecond, which is how it stamps them.
    const at = 1_700_000_000_000
    const parked = [
      node("root.flow.andThen", [], { kind: "HumanTask" }),
      node("root.flow", ["root.flow.andThen"]),
      node("root", ["root.flow"])
    ]
    const running = new Map(parked.map((each): [string, NodeRun] => [
      each.id,
      { status: "running", startedAt: at, attempts: 1 }
    ]))
    expect(focusedRunNode(parked, running)).toBe("root.flow.andThen")
    // Untied, a container that started FIRST still loses: waiting on a
    // running node is what disqualifies it, not its stamp.
    expect(focusedRunNode(parked, new Map(parked.map((each, index): [string, NodeRun] => [
      each.id,
      { status: "running", startedAt: at - index, attempts: 1 }
    ])))).toBe("root.flow.andThen")
  })

  /* A fan-out is the case the "started last" rule is for, and it is untouched. */
  test("among arms that wait on nothing running, the camera takes the newest", () => {
    const gate = node("gate")
    const arms = ["steady", "retried", "cached"].map((id) => node(id, ["gate"]))
    const status = new Map<string, NodeRun>([
      ["gate", { status: "settled", outcome: "built", attempts: 1 }],
      ["steady", { status: "running", startedAt: 10, attempts: 1 }],
      ["retried", { status: "running", startedAt: 30, attempts: 1 }],
      ["cached", { status: "running", startedAt: 20, attempts: 1 }]
    ])
    expect(focusedRunNode([gate, ...arms], status)).toBe("retried")
  })

  test("nothing running leaves the whole graph in frame", () => {
    expect(focusedRunNode([node("a")], new Map())).toBeUndefined()
  })
})

describe("the clock a running node measures against", () => {
  const emitted = (row: Record<string, unknown>): number | undefined => {
    const at = (row.payload as { emittedAtMs?: unknown }).emittedAtMs
    return typeof at === "number" ? at : undefined
  }

  test("is the engine's, not the moment the control plane wrote the row down", () => {
    const engine = Math.max(...RECORDED.rows.flatMap((row) =>
      row.kind === "control.engine.event" && emitted(row) !== undefined ? [emitted(row)!] : []))
    const written = Math.max(...RECORDED.rows.flatMap((row) =>
      typeof row.occurredAt === "number" ? [row.occurredAt] : []))
    /* The recording carries both clocks, and they differ: every row was
     * written after the engine emitted it. A node's `startedAt` is the
     * engine's, so measuring elapsed against the write time would overstate
     * it by the journal's lag. */
    expect(written).toBeGreaterThan(engine)
    expect(observedAtOf(RECORDED.rows)).toBe(engine)
  })

  test("falls back to the newest row read when no engine envelope carries one", () => {
    expect(observedAtOf([{ kind: "control.run.status", occurredAt: 7 }, { kind: "control.run.status", occurredAt: 9 }])).toBe(9)
    expect(observedAtOf([])).toBeUndefined()
    expect(observedAtOf()).toBeUndefined()
  })
})

describe("the run graph, drawn", () => {
  const view = () => runGraphOfCard(runCard({ plan: RECORDED.plan, events: RECORDED.rows }))!

  test("draws one node per recorded node, each headed by its action tag with its id beneath (D-040)", () => {
    const drawing = view()
    const host = render(
      <FlowRunGraphSurface nodes={drawing.nodes} edges={drawing.edges} status={drawing.status} />
    )
    const rendered = drawn(host)
    expect(rendered).toHaveLength(RECORDED.plan.nodes.length)
    const steady = host.querySelector("[data-node=\"root.flow.then.map.all.steady\"]")!
    expect(steady.textContent).toContain("gateway/graph/Steady")
    expect(steady.querySelector(".flow-run-node-id")?.textContent).toBe("root.flow.then.map.all.steady")
  })

  test("wears the recorded state as a word on every node, not colour alone (D-026)", () => {
    const drawing = view()
    const host = render(
      <FlowRunGraphSurface nodes={drawing.nodes} edges={drawing.edges} status={drawing.status} />
    )
    expect(drawn(host).every((element) => wordOf(element) !== undefined && wordOf(element) !== "")).toBe(true)
    expect(wordOf(host.querySelector("[data-node=\"root.flow.then.map.all.recovered.protected\"]")!)).toBe("failed")
    expect(wordOf(host.querySelector("[data-node=\"root.flow.then.map.all.steady\"]")!)).toBe("built")
    // The word and the attribute say the same thing, so CSS never carries the state alone.
    expect(host.querySelector("[data-node=\"root.flow.then.map.all.steady\"]")?.getAttribute("data-state")).toBe("built")
  })

  test("names an attempt only where the engine numbered more than one", () => {
    const drawing = view()
    const host = render(
      <FlowRunGraphSurface nodes={drawing.nodes} edges={drawing.edges} status={drawing.status} />
    )
    // One node of this run retried, and its settlement carries the engine's
    // own count of its dispatches. Every other node ran once and is unmarked,
    // so the badge is evidence rather than decoration.
    const marked = [...host.querySelectorAll(".flow-run-node-attempt")].map((badge) => badge.textContent)
    expect(marked).toEqual(["attempt 2"])
  })

  test("a settled node wears what it really took, not what history predicts", () => {
    const drawing = view()
    const run = drawing.status.get("root.flow.then.map.all.steady")!
    const host = render(
      <FlowRunGraphSurface
        nodes={drawing.nodes}
        edges={drawing.edges}
        status={drawing.status}
        durations={[{
          id: "o/r:gateway/GraphFixture:gateway/graph/Steady",
          repo: "codeplanesmithers/smithers-demo",
          flowId: RECORDED.flow,
          actionTag: "gateway/graph/Steady",
          samples: 9,
          p50Ms: 60_000,
          p90Ms: 70_000,
          loadedAt: 0
        }]}
      />
    )
    const shown = host.querySelector("[data-node=\"root.flow.then.map.all.steady\"] .flow-graph-node-eta")
    // The recording timed this node at 4ms, and the row above predicts a
    // minute: a node that has run states the measurement, never the guess.
    expect(shown?.textContent).toBe(`${run.settledAt! - run.startedAt!}ms`)
  })

  test("a node with no record and no history wears no time at all", () => {
    const drawing = runGraphOfCard(runCard({ plan: RECORDED.plan }))!
    const host = render(
      <FlowRunGraphSurface nodes={drawing.nodes} edges={drawing.edges} status={drawing.status} />
    )
    expect(host.querySelectorAll(".flow-graph-node-eta")).toHaveLength(0)
    expect(host.textContent).not.toContain("measured")
  })

  test("a node that has not run states what its history says it takes", () => {
    const drawing = runGraphOfCard(runCard({ plan: RECORDED.plan }))!
    const host = render(
      <FlowRunGraphSurface
        nodes={drawing.nodes}
        edges={drawing.edges}
        status={drawing.status}
        durations={[{
          id: "o/r:gateway/GraphFixture:gateway/graph/Steady",
          repo: "codeplanesmithers/smithers-demo",
          flowId: RECORDED.flow,
          actionTag: "gateway/graph/Steady",
          samples: 9,
          p50Ms: 60_000,
          p90Ms: 70_000,
          loadedAt: 0
        }]}
      />
    )
    const shown = host.querySelector("[data-node=\"root.flow.then.map.all.steady\"] .flow-graph-node-eta")
    expect(shown?.textContent).toBe("~1m00s")
    expect(shown?.getAttribute("title")).toBe("p50 of 9 runs · p90 1m10s")
    // Only the node whose tag was measured; the rest say nothing.
    expect(host.querySelectorAll(".flow-graph-node-eta")).toHaveLength(1)
  })

  /** The recording with every settlement withheld: the run, mid-flight. */
  const midFlight = () => {
    const rows = RECORDED.rows.filter((row) =>
      row.kind !== "control.engine.event" ||
      String((row.payload as { eventType?: string }).eventType) !== "flows.engine.node-settled"
    )
    return runGraphOfCard(runCard({ plan: RECORDED.plan, events: rows }))!
  }

  const steadyRow = (p50Ms: number, p90Ms: number) => ({
    id: "o/r:gateway/GraphFixture:gateway/graph/Steady",
    repo: "codeplanesmithers/smithers-demo",
    flowId: RECORDED.flow,
    actionTag: "gateway/graph/Steady",
    samples: 9,
    p50Ms,
    p90Ms,
    loadedAt: 0
  })

  test("a running node fills a bar with what has elapsed against its own p50", () => {
    const drawing = midFlight()
    const started = drawing.status.get("root.flow.then.map.all.steady")!.startedAt!
    const host = render(
      <FlowRunGraphSurface
        nodes={drawing.nodes}
        edges={drawing.edges}
        status={drawing.status}
        durations={[steadyRow(1_000, 2_500)]}
        observedAt={started + 500}
      />
    )
    const node = host.querySelector("[data-node=\"root.flow.then.map.all.steady\"]")!
    expect(node.querySelector(".flow-graph-node-eta")?.textContent).toBe("of ~1.0s")
    expect((node.querySelector(".flow-run-node-bar") as HTMLElement | null)?.style.getPropertyValue("--flow-run-fill")).toBe("0.5")
  })

  test("past the p90 the prediction is overtaken, so the node shows the elapsed time alone", () => {
    const drawing = midFlight()
    const started = drawing.status.get("root.flow.then.map.all.steady")!.startedAt!
    const host = render(
      <FlowRunGraphSurface
        nodes={drawing.nodes}
        edges={drawing.edges}
        status={drawing.status}
        durations={[steadyRow(1_000, 2_500)]}
        observedAt={started + 5_000}
      />
    )
    const node = host.querySelector("[data-node=\"root.flow.then.map.all.steady\"]")!
    expect(node.querySelector(".flow-graph-node-eta")?.textContent).toBe("5.0s")
    expect(node.querySelector(".flow-run-node-bar")).toBeNull()
  })

  test("a running node with no measured history shows elapsed time without a prediction bar", () => {
    const drawing = midFlight()
    const started = drawing.status.get("root.flow.then.map.all.steady")!.startedAt!
    const host = render(
      <FlowRunGraphSurface nodes={drawing.nodes} edges={drawing.edges} status={drawing.status} observedAt={started + 500} />
    )
    expect(host.querySelectorAll(".flow-run-node-bar")).toHaveLength(0)
    expect(host.querySelector('[data-node="root.flow.then.map.all.steady"] .flow-graph-node-eta')?.textContent).toBe("500ms")
  })

  /**
   * The recording with one node never scheduled and settled `skipped`: the
   * engine's own word for work it decided not to do.
   */
  const skippedSteady = () => {
    const rows = RECORDED.rows.flatMap((row) => {
      const envelope = row.payload as { eventType?: string; payload?: Record<string, unknown> }
      if (envelope.payload?.["nodeId"] !== "root.flow.then.map.all.steady") return [row]
      // A skipped node was never scheduled, so its records carry no start.
      if (envelope.eventType === "flows.engine.node-scheduled") return []
      return envelope.eventType === "flows.engine.node-settled"
        ? [{ ...row, payload: { ...envelope, payload: { ...envelope.payload, outcome: "skipped" } } }]
        : [row]
    })
    return runGraphOfCard(runCard({ plan: RECORDED.plan, events: rows }))!
  }

  test("a node that settled `skipped` claims no time, because it never ran (D-032)", () => {
    const drawing = skippedSteady()
    const run = drawing.status.get("root.flow.then.map.all.steady")!
    expect(run.outcome).toBe("skipped")
    expect(run.startedAt).toBeUndefined()
    const host = render(
      <FlowRunGraphSurface
        nodes={drawing.nodes}
        edges={drawing.edges}
        status={drawing.status}
        durations={[steadyRow(60_000, 70_000)]}
      />
    )
    const node = host.querySelector("[data-node=\"root.flow.then.map.all.steady\"]")!
    expect(wordOf(node)).toBe("skipped")
    // The prediction belongs to a node that has yet to run. This one is over.
    expect(node.querySelector(".flow-graph-node-eta")).toBeNull()
    expect(node.textContent).not.toContain("1m00s")
    // Every other node of this recording settled with both ends timed, so it
    // still states the measurement the prediction never replaces.
    expect(host.querySelectorAll(".flow-graph-node-eta")).toHaveLength(drawing.nodes.length - 1)
  })

  test("an empty graph draws nothing", () => {
    expect(render(<FlowRunGraphSurface nodes={[]} edges={[]} status={new Map()} />).innerHTML).toBe("")
  })
})

describe("the run card's graph door", () => {
  const renderTrace = (payload: Partial<RunTraceCard["payload"]>) => {
    const dispatched: Array<{ name: string; args?: string }> = []
    const host = render(
      <RunTraceBody
        card={runCard(payload)}
        onRunCommand={(name, args) => dispatched.push({ name, args })}
      />
    )
    return { host, dispatched }
  }
  const viewButtons = (host: HTMLElement) =>
    [...host.querySelectorAll(".run-trace-view")].map((button) => button.textContent)

  test("is absent for a run with neither a plan nor a recorded graph", () => {
    const { host } = renderTrace({ traceView: "turns", events: [] })
    expect(viewButtons(host)).not.toContain("Graph")
  })

  test("is present once the run has nodes, and asks for the graph view", () => {
    const { host, dispatched } = renderTrace({ traceView: "turns", plan: RECORDED.plan })
    expect(viewButtons(host)).toEqual(["Details", "Steps", "Graph", "DevTools"])
    act(() => (host.querySelector("[data-flow-args=\"run-1 graph\"]") as HTMLElement).click())
    // The card seam stamps the source card onto every act it raises.
    expect(dispatched).toEqual([{ name: "runs.trace.view", args: "sourceCard=flow-run-run-1 run-1 graph" }])
  })

  test("the graph view draws the canvas, and offers the way back and the camera", () => {
    const { host, dispatched } = renderTrace({ traceView: "graph", plan: RECORDED.plan, events: RECORDED.rows })
    expect(host.querySelector(".run-trace-bar[data-view=\"graph\"]")).not.toBeNull()
    expect(viewButtons(host)).toEqual(["Turns"])
    const follow = host.querySelector("[data-flow=\"runs.graph.follow\"]") as HTMLElement
    expect(follow.getAttribute("data-flow-args")).toBe("run-1 off")
    act(() => follow.click())
    expect(dispatched).toEqual([{ name: "runs.graph.follow", args: "sourceCard=flow-run-run-1 run-1 off" }])
  })

  test("a camera already on offers to turn it off", () => {
    const { host } = renderTrace({ traceView: "graph", plan: RECORDED.plan, graph: { follow: true } })
    expect((host.querySelector("[data-flow=\"runs.graph.follow\"]") as HTMLElement).getAttribute("data-flow-args"))
      .toBe("run-1 off")
  })

  test("the forest: a child execution is a node whose drawer opens it in place, and the opened one leads back up", () => {
    const gate = "c7eac2d2567599c2bcbcbaa35ac4e07acf21e6e01c23753262361a60a7e0f07d"
    const { host, dispatched } = renderTrace({ traceView: "graph", plan: RECORDED.plan, events: RECORDED.rows,
      graph: { node: `exec:${gate}` } })
    const node = host.querySelector(`[data-node="exec:${gate}"]`)!
    expect(node.getAttribute("data-forest")).toBe("flow")
    expect(node.querySelector(".flow-run-node-id")?.textContent).toBe("flow")
    expect(wordOf(node)).toBe("done")
    const open = [...host.querySelectorAll(".flow-graph-drawer button")].find((button) => button.textContent === "Open") as HTMLElement
    act(() => open.click())
    expect(dispatched).toEqual([{ name: "runs.graph.execution", args: `sourceCard=flow-run-run-1 run-1 ${gate}` }])
    const inside = renderTrace({ traceView: "graph", plan: RECORDED.plan, events: RECORDED.rows, graph: { execution: gate } }).host
    expect(inside.querySelector('[data-node="root.flow"]')?.textContent).toContain("gateway/graph/Ask")
    /* Up to GraphFixture's own execution, down to Ask: Gate's only child. */
    expect([...inside.querySelectorAll("[data-forest]")].map((drawn) => drawn.getAttribute("data-node")).sort()).toEqual([
      "exec:4a0aecfbb21495fde89acbe6a57600012dd57ff64e2034095bd56dd2b537d55e",
      "exec:ddcd621539b72b2d3afc7e9b441375c887e57854122ac9745667192c63bf0b31"
    ])
  })

  test("a graph asked for by a run that has none falls back to its turns", () => {
    const { host } = renderTrace({ traceView: "graph", plan: { ...RECORDED.plan, nodes: [] } })
    expect(host.querySelector(".run-trace-bar[data-view=\"graph\"]")).toBeNull()
    expect(host.querySelector(".run-trace-empty")).not.toBeNull()
  })
})


test("run graph timings follow the card's workspace when the same component changes scope", async () => {
  const history = [undefined, "ws-1", "ws-2"].map((workspaceId, index) => ({
    id: `timing-${index}`, repo: "codeplanesmithers/smithers-demo", flowId: RECORDED.flow, workspaceId,
    actionTag: "gateway/graph/Steady", samples: 4, p50Ms: (index + 1) * 1000, p90Ms: (index + 1) * 2000, loadedAt: 0
  }))
  const base = runCard({ plan: RECORDED.plan })
  const drawing = runGraphOfCard(base)!
  const host = render(<FlowRunGraph card={base} view={drawing} flowDurations={history} onRunCommand={() => {}} />)
  const root = mounted.at(-1)!.root
  for (const [workspaceId, expected] of [[undefined, "~1.0s"], ["ws-1", "~2.0s"], ["ws-2", "~3.0s"], ["unmeasured", undefined]] as const) {
    await act(async () => root.render(<FlowRunGraph card={{ ...base, payload: { ...base.payload, workspaceId } }} view={drawing} flowDurations={history} onRunCommand={() => {}} />))
    expect(host.querySelector('[data-node="root.flow.then.map.all.steady"] .flow-graph-node-eta')?.textContent).toBe(expected)
  }
})
