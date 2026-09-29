/*
 * The run forest around one run's graph.
 *
 * The executions come from the recorded `gateway/GraphFixture` run
 * (`fixtures/GraphRunJournal.json`): GraphFixture launched `gateway/graph/Gate`
 * from its node whose action names that flow, and Gate launched
 * `gateway/graph/Ask`. The POC lane comes from the recorded coding run
 * (`fixtures/CodingPocHostDecisions.ndjson`), where `coding/Request` launched
 * `coding/Poc`.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { Card } from "../state/AppState"
import { drawnGraphOf, executionNodeId, runForestOf, runNodeId } from "./RunForest"

type RunCard = Extract<Card, { kind: "run-trace" }>

type Row = Record<string, unknown>
const RECORDED: { readonly flow: string; readonly rows: ReadonlyArray<Row> } =
  JSON.parse(readFileSync(new URL("./fixtures/GraphRunJournal.json", import.meta.url), "utf8"))
const POC_ROWS: ReadonlyArray<Row> = readFileSync(new URL("./fixtures/CodingPocHostDecisions.ndjson", import.meta.url), "utf8")
  .trim().split("\n").map((line) => JSON.parse(line))

const GATE = "c7eac2d2567599c2bcbcbaa35ac4e07acf21e6e01c23753262361a60a7e0f07d"
const ASK = "ddcd621539b72b2d3afc7e9b441375c887e57854122ac9745667192c63bf0b31"

const runCard = (payload: Partial<RunCard["payload"]>, id = "flow-run-run-1"): RunCard => ({
  id, kind: "run-trace", title: RECORDED.flow, status: "active", createdAt: 0, ordinal: 0,
  payload: { repo: "smithersai/smithers", runId: "run-1", workflow: RECORDED.flow, phase: "completed", steps: [], result: null, lastSeq: 1, ...payload }
})

const forestOf = (card: RunCard, cards: ReadonlyArray<Card> = []) => {
  const { drawn, defaultExecutionId } = drawnGraphOf(card)
  return runForestOf(card, cards, { nodes: drawn?.nodes ?? [], edges: drawn?.edges ?? [] }, drawn?.executionId, defaultExecutionId)
}

const at = (sequence: number, kind: string, payload: Row): Row =>
  ({ sequence, kind, occurredAt: sequence, payload: { ...payload, at: sequence, journalVersion: 1 } })

/* One successful `agent/spawn`: the only record that makes a child run (RunTrace.ts). */
const SPAWN = [
  at(1, "control.agent.turn-opened", {}),
  at(2, "control.agent.cell-produced", { text: "await ctx.call('agent/spawn')" }),
  at(3, "control.agent.cell-call-started", { flowName: "agent/spawn", input: { flow: "review" } }),
  at(4, "control.agent.cell-call-settled", { flowName: "agent/spawn", outcome: "success", value: { child: "run-2" } })
]

