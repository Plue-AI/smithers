import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import type { PlanCardNode } from "./FlowGraph"
import { FlowGraphSurface } from "./FlowGraphSurface"
import { FlowPlanCardBody } from "./FlowPlanCard"
import type { FlowDurationsRow } from "../state/AppState"

/*
 * The plan card and the graph it opens.
 *
 * The canvas is imported directly here rather than through the card's
 * Suspense boundary, because the boundary is exactly what keeps xyflow out of
 * the main chunk: a card test that awaited the chunk would prove the opposite
 * of what the lazy import is for.
 */

GlobalRegistrator.register()

/*
 * React Flow keeps a resize observer per canvas, which schedules React work
 * after the test that mounted it. Unmount every root before the DOM goes
 * away, or that work lands on a `window` that no longer exists.
 */
const mounted: Array<{ unmount: () => void }> = []

afterAll(async () => {
  for (const root of mounted) root.unmount()
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

type FlowPlanCard = Extract<Card, { kind: "flow-plan" }>

const node = (id: string, dependsOn: Array<string> = [], over: Partial<PlanCardNode> = {}): PlanCardNode => ({
  id,
  kind: "step" as const,
  key: `key1_${"0".repeat(64)}`,
  dependsOn,
  tier: "sealed" as const,
  status: "run" as const,
  ...over
})

const NODES = [node("a", [], { action: "files/read" }), node("b", ["a"], { kind: "agent", action: "agent/run" })]

const card = (payload: Partial<FlowPlanCard["payload"]>): FlowPlanCard => ({
  id: "flow-plan-1",
  kind: "flow-plan",
  title: "review",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: "o/r", flowId: "review", status: "pending", ...payload }
})

const render = (element: React.ReactElement): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted.push(root)
  flushSync(() => root.render(element))
  return host
}

describe("the plan card", () => {
  test("a pending plan draws no graph and claims no nodes", () => {
    const host = render(<FlowPlanCardBody card={card({})} onRunCommand={() => {}} />)
    expect(host.querySelector(".flow-plan-count")).toBeNull()
    expect(host.querySelector(".flow-plan-canvas")).toBeNull()
    expect(host.querySelector(".flow-plan-error")).toBeNull()
  })

  test("a finished plan states its node count as a number and nothing else", () => {
    const host = render(<FlowPlanCardBody card={card({ status: "done", nodes: NODES })} onRunCommand={() => {}} />)
    expect(host.querySelector(".flow-plan-count")?.textContent).toBe("2")
    // MINIMAL TEXT: a count, a button, a picture. No sentence beside the button.
    expect(host.querySelector(".flow-plan-head")?.textContent).toBe("2Run")
    expect(host.querySelectorAll("p").length).toBe(0)
  })

  test("Run carries the flow.run line for the flow and input the plan was taken on", () => {
    const ran: Array<[string, string | undefined]> = []
    const host = render(
      <FlowPlanCardBody
        card={card({ status: "done", nodes: NODES, input: { pr: 4821 } })}
        onRunCommand={(name, args) => ran.push([name, args])}
      />
    )
    const button = host.querySelector("[data-flow=\"flow.run\"]") as HTMLButtonElement
    expect(button.getAttribute("data-flow-args")).toBe('sourceCard=flow-plan-1 review o/r {"pr":4821}')
    button.click()
    expect(ran).toEqual([["flow.run", 'sourceCard=flow-plan-1 review o/r {"pr":4821}']])
  })

  test("a refused plan states the workspace's own sentence and offers the plan door again", () => {
    const host = render(
      <FlowPlanCardBody
        card={card({ status: "failed", error: "There's no flow called review on o/r." })}
        onRunCommand={() => {}}
      />
    )
    expect(host.querySelector(".flow-plan-error")?.textContent).toBe("There's no flow called review on o/r.")
    expect(host.querySelector("[data-flow=\"flow.plan\"]")).not.toBeNull()
    expect(host.querySelector("[data-flow=\"flow.run\"]")).toBeNull()
  })

  test("an empty plan draws no graph and writes no sentence about it", () => {
    const host = render(<FlowPlanCardBody card={card({ status: "done", nodes: [] })} onRunCommand={() => {}} />)
    expect(host.querySelector(".flow-plan-canvas")).toBeNull()
    expect(host.querySelector(".flow-plan-count")).toBeNull()
    expect(host.textContent).toBe("Run")
  })
})

