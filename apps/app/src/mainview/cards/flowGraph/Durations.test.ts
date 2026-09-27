/*
 * How long a flow's nodes take, and how long the rest of a run will.
 *
 * The rows every case folds come out of `fixtures/GraphRunJournal.json` by
 * the gateway's OWN projection (`nodeDurations` then `flowDurations`), so the
 * numbers here are durations a real bridged engine measured rather than
 * numbers a test invented. The hand-built plans are shapes the recording does
 * not contain — a diamond, a two-sample tag — and each one says so.
 */
import * as GatewayProjection from "@smthrs/gateway/GatewayProjection"
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { JournalRecord } from "../RunTrace"
import { flowGraphModel, type PlanCardNode } from "../FlowGraph"
import { triggerGraph } from "../FlowGraphTriggerNode"
import { criticalPathEta, display, durationsByTag, progressOf, type DurationNode } from "./Durations"

interface Recorded {
  readonly flow: string
  readonly plan: { readonly nodes: ReadonlyArray<DurationNode> }
  readonly rows: ReadonlyArray<JournalRecord>
}

const RECORDED: Recorded = JSON.parse(readFileSync(new URL("../fixtures/GraphRunJournal.json", import.meta.url), "utf8"))

/** The flow-durations rows the gateway would serve for the recorded run. */
const RECORDED_ROWS = GatewayProjection.flowDurations(
  RECORDED.flow,
  GatewayProjection.nodeDurations(RECORDED.rows as ReadonlyArray<never>)
)

/** One row of the served shape, for a spread the recording does not contain. */
const row = (actionTag: string, p50Ms: number, p90Ms: number, samples = 4): GatewayProjection.FlowDurationRow =>
  ({ flowId: "acme/flow", actionTag, samples, p50Ms, p90Ms })

/** A diamond: one node fans out to two, which merge. The recording has no such shape. */
const DIAMOND: ReadonlyArray<DurationNode> = [
  { id: "open", dependsOn: [], action: "acme/Open" },
  { id: "left", dependsOn: ["open"], action: "acme/Left" },
  { id: "right", dependsOn: ["open"], action: "acme/Right" },
  { id: "join", dependsOn: ["left", "right"], action: "acme/Join" }
]
const DIAMOND_ROWS = [row("acme/Open", 1_000, 1_200), row("acme/Left", 2_000, 2_400), row("acme/Right", 500, 600), row("acme/Join", 100, 120)]

describe("durationsByTag", () => {
  test("indexes the gateway's rows by the tag history is grouped by", () => {
    const index = durationsByTag(RECORDED_ROWS)
    expect(index.get("gateway/graph/Gate")?.p50Ms).toBe(247)
    expect(index.get("gateway/graph/Doomed")).toBeUndefined()
  })
})

describe("display", () => {
  test("states p50 and how many executions are behind it", () => {
    const shown = display(row("acme/Open", 60_000, 90_000, 24))
    expect(shown?.text).toBe("~1m00s")
    expect(shown?.samples).toBe(24)
    expect(shown?.detail).toBe("p50 of 24 runs · p90 1m30s")
  })

  test("a p90 exactly three times the p50 is still one number", () => {
    expect(display(row("acme/Open", 1_000, 3_000))?.text).toBe("~1.0s")
  })

  test("a wider spread than that is a range, because one number would be a lie", () => {
    expect(display(row("acme/Open", 1_000, 3_010))?.text).toBe("1.0s–3.0s")
  })

  test("no measured execution is no claim", () => {
    expect(display(row("acme/Open", 0, 0, 0))).toBeUndefined()
    expect(display(undefined)).toBeUndefined()
  })
})

