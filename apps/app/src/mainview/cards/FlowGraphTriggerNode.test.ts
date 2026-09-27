import { describe, expect, test } from "bun:test"
import { flowGraphModel, layoutFlowGraph, type PlanCardNode } from "./FlowGraph"
import {
  nextFireTimes,
  triggerGraph,
  triggerNodeId,
  triggerNodeState,
  type TriggerCardRow
} from "./FlowGraphTriggerNode"

const node = (id: string, dependsOn: Array<string> = []): PlanCardNode => ({
  id,
  kind: "step" as const,
  key: `key1_${"0".repeat(64)}`,
  dependsOn,
  tier: "sealed" as const,
  status: "run" as const
})

/* a → b, a → c, b → d, c → d */
const diamond = [node("a"), node("b", ["a"]), node("c", ["a"]), node("d", ["b", "c"])]

const row = (over: Partial<TriggerCardRow> = {}): TriggerCardRow => ({
  id: "nightly",
  flowId: "review",
  cron: "0 9 * * 1-5",
  enabled: true,
  ...over
})

describe("a trigger is disabled or armed, never built or clean (D-031)", () => {
  test("a schedule that is enabled is armed", () => {
    expect(triggerNodeState(row())).toBe("armed")
  })

  /* The flag the registry recorded, not the cron: a registration that is off
   * is not waiting to fire, so it never reads `armed`. */
  test("a schedule recorded as off is disabled", () => {
    expect(triggerNodeState(row({ enabled: false }))).toBe("disabled")
  })

  test("the state rides onto the node the canvas draws", () => {
    expect(triggerGraph([row({ enabled: false })], "review", diamond).nodes[0]!.state).toBe("disabled")
    expect(triggerGraph([row()], "review", diamond).nodes[0]!.state).toBe("armed")
  })
})

describe("the trigger nodes and the UI-only fires edges", () => {
  test("only a schedule that names this flow reaches the graph", () => {
    const part = triggerGraph([row(), row({ id: "other", flowId: "lint" })], "review", diamond)
    expect(part.nodes.map((entry) => entry.row.id)).toEqual(["nightly"])
    expect(part.nodes[0]!.id).toBe(triggerNodeId("nightly"))
  })

  test("a fires edge runs from the trigger to every root of the plan", () => {
    const part = triggerGraph([row()], "review", [node("a"), node("z"), node("b", ["a"])])
    expect(part.edges.map((edge) => [edge.from, edge.to])).toEqual([
      [triggerNodeId("nightly"), "a"],
      [triggerNodeId("nightly"), "z"]
    ])
  })

  test("a plan with no nodes has nothing to fire, so there is no edge", () => {
    expect(triggerGraph([row()], "review", []).edges).toEqual([])
    expect(triggerGraph([row()], "review", []).nodes).toHaveLength(1)
  })

  test("no schedule at all is no trigger node (harden: zero triggers shows none)", () => {
    expect(triggerGraph([], "review", diamond)).toEqual({ nodes: [], edges: [] })
  })
})

describe("the trigger is excluded from every count", () => {
  test("the model's plan nodes stay the plan's own, and the trigger rides beside them", () => {
    const model = flowGraphModel(diamond, undefined, triggerGraph([row()], "review", diamond))
    expect(model.nodes).toHaveLength(diamond.length)
    expect(model.nodes.some((entry) => entry.id.startsWith("trigger:"))).toBe(false)
    expect(model.triggers?.map((entry) => entry.row.id)).toEqual(["nightly"])
  })

  test("a plan with no triggers carries no trigger field at all", () => {
    expect(flowGraphModel(diamond)).not.toHaveProperty("triggers")
    expect(flowGraphModel([])).toEqual({ nodes: [], edges: [] })
  })

  test("the fires edge is drawn and labelled, and dagre gives the trigger its own row above the plan", () => {
    const model = flowGraphModel(diamond, undefined, triggerGraph([row()], "review", diamond))
    expect(model.edges.filter((edge) => edge.reason === "fires").map((edge) => edge.to)).toEqual(["a"])
    const laid = layoutFlowGraph(model)
    const at = (id: string) => laid.nodes.find((entry) => entry.id === id)!
    expect(at(triggerNodeId("nightly")).type).toBe("triggerNode")
    expect(at(triggerNodeId("nightly")).position.y).toBeLessThan(at("a").position.y)
    expect(at(triggerNodeId("nightly")).ariaLabel).toBe("nightly armed")
  })
})

describe("the next fire time", () => {
  const next = Date.UTC(2026, 8, 21, 16, 0)

  test("a zone that is not UTC puts the schedule's own reading beside the UTC one", () => {
    const [first] = nextFireTimes(row({ nextFireAt: next, timezone: "America/New_York" }))
    expect(first!.at).toBe(next)
    expect(first!.zoned).toContain("12:00")
    expect(first!.utc).toContain("16:00")
  })

  test("a UTC schedule, and one whose zone the registry never named, read once", () => {
    for (const zone of [undefined, "UTC"]) {
      const [first] = nextFireTimes(row({ nextFireAt: next, ...(zone === undefined ? {} : { timezone: zone }) }))
      expect(first!.utc).toContain("16:00")
      expect(first!.zoned).toBeUndefined()
    }
  })

  test("a row with no next fire has no times, never an invented one", () => {
    expect(nextFireTimes(row())).toEqual([])
  })
})