describe("the graph the card opens", () => {
  test("draws one node per plan node, each wearing its state as a word", () => {
    const host = render(<FlowGraphSurface nodes={NODES} />)
    const drawn = [...host.querySelectorAll("[data-node]")]
    expect(drawn.map((element) => element.getAttribute("data-node"))).toEqual(["a", "b"])
    expect(drawn.map((element) => element.querySelector(".flow-graph-node-word")?.textContent)).toEqual(["run", "run"])
    expect(drawn.map((element) => element.getAttribute("data-tier"))).toEqual(["sealed", "sealed"])
  })

  test("names each node by the action it dispatches, falling back to its address", () => {
    const host = render(<FlowGraphSurface nodes={[...NODES, node("c", ["b"])]} />)
    expect(host.querySelector("[data-node=\"a\"]")?.textContent).toContain("files/read")
    expect(host.querySelector("[data-node=\"c\"]")?.textContent).toContain("c")
  })

  test("an empty plan draws nothing", () => {
    expect(render(<FlowGraphSurface nodes={[]} />).innerHTML).toBe("")
  })
})

/*
 * How long each node takes, and how long the rest will (D-030, L7).
 *
 * The rows are the gateway's `flow-durations` projection as the collection
 * holds it. A flow with no history has no rows, and then the card says
 * nothing about time at all: never a row reading "not measured yet".
 */
const duration = (actionTag: string, p50Ms: number, over: Partial<FlowDurationsRow> = {}): FlowDurationsRow => ({
  id: `o/r:review:${actionTag}`,
  repo: "o/r",
  flowId: "review",
  actionTag,
  samples: 4,
  p50Ms,
  p90Ms: p50Ms * 2,
  loadedAt: 0,
  ...over
})

const MEASURED = [duration("files/read", 1_000), duration("agent/run", 4_000)]

describe("what the plan says about time", () => {
  test("a flow with no measured history shows no duration text anywhere", () => {
    const host = render(<FlowPlanCardBody card={card({ status: "done", nodes: NODES })} onRunCommand={() => {}} />)
    expect(host.querySelector(".flow-plan-eta")).toBeNull()
    expect(host.textContent).not.toContain("not measured")
    expect(host.textContent).not.toContain("~")
  })

  test("with history the head states the critical path, longest branch and no more", () => {
    const host = render(
      <FlowPlanCardBody card={card({ status: "done", nodes: NODES })} onRunCommand={() => {}} flowDurations={MEASURED} />
    )
    // a (1s) then b (4s), in series: 5s.
    expect(host.querySelector(".flow-plan-eta")?.textContent).toBe("~5.0s")
  })

  test("one unmeasured node and the head states no estimate at all", () => {
    const host = render(
      <FlowPlanCardBody
        card={card({ status: "done", nodes: [...NODES, node("c", ["b"], { action: "acme/NeverRun" })] })}
        onRunCommand={() => {}}
        flowDurations={MEASURED}
      />
    )
    expect(host.querySelector(".flow-plan-eta")).toBeNull()
    expect(host.querySelector(".flow-plan-count")?.textContent).toBe("3")
  })

  test("another flow's rows are not this flow's history", () => {
    const host = render(
      <FlowPlanCardBody
        card={card({ status: "done", nodes: NODES })}
        onRunCommand={() => {}}
        flowDurations={MEASURED.map((row) => ({ ...row, flowId: "ship" }))}
      />
    )
    expect(host.querySelector(".flow-plan-eta")).toBeNull()
  })
})