describe("criticalPathEta", () => {
  test("a diamond costs its longest branch, never the sum of both", () => {
    // open 1000 + left 2000 + join 100. The serial sum would be 3600.
    expect(criticalPathEta(DIAMOND, DIAMOND_ROWS, "acme/flow")).toBe(3_100)
  })

  test("a node that will not execute costs nothing", () => {
    const eta = criticalPathEta(DIAMOND, DIAMOND_ROWS, "acme/flow", (id) => id === "left")
    expect(eta).toBe(1_600)
  })

  test("one unmeasured tag leaves the whole estimate unsayable", () => {
    // `gateway/graph/Doomed` failed on the recorded run, and only a built
    // settlement is measured, so the flow's own plan has no estimate.
    expect(criticalPathEta(RECORDED.plan.nodes, RECORDED_ROWS, RECORDED.flow)).toBeUndefined()
  })

  test("the unmeasured node skipped, the recorded plan's own nodes estimate", () => {
    const eta = criticalPathEta(
      RECORDED.plan.nodes,
      RECORDED_ROWS,
      RECORDED.flow,
      (id) => id === "root.flow.then.map.all.recovered.protected"
    )
    // Gate 247 then the longest measured branch, Flaky 43. Every merge node
    // dispatches nothing and the root is the span, not a step.
    expect(eta).toBe(290)
  })

  test("the flow's own root node is the span, not a step on the path", () => {
    const root = RECORDED.plan.nodes.find((node) => node.action === RECORDED.flow)
    expect(root?.id).toBe("root")
    const pathOnly = criticalPathEta(
      [{ id: "one", dependsOn: [], action: "gateway/graph/Gate" }, { id: "root", dependsOn: ["one"], action: RECORDED.flow }],
      RECORDED_ROWS,
      RECORDED.flow
    )
    expect(pathOnly).toBe(247)
  })

  test("a trigger is not a plan node, so it never costs the path anything (D-031)", () => {
    /* The same diamond, in the shape a plan card carries. */
    const planned: ReadonlyArray<PlanCardNode> = DIAMOND.map((node) => ({
      id: node.id,
      kind: "step" as const,
      key: `key1_${"0".repeat(64)}`,
      dependsOn: [...node.dependsOn],
      tier: "sealed" as const,
      status: "run" as const,
      ...(node.action === undefined ? {} : { action: node.action })
    }))
    const triggers = triggerGraph(
      [{ id: "nightly", flowId: "acme/flow", cron: "0 9 * * 1-5", timezone: "UTC", enabled: true }],
      "acme/flow",
      planned
    )
    const model = flowGraphModel(planned, undefined, triggers)
    expect(model.triggers?.length).toBe(1)
    // The trigger's own id is nowhere in the plan's nodes, so the estimate
    // over them is the same number a plan with no schedule answers with.
    expect(criticalPathEta(model.nodes, DIAMOND_ROWS, "acme/flow")).toBe(3_100)
    expect(model.nodes.some((node) => node.id === "nightly")).toBe(false)
  })

  test("a skipped node is a node that did not run, and costs nothing (D-032)", () => {
    // `right` is skipped, so the estimate is the branch that still runs.
    expect(criticalPathEta(DIAMOND, DIAMOND_ROWS, "acme/flow", (id) => id === "right")).toBe(3_100)
    expect(criticalPathEta(DIAMOND, DIAMOND_ROWS, "acme/flow", (id) => id === "left" || id === "right")).toBe(1_100)
  })

  test("the flow's own root costs nothing before anything has been measured", () => {
    /* The plan of a flow whose root echoes the flow itself, with no history
     * at all. The root is the span over its own nodes, so it costs the path
     * nothing whether or not the projection has served a row yet: the flow
     * the plan belongs to is the card's own, not something read off the
     * first row served. */
    const plan: ReadonlyArray<DurationNode> = [
      { id: "root", dependsOn: [], action: "acme/flow" },
      { id: "step", dependsOn: ["root"], action: "acme/Open" }
    ]
    expect(criticalPathEta(plan, [], "acme/flow", (id) => id === "step")).toBe(0)
    // The step still has to be measured before it can be estimated.
    expect(criticalPathEta(plan, [], "acme/flow")).toBeUndefined()
  })

  test("a plan with no nodes has no estimate", () => {
    expect(criticalPathEta([], DIAMOND_ROWS, "acme/flow")).toBeUndefined()
  })
})

describe("progressOf", () => {
  test("a running node's elapsed against the p50 it is measured on", () => {
    expect(progressOf(500, row("acme/Open", 1_000, 3_000))).toBe(0.5)
  })

  test("past the p90 there is no prediction left to fill", () => {
    expect(progressOf(3_001, row("acme/Open", 1_000, 3_000))).toBeUndefined()
    expect(progressOf(500, undefined)).toBeUndefined()
  })
})