describe("run forest", () => {
  test("a child execution hangs off the node whose action names its flow, and opens in place", () => {
    const card = runCard({ events: [...RECORDED.rows] })
    const forest = forestOf(card)
    const gate = forest.nodes.find((node) => node.id === executionNodeId(GATE))
    expect(gate).toMatchObject({ kind: "flow", action: "gateway/graph/Gate", word: "done",
      door: { flow: "runs.graph.execution", args: `run-1 ${GATE}` } })
    const anchor = forest.edges.find((edge) => edge.to === gate!.id)!.from
    expect(forest.nodes.find((node) => node.id === anchor)?.action).toBe("gateway/graph/Gate")
    /* Ask is Gate's child, not GraphFixture's: it waits until Gate is opened. */
    expect(forest.nodes.some((node) => node.id === executionNodeId(ASK))).toBe(false)
  })

  test("an opened execution draws its own nodes, its child, and the way back up to the default", () => {
    const card = runCard({ events: [...RECORDED.rows], graph: { execution: GATE } })
    const { drawn, opened } = drawnGraphOf(card)
    expect(opened).toBe(true)
    expect(drawn?.flow).toBe("gateway/graph/Gate")
    const forest = forestOf(card)
    expect(forest.nodes.find((node) => node.id === executionNodeId(ASK))).toMatchObject({ action: "gateway/graph/Ask" })
    const up = forest.nodes.find((node) => node.action === RECORDED.flow)
    /* Going up to the default clears the choice rather than recording it. */
    expect(up?.door).toEqual({ flow: "runs.graph.execution", args: "run-1" })
  })

  test("an execution the journal no longer records falls back to the default graph", () => {
    const card = runCard({ events: [...RECORDED.rows], graph: { execution: "gone" } })
    expect(drawnGraphOf(card)).toMatchObject({ opened: false, drawn: { flow: RECORDED.flow } })
  })

  test("a POC lane is its own kind on a dashed edge", () => {
    const card = runCard({ events: [...POC_ROWS], workflow: "coding/request" })
    const request = "90811bae70db4fc4f34c15d800833a717393cc0eede3373250195998c502e253"
    const forest = runForestOf(card, [], { nodes: [{ id: "root.poc", kind: "task", dependsOn: [], tier: "sealed", action: "coding/Poc" }], edges: [] },
      request, undefined)
    const poc = forest.nodes.find((node) => node.kind === "poc")
    expect(poc).toMatchObject({ action: "coding/Poc", word: "done" })
    /* This journal recorded no graph for the lane, so there is nothing to open in place. */
    expect(poc?.door).toBeUndefined()
    expect(forest.edges).toContainEqual({ from: "root.poc", to: poc!.id, reason: "poc" })
  })

  test("a spawned run is a run node that opens its own card, stating its card's status once open", () => {
    const parent = runCard({ events: SPAWN, workflow: "agent/run", phase: "running" })
    const drawn = { nodes: [{ id: "root", kind: "task", dependsOn: [], tier: "sealed" as const }], edges: [] }
    const unopened = runForestOf(parent, [], drawn, undefined, undefined)
    expect(unopened.nodes.find((node) => node.id === runNodeId("run-2"))).toMatchObject({
      kind: "run", action: "review", word: "requested", door: { flow: "runs.open", args: "run-2 smithersai/smithers" } })
    expect(unopened.edges).toContainEqual({ from: "root", to: runNodeId("run-2"), reason: "spawn" })
    const child = runCard({ runId: "run-2", workflow: "review", phase: "failed" }, "flow-run-run-2")
    expect(runForestOf(parent, [parent, child], drawn, undefined, undefined).nodes
      .find((node) => node.id === runNodeId("run-2"))?.word).toBe("failed")
    /* From the child's side, the parent is the root above it. */
    const lineage = runForestOf(child, [parent, child], drawn, undefined, undefined)
    expect(lineage.nodes.find((node) => node.id === runNodeId("run-1"))).toMatchObject({ action: "agent/run", word: "running" })
    expect(lineage.edges).toContainEqual({ from: runNodeId("run-1"), to: "root", reason: "spawn" })
  })

  test("a push or schedule that started the run is a trigger root; an approval is not", () => {
    const launch = { version: 1, id: "r1", owner: "will", repo: "smithersai/smithers", workflow: RECORDED.flow, input: {},
      source: { name: "spike", explicit: true, commitId: "abc" }, triggerDispatch: { slug: "nightly" } }
    const card = runCard({ input: { _workflowLaunch: launch } })
    const drawn = { nodes: [{ id: "root", kind: "task", dependsOn: [], tier: "sealed" as const }], edges: [] }
    const forest = runForestOf(card, [], drawn, undefined, undefined)
    expect(forest.nodes.filter((node) => node.kind === "trigger").map((node) => [node.action, node.word]))
      .toEqual([["spike", "push"], ["nightly", "schedule"]])
    expect(forest.edges.filter((edge) => edge.reason === "fires").map((edge) => edge.to)).toEqual(["root", "root"])
  })

  test("an ambiguous anchor is refused: two nodes calling the child's flow leave it unanchored", () => {
    const card = runCard({ events: [...RECORDED.rows] })
    const { drawn, defaultExecutionId } = drawnGraphOf(card)
    const twin = { ...drawn!.nodes.find((node) => node.action === "gateway/graph/Gate")!, id: "twin" }
    const forest = runForestOf(card, [], { nodes: [...drawn!.nodes, twin], edges: drawn!.edges }, drawn?.executionId, defaultExecutionId)
    expect(forest.nodes.find((node) => node.id === executionNodeId(GATE))?.dependsOn).toEqual([])
    expect(forest.edges.some((edge) => edge.to === executionNodeId(GATE))).toBe(false)
  })

  test("spawned runs, the spawning run and the trigger belong beside the run's own execution only", () => {
    const launch = { version: 1, id: "r1", owner: "will", repo: "smithersai/smithers", workflow: RECORDED.flow, input: {},
      source: { name: "spike", explicit: true, commitId: "abc" } }
    const card = runCard({ events: [...RECORDED.rows, ...SPAWN.map((row) => ({ ...row, sequence: 1000 + Number(row.sequence) }))],
      input: { _workflowLaunch: launch }, graph: { execution: GATE } })
    const kinds = forestOf(card).nodes.filter((node) => node.forest === true).map((node) => node.kind)
    expect(kinds).not.toContain("run")
    expect(kinds).not.toContain("trigger")
    const own = forestOf({ ...card, payload: { ...card.payload, graph: {} } }).nodes.filter((node) => node.forest === true).map((node) => node.kind)
    expect(own).toEqual(expect.arrayContaining(["run", "trigger"]))
  })
})