describe("the re-key preview", () => {
  const preview = (rekey: NonNullable<FlowPlanCard["payload"]["rekey"]>) =>
    render(
      <FlowPlanCardBody
        card={card({ status: "done", nodes: NODES, against: "run-1", rekey })}
        onRunCommand={() => {}}
      />
    )

  test("numbers only: the work, the estimate, and what the compared run really took", () => {
    const host = preview({ rerun: 3, total: 11, etaMs: 2_400, wasMs: 5_000 })
    expect(host.querySelector(".flow-plan-rerun")?.textContent).toBe("re-keyed 3 of 11")
    expect(host.querySelector(".flow-plan-rekey-eta")?.textContent).toBe("~2.4s")
    expect(host.querySelector(".flow-plan-was")?.textContent).toBe("was 5.0s")
  })

  test("a run that recorded no clean settlement shows no cache-hit count", () => {
    // D-044: on the production host every step re-dispatches, so a cache-hit
    // count would be the engine's design reported as the host's behaviour.
    const host = preview({ rerun: 3, total: 11, etaMs: 2_400, wasMs: 5_000 })
    expect(host.querySelector(".flow-plan-clean")).toBeNull()
    expect(host.textContent).not.toContain("clean")
    expect(host.textContent).not.toContain("cache")
  })

  test("a run that really did settle nodes clean states that count", () => {
    const host = preview({ rerun: 3, total: 11, etaMs: 2_400, wasMs: 5_000, cleanSettlements: 8 })
    expect(host.querySelector(".flow-plan-clean")?.textContent).toBe("was 8 clean")
  })

  test("one unmeasured node on the work leaves the counts standing and the estimate out", () => {
    const host = preview({ rerun: 3, total: 11, wasMs: 5_000 })
    expect(host.querySelector(".flow-plan-rerun")?.textContent).toBe("re-keyed 3 of 11")
    expect(host.querySelector(".flow-plan-rekey-eta")).toBeNull()
  })

  test("unchanged keys still show the measured execution estimate", () => {
    const host = preview({ rerun: 0, total: 11, etaMs: 470, wasMs: 470 })
    expect(host.querySelector(".flow-plan-rerun")?.textContent).toBe("re-keyed 0 of 11")
    expect(host.querySelector(".flow-plan-rekey-eta")?.textContent).toBe("~470ms")
    expect(host.querySelector(".flow-plan-was")?.textContent).toBe("was 470ms")
  })

  test("a plan compared against nothing shows no preview at all", () => {
    const host = render(<FlowPlanCardBody card={card({ status: "done", nodes: NODES })} onRunCommand={() => {}} />)
    expect(host.querySelector(".flow-plan-rekey")).toBeNull()
  })
})

describe("what each node says about time", () => {
  test("a node with history wears its p50, and states the sample size behind it", () => {
    const host = render(<FlowGraphSurface nodes={NODES} durations={MEASURED} />)
    const shown = host.querySelector("[data-node=\"a\"] .flow-graph-node-eta")
    expect(shown?.textContent).toBe("~1.0s")
    expect(shown?.getAttribute("title")).toBe("p50 of 4 runs · p90 2.0s")
  })

  test("a node nothing measured wears no number, and no apology for it", () => {
    const host = render(<FlowGraphSurface nodes={[...NODES, node("c", ["b"], { action: "acme/NeverRun" })]} durations={MEASURED} />)
    expect(host.querySelector("[data-node=\"c\"] .flow-graph-node-eta")).toBeNull()
    expect(host.querySelector("[data-node=\"c\"]")?.textContent).not.toContain("measured")
  })

  test("a tag whose p90 dwarfs its p50 shows both ends rather than a misleading middle", () => {
    const host = render(<FlowGraphSurface nodes={NODES} durations={[duration("files/read", 1_000, { p90Ms: 10_000 })]} />)
    expect(host.querySelector("[data-node=\"a\"] .flow-graph-node-eta")?.textContent).toBe("1.0s–10.0s")
  })

  test("without rows no node carries duration text", () => {
    const host = render(<FlowGraphSurface nodes={NODES} />)
    expect(host.querySelectorAll(".flow-graph-node-eta").length).toBe(0)
  })
})

/*
 * The schedules that fire this flow, beside the plan they fire (L6, D-031).
 * A trigger is not a plan node: it is never in the count. Where the plan draws
 * a canvas the schedule is drawn on it (FlowGraphDrawer.test.tsx renders that
 * canvas); the panel below is what a plan with nothing to draw shows instead,
 * and it is there only for a dispatcher listing whose box actually answered.
 */
type TriggerListCard = Extract<Card, { kind: "trigger-list" }>

const dispatcher = (payload: Partial<TriggerListCard["payload"]>): TriggerListCard => ({
  id: "trigger-list-o/r",
  kind: "trigger-list",
  title: "Dispatcher · o/r",
  status: "acted",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: "o/r", live: true, triggers: [], ...payload }
})

const NIGHTLY: TriggerListCard["payload"]["triggers"][number] = {
  id: "nightly",
  flowId: "review",
  cron: "0 9 * * 1-5",
  timezone: "UTC",
  enabled: true,
  nextFireAt: Date.UTC(2026, 8, 21, 9, 0)
}

describe("the schedules that fire the plan", () => {
  test("a schedule stays out of the node count, and the canvas draws it rather than the panel", () => {
    const host = render(
      <FlowPlanCardBody
        card={card({ status: "done", nodes: NODES })}
        onRunCommand={() => {}}
        triggerCatalogs={[dispatcher({ triggers: [NIGHTLY] })]}
      />
    )
    expect(host.querySelector(".flow-plan-count")?.textContent).toBe("2")
    /* Two nodes, not three: the schedule is never counted as plan work. */
    expect(host.querySelector(".flow-trigger-panel")).toBeNull()
  })

  test("a plan with no canvas to draw shows its schedule in the panel beside it", () => {
    const host = render(
      <FlowPlanCardBody
        card={card({ status: "done", nodes: [] })}
        onRunCommand={() => {}}
        triggerCatalogs={[dispatcher({ triggers: [NIGHTLY] })]}
      />
    )
    expect(host.querySelector(".flow-plan-count")).toBeNull()
    expect(host.querySelector("[data-trigger='nightly']")?.getAttribute("data-trigger-state")).toBe("armed")
    expect(host.querySelector("[data-testid='trigger-schedule-nightly']")?.textContent).toBe("Every weekday at 09:00 UTC")
  })

  test("another flow's schedule, another repository's listing, and a box that never answered all show nothing", () => {
    for (const catalog of [
      dispatcher({ triggers: [{ ...NIGHTLY, flowId: "lint" }] }),
      dispatcher({ repo: "other/repo", triggers: [NIGHTLY] }),
      dispatcher({ live: false, triggers: [NIGHTLY] })
    ]) {
      const host = render(
        <FlowPlanCardBody card={card({ status: "done", nodes: [] })} onRunCommand={() => {}} triggerCatalogs={[catalog]} />
      )
      expect(host.querySelector("[data-trigger]")).toBeNull()
    }
  })

  test("no dispatcher listing at all is no panel, never an empty one", () => {
    const host = render(<FlowPlanCardBody card={card({ status: "done", nodes: [] })} onRunCommand={() => {}} />)
    expect(host.querySelector(".flow-trigger-panel")).toBeNull()
  })
})


test("a plan estimates from its own workspace and never from default-gateway history", () => {
  const history = [
    ...MEASURED,
    ...MEASURED.map(row => ({ ...row, workspaceId: "ws-1", p50Ms: row.p50Ms * 2 })),
    ...MEASURED.map(row => ({ ...row, workspaceId: "ws-2", p50Ms: row.p50Ms * 3 }))
  ]
  for (const [workspaceId, expected] of [[undefined, "~5.0s"], ["ws-1", "~10.0s"], ["ws-2", "~15.0s"], ["unmeasured", undefined]] as const) {
    const host = render(<FlowPlanCardBody card={card({ status: "done", nodes: NODES, workspaceId })} onRunCommand={() => {}} flowDurations={history} />)
    expect(host.querySelector(".flow-plan-eta")?.textContent).toBe(expected)
  }
})

test("retrying a refused comparison retains its comparison target", () => {
  const host = render(<FlowPlanCardBody card={card({ status: "failed", error: "Try again", against: "run-previous", input: { pr: 4821 } })} onRunCommand={() => {}} />)
  expect(host.querySelector('[data-flow="flow.plan"]')?.getAttribute("data-flow-args")).toContain("against=run-previous")
})
