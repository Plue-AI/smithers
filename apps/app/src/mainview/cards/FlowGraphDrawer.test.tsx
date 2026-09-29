/*
 * The node drawer, on both graph cards.
 *
 * The run's evidence is the recorded one: `fixtures/GraphRunJournal.json` is
 * what a completed `gateway/GraphFixture` run wrote on the bridged stack, so
 * every action tag, effect set and journal row below is one the engine
 * produced. Where a case needs evidence the recording does not contain —
 * declaration provenance, which the engine writes today (D-037, D-047) but
 * this recording predates — the row is a RECORDED row with one field added,
 * and the test says which.
 *
 * A tab with nothing behind it is absent, never empty (D-035), so most of
 * what is asserted here is what the drawer does NOT draw.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { payloadFor } from "../flows/SlashPayload"
import { fileFor, FlowGraphDrawer, graphKeyAct, planDrawerNode, runDrawerNode, type GraphDrill } from "./FlowGraphDrawer"
import { FlowGraphSurface } from "./FlowGraphSurface"
import { FlowRunGraphSurface } from "./FlowRunGraphSurface"
import type { TriggerGraphPart } from "./FlowGraphTriggerNode"
import { foldRunGraph, runGraphOf } from "./FlowGraphStatus"
import type { NodeRun, RunGraphNode } from "./FlowGraphStatus"
import type { PlanCardNode } from "./FlowGraph"
import type { JournalRecord } from "./RunTrace"

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

interface Recorded {
  readonly flow: string
  readonly plan: { readonly nodes: ReadonlyArray<{ readonly id: string }> }
  readonly rows: Array<JournalRecord>
}
const RECORDED: Recorded = JSON.parse(readFileSync(new URL("./fixtures/GraphRunJournal.json", import.meta.url), "utf8"))

/** The envelope of one recorded engine row, for the cases that add one field. */
const envelopeOf = (row: JournalRecord) => row.payload as {
  readonly eventType: string
  readonly payload: Record<string, unknown>
}

/** The execution that drove the recorded plan, folded as the run card folds it. */
const graph = () => {
  const found = runGraphOf(foldRunGraph(RECORDED.rows), { planNodeIds: RECORDED.plan.nodes.map((node) => node.id) })
  if (found === undefined) throw new Error("the recording carries no execution covering the plan")
  return found
}

const recordedNode = (id: string): RunGraphNode => {
  const node = graph().nodes.find((candidate) => candidate.id === id)
  if (node === undefined) throw new Error(`the recording carries no node ${id}`)
  return node
}

const recordedRun = (id: string): NodeRun | undefined => graph().status.get(id)

/**
 * One node as the drawer reads it, folded from the rows a case hands in.
 *
 * A node's own settlement is what claims the dispatches it ran under, so a
 * case that edits that settlement has to fold the edited rows: reading the
 * node off the untouched recording would carry the claim back in.
 */
const foldedNode = (rows: ReadonlyArray<JournalRecord>, id: string) => {
  const found = runGraphOf(foldRunGraph(rows), { planNodeIds: RECORDED.plan.nodes.map((node) => node.id) })
  if (found === undefined) throw new Error("these rows carry no execution covering the plan")
  return runDrawerNode(found.nodes.find((node) => node.id === id)!, found.status.get(id), found.executionId)
}

const STEADY = "root.flow.then.map.all.steady"

const DOORS = { select: "runs.graph.select", tab: "runs.graph.tab", target: "run-1" } as const
const PLAN_DOORS = { select: "flow.plan.select", tab: "flow.plan.tab", target: "flow-plan-1" } as const

test("an authored plan drawer compares real keys without predicting execution", () => {
  const host = render(<FlowGraphDrawer node={{ id: "read", kind: "step", dependsOn: [], tier: "sealed", key: "new-key",
    keyChange: "re-keyed", previousKey: "old-key" }} doors={PLAN_DOORS} onRunCommand={() => {}} />)
  expect(host.querySelector('[data-field="key change"]')?.textContent).toBe("re-keyed")
  expect(host.querySelector('[data-field="previous key"]')?.textContent).toBe("old-key")
  expect(host.textContent).not.toContain("cache hit")
})

const render = (element: React.ReactElement): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  mounted.push({ root, host })
  act(() => root.render(element))
  return host
}

const tabs = (host: HTMLElement): ReadonlyArray<string> =>
  [...host.querySelectorAll("[role='tab']")].map((tab) => tab.getAttribute("data-tab") ?? "")

/** The revision a writer read those sites at, as the pages carry it (D-068). */
const REVISION = "b".repeat(40)

/**
 * The recorded plan-recorded page, with `declaredAt` added to one node and
 * the revision that site was read at added to the page.
 *
 * Both together, because that is how a writer records them: a path and a
 * line say where, and only the revision says which bytes were there. A case
 * that wants a site a writer named no revision for passes `null`.
 */
const withProvenance = (
  nodeId: string,
  declaredAt: { path: string; line: number },
  revision: string | null = REVISION
): Array<JournalRecord> =>
  RECORDED.rows.map((row) => {
    const envelope = envelopeOf(row)
    if (envelope.eventType !== "flows.engine.plan-recorded") return row
    const graph = envelope.payload["graph"] as { nodes: ReadonlyArray<Record<string, unknown>> } | undefined
    if (graph === undefined || !graph.nodes.some((node) => node["id"] === nodeId)) return row
    return {
      ...row,
      payload: {
        ...envelope,
        payload: {
          ...envelope.payload,
          graph: {
            ...graph,
            nodes: graph.nodes.map((node) => node["id"] === nodeId ? { ...node, declaredAt } : node),
            ...(revision === null ? {} : { sourceRevision: revision })
          }
        }
      }
    }
  })

/**
 * The recorded settlement of one node, with the dispatch identities its
 * attempts ran under added (D-048).
 *
 * The settlement is recorded AFTER the attempts it covers, so a drawer that
 * learns the join while listing rows learns it too late.
 */
const withDispatch = (nodeId: string, stepKeyDigests: ReadonlyArray<string>): Array<JournalRecord> =>
  RECORDED.rows.map((row) => {
    const envelope = envelopeOf(row)
    if (envelope.eventType !== "flows.engine.node-settled" || envelope.payload["nodeId"] !== nodeId) return row
    return { ...row, payload: { ...envelope, payload: { ...envelope.payload, stepKeyDigests } } }
  })

/** The recorded settlement of one node, with the dispatch identities it states taken away. */
const withoutDispatch = (nodeId: string): Array<JournalRecord> =>
  RECORDED.rows.map((row) => {
    const envelope = envelopeOf(row)
    if (envelope.eventType !== "flows.engine.node-settled" || envelope.payload["nodeId"] !== nodeId) return row
    const { stepKeyDigests: _unstated, ...rest } = envelope.payload
    return { ...row, payload: { ...envelope, payload: rest } }
  })

/** The digest of the attempt the recording started once this node was scheduled. */
const dispatchedDigest = (nodeId: string): string => {
  const scheduled = RECORDED.rows.findIndex((row) =>
    envelopeOf(row).eventType === "flows.engine.node-scheduled" && envelopeOf(row).payload["nodeId"] === nodeId
  )
  const started = RECORDED.rows.slice(scheduled + 1).find((row) =>
    envelopeOf(row).eventType === "flows.engine.attempt-started"
  )
  if (started === undefined) throw new Error(`the recording started no attempt after ${nodeId} was scheduled`)
  return envelopeOf(started).payload["stepKeyDigest"] as string
}

test("pointer, keyboard and dependency navigation preserve spaces and slashes in node IDs", () => {
  for (const nodeId of ["root.flow.all.hello world", "root.flow.all.a/b"]) {
    const received: Array<{ name: string; args?: string }> = []
    const onRunCommand = (name: string, args?: string) => received.push({ name, args })
    const doors = { select: "flow.plan.select", tab: "flow.plan.tab", target: "plan-1" } as const
    const model: PlanCardNode = { id: nodeId, kind: "step", key: "key1_" + "0".repeat(64), tier: "sealed", status: "run", dependsOn: [] }
    const surface = render(<FlowGraphSurface nodes={[model]} drill={{ repo: "o/r", doors, onRunCommand }} />)
    act(() => (surface.querySelector(".react-flow__node") as HTMLElement).click())
    const pointer = received.pop()!
    expect(payloadFor(pointer.name, pointer.args)).toEqual({ payload: { cardId: "plan-1", nodeId } })
    const key = graphKeyAct("Enter", { ids: [nodeId], edges: [], focused: nodeId, doors })!
    expect(payloadFor(key.flow, key.args)).toEqual({ payload: { cardId: "plan-1", nodeId } })
    const drawer = render(<FlowGraphDrawer node={planDrawerNode({ ...model, id: "next", dependsOn: [nodeId] })}
      doors={doors} onRunCommand={onRunCommand} />)
    act(() => (drawer.querySelector(".flow-graph-depends-node") as HTMLElement).click())
    const dependency = received.pop()!
    expect(payloadFor(dependency.name, dependency.args)).toEqual({ payload: { cardId: "plan-1", nodeId } })
  }
})

describe("the node the run's graph has open", () => {
  test("is headed by the action tag the engine recorded, with the plan node id beneath", () => {
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(recordedNode(STEADY), recordedRun(STEADY))}
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    expect(host.querySelector(".flow-graph-drawer")?.getAttribute("data-node")).toBe(STEADY)
    expect(host.querySelector(".flow-graph-drawer-tag")?.textContent).toBe("gateway/graph/Steady")
    expect(host.querySelector(".flow-graph-drawer-id")?.textContent).toBe(STEADY)
    /* The engine's own settlement word, never a synonym (D-041). */
    expect(host.querySelector(".flow-graph-drawer-word")?.textContent).toBe("built")
  })

  test("shows the tab the card names, and the declaration when it names none", () => {
    const node = runDrawerNode(recordedNode(STEADY), recordedRun(STEADY))
    const opened = render(
      <FlowGraphDrawer node={node} doors={DOORS} records={RECORDED.rows} onRunCommand={() => {}} />
    )
    expect(opened.querySelector(".flow-graph-drawer-body")?.getAttribute("data-tab")).toBe("declaration")
    const events = render(
      <FlowGraphDrawer node={node} tab="events" doors={DOORS} records={RECORDED.rows} onRunCommand={() => {}} />
    )
    expect(events.querySelector(".flow-graph-drawer-body")?.getAttribute("data-tab")).toBe("events")
    expect(events.querySelector("[role='tab'][data-tab='events']")?.getAttribute("aria-selected")).toBe("true")
  })

  test("the declaration is the node's own tier, kind and dependencies, each a door back to the node", () => {
    const ran: Array<[string, string | undefined]> = []
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(recordedNode(STEADY), recordedRun(STEADY))}
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={(name, args) => ran.push([name, args])}
      />
    )
    expect(host.querySelector("[data-field='tier']")?.textContent).toBe("sealed")
    expect(host.querySelector("[data-field='kind']")?.textContent).toBe("ActionCall")
    /* The declared effect set the plan page carried: this node measures its boundary and names no path. */
    expect(host.querySelector("[data-field='boundary']")?.textContent).toBe("expected")
    expect(host.querySelector("[data-field='reads']")).toBeNull()
    expect(host.querySelector("[data-field='writes']")).toBeNull()
    const waits = [...host.querySelectorAll(".flow-graph-depends [data-flow]")]
    expect(waits.map((button) => button.textContent)).toEqual(["root.flow.andThen"])
    ;(waits[0] as HTMLButtonElement).click()
    expect(ran).toEqual([["runs.graph.select", "run-1 root.flow.andThen"]])
  })

  test("a tab with nothing behind it is absent", () => {
    /* The recording carries no declaration site, so the Code tab cannot exist. It
       does state the dispatches each node ran and what it settled with (D-052),
       so Attempts and Output do. */
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(recordedNode(STEADY), recordedRun(STEADY))}
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    expect(tabs(host)).toEqual(["declaration", "output", "events", "attempts"])
    expect(host.querySelector(".flow-graph-code")).toBeNull()
  })

  test("In states what went into the run: memory in and withheld, where it ran, the box's secret names; absent when nothing did", () => {
    const node = runDrawerNode(recordedNode(STEADY), recordedRun(STEADY))
    const inputs = {
      memory: { kept: [{ id: "wiki/auth/sessions", kind: "memory", relevance: 0.82 }], withheld: [{ id: "wiki/billing", kind: "memory", relevance: 0.12 }] },
      runsOn: "box-2",
      secrets: [{ name: "DEPLOY_TOKEN", hosts: ["api.vercel.com"] }]
    }
    const host = render(<FlowGraphDrawer node={node} doors={DOORS} records={RECORDED.rows} inputs={inputs} onRunCommand={() => {}} />)
    expect(tabs(host)).toEqual(["declaration", "in", "output", "events", "attempts"])
    /* Declaration stays the node's default; In is one tab over. */
    expect(host.querySelector(".flow-graph-drawer-body")?.getAttribute("data-tab")).toBe("declaration")
    render(<FlowGraphDrawer node={node} tab="in" doors={DOORS} records={RECORDED.rows} inputs={inputs} onRunCommand={() => {}} />)
    const opened = document.body.lastElementChild as HTMLElement
    expect(opened.querySelector("[data-testid='run-inputs-memory']")?.textContent).toBe("memory · 1 in · 1 withheld")
    expect([...opened.querySelectorAll("[aria-label='Memory'] li")].map((row) => row.textContent)).toEqual(["✓in: wiki/auth/sessions .82", "–withheld: wiki/billing .12"])
    expect(opened.querySelector("[data-testid='run-inputs-where']")?.textContent).toBe("runs on box-2")
    expect(opened.querySelector("[aria-label='Secrets']")?.textContent).toBe("⚷ DEPLOY_TOKEN api.vercel.com")
    const none = render(<FlowGraphDrawer node={node} doors={DOORS} records={RECORDED.rows} inputs={{ secrets: [] }} onRunCommand={() => {}} />)
    expect(tabs(none)).not.toContain("in")
  })

  test("the events are the node's own records, in journal order", () => {
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(recordedNode(STEADY), recordedRun(STEADY))}
        tab="events"
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    const rows = [...host.querySelectorAll(".flow-graph-events li")]
    expect(rows.map((row) => row.querySelector(".flow-graph-event-type")?.textContent))
      .toEqual(["node-scheduled", "node-settled"])
    expect(rows.at(-1)?.querySelector(".flow-graph-event-word")?.textContent).toBe("built")
    /* Another node's records are another node's business. */
    expect(host.textContent).not.toContain("root.flow.then.map.all.retried")
  })

  /*
   * The recording drove two executions and both name `root`: the wrapper's
   * `agent/run` and the fixture flow's own. A node id is an address within
   * ONE graph (FlowGraphStatus.ts), so the drawer reads only the execution
   * its node came from.
   */
  test("a node id two executions share reads only its own execution's records", () => {
    const found = graph()
    const scoped = render(
      <FlowGraphDrawer
        node={runDrawerNode(found.nodes.find((node) => node.id === "root")!, found.status.get("root"), found.executionId)}
        tab="events"
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    const scopedRows = [...scoped.querySelectorAll(".flow-graph-events li")]
    const everything = render(
      <FlowGraphDrawer
        node={runDrawerNode(found.nodes.find((node) => node.id === "root")!, found.status.get("root"))}
        tab="events"
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    expect(scopedRows.length).toBeGreaterThan(0)
    expect([...everything.querySelectorAll(".flow-graph-events li")].length).toBeGreaterThan(scopedRows.length)
  })

  /* A RECORDED settlement, replayed one generation on with its outcome changed: a rewind. */
  test("a rewind discards what the generation before it recorded", () => {
    const found = graph()
    const settled = RECORDED.rows.find((row) =>
      envelopeOf(row).eventType === "flows.engine.node-settled" &&
      envelopeOf(row).payload["nodeId"] === STEADY
    )!
    const envelope = envelopeOf(settled) as unknown as Record<string, unknown>
    const rewound: JournalRecord = {
      ...settled,
      sequence: 10_000,
      payload: {
        ...envelope,
        generation: 1,
        sequence: 10_000,
        payload: { ...(envelope["payload"] as Record<string, unknown>), outcome: "failed" }
      }
    }
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(found.nodes.find((node) => node.id === STEADY)!, found.status.get(STEADY), found.executionId)}
        tab="events"
        doors={DOORS}
        records={[...RECORDED.rows, rewound]}
        onRunCommand={() => {}}
      />
    )
    const rows = [...host.querySelectorAll(".flow-graph-events li")]
    expect(rows.map((row) => row.querySelector(".flow-graph-event-word")?.textContent)).toEqual(["failed"])
  })

  test("the attempts a node cannot be joined to are absent, and its own record joins them", () => {
    /*
     * D-052: `attempt-started` carries a step key digest and no node id, so
     * the only join is the digest the node's OWN record states. Take that
     * digest off the settlement and the tab has nothing behind it; put it
     * back and the attempt it names is listed.
     */
    const stripped = withoutDispatch(STEADY)
    const without = render(
      <FlowGraphDrawer node={foldedNode(stripped, STEADY)} doors={DOORS} records={stripped} onRunCommand={() => {}} />
    )
    expect(tabs(without)).not.toContain("attempts")
    const rows = withDispatch(STEADY, [dispatchedDigest(STEADY)])
    const joined = render(
      <FlowGraphDrawer
        node={foldedNode(rows, STEADY)}
        tab="attempts"
        doors={DOORS}
        records={rows}
        onRunCommand={() => {}}
      />
    )
    expect(tabs(joined)).toContain("attempts")
    /* One attempt, recorded BEFORE the settlement that named its dispatch. */
    expect([...joined.querySelectorAll(".flow-graph-attempts li")].map((row) => row.getAttribute("data-attempt")))
      .toEqual(["1"])
    expect(joined.querySelector(".flow-graph-attempts li")?.getAttribute("data-state")).toBe("succeeded")
  })

  test("every control is a flow door, and the close clears the selection", () => {
    const ran: Array<[string, string | undefined]> = []
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(recordedNode(STEADY), recordedRun(STEADY))}
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={(name, args) => ran.push([name, args])}
      />
    )
    for (const control of host.querySelectorAll("button")) expect(control.getAttribute("data-flow")).not.toBeNull()
    const close = host.querySelector(".flow-graph-drawer-close") as HTMLButtonElement
    close.click()
    expect(ran).toEqual([["runs.graph.select", "run-1"]])
    ;(host.querySelector("[role='tab'][data-tab='events']") as HTMLButtonElement).click()
    expect(ran.at(-1)).toEqual(["runs.graph.tab", "run-1 events"])
  })
})

describe("the Code tab", () => {
  const DECLARED = { path: "flows/graph-fixture/flow.ts", line: 42 }

  test("opens the declaration the engine recorded, anchored at its line", () => {
    const rows = withProvenance(STEADY, DECLARED)
    const found = runGraphOf(foldRunGraph(rows), { planNodeIds: RECORDED.plan.nodes.map((node) => node.id) })!
    const ran: Array<[string, string | undefined]> = []
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(found.nodes.find((node) => node.id === STEADY)!, found.status.get(STEADY))}
        tab="code"
        doors={DOORS}
        sourceRevision={REVISION}
        records={rows}
        onRunCommand={(name, args) => ran.push([name, args])}
      />
    )
    expect(tabs(host)).toContain("code")
    expect(host.querySelector(".flow-graph-code-path")?.textContent).toBe("flows/graph-fixture/flow.ts:42")
    /* The plan node id, as the AST path it is: `root › flow › then › map …`. */
    expect([...host.querySelectorAll(".flow-graph-code-crumbs li")].map((crumb) => crumb.textContent))
      .toEqual(["root", "flow", "then", "map", "all", "steady"])
    /*
     * The door under the site is THIS tab's own, because the read it asks
     * for is the read at the recorded revision. `files.read` names a path
     * and no revision, so it answers the working tree (D-068).
     */
    ;(host.querySelector(`.flow-graph-code [data-flow='${DOORS.tab}']`) as HTMLButtonElement).click()
    expect(ran).toEqual([[DOORS.tab, `${DOORS.target} code`]])
  })

  /*
   * D-054: the tab is a VIEWER, not a door to one. The bytes come off the
   * file card the app already reads, so the hover and definition gestures
   * the file card binds work here too and their answers land on the same
   * payload.
   */
  test("renders the declared file inline, anchored at the node's line", () => {
    const rows = withProvenance(STEADY, DECLARED)
    const found = runGraphOf(foldRunGraph(rows), { planNodeIds: RECORDED.plan.nodes.map((node) => node.id) })!
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(found.nodes.find((node) => node.id === STEADY)!, found.status.get(STEADY))}
        tab="code"
        doors={DOORS}
        sourceRevision={REVISION}
        file={{ repo: "o/r", path: DECLARED.path, ref: REVISION, content: "const steady = 1\n", truncated: false }}
        records={rows}
        onRunCommand={() => {}}
      />
    )
    const inline = host.querySelector(".flow-graph-code-file")
    expect(inline).not.toBeNull()
    expect(inline?.getAttribute("data-line")).toBe("42")
    /*
     * The door to the whole file is still there, still a flow, and it is THIS
     * tab's door: `files.read` names a path and no revision, so it would
     * answer the working tree (D-068).
     */
    expect(host.querySelector(".flow-graph-code-open")?.getAttribute("data-flow")).toBe(DOORS.tab)
  })

  test("without the file in hand it draws the door that reads it, and no viewer", () => {
    const rows = withProvenance(STEADY, DECLARED)
    const found = runGraphOf(foldRunGraph(rows), { planNodeIds: RECORDED.plan.nodes.map((node) => node.id) })!
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(found.nodes.find((node) => node.id === STEADY)!, found.status.get(STEADY))}
        tab="code"
        doors={DOORS}
        sourceRevision={REVISION}
        records={rows}
        onRunCommand={() => {}}
      />
    )
    expect(host.querySelector(".flow-graph-code-file")).toBeNull()
    expect(host.querySelector(".flow-graph-code-open")).not.toBeNull()
  })

  test("a refused read is stated where the file would be, with the door that asks again", () => {
    const rows = withProvenance(STEADY, DECLARED)
    const found = runGraphOf(foldRunGraph(rows), { planNodeIds: RECORDED.plan.nodes.map((node) => node.id) })!
    const ran: Array<[string, string | undefined]> = []
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(found.nodes.find((node) => node.id === STEADY)!, found.status.get(STEADY))}
        tab="code"
        doors={DOORS}
        sourceRevision={REVISION}
        codeError={{ path: DECLARED.path, message: "Path not found: flows/graph-fixture/flow.ts in o/r" }}
        records={rows}
        onRunCommand={(name, args) => ran.push([name, args])}
      />
    )
    const notice = host.querySelector<HTMLElement>(".flow-graph-code-error")!
    /* The reader's words are detail: the sentence is the product's, the text waits behind Details. */
    expect(notice.querySelector("p")?.textContent).toBe("Smithers could not read this file. Not your fault.")
    expect(notice.querySelector("p")?.textContent).not.toContain("Path not found")
    expect(notice.querySelector("details:not([open]) pre")?.textContent).toBe("Path not found: flows/graph-fixture/flow.ts in o/r")
    expect(notice.dataset.failure).toBe("FlowGraphCodeReadFailed")
    expect(notice.dataset.fault).toBe("infra")
    expect(notice.querySelectorAll("button")).toHaveLength(0)
    ;(host.querySelector(".flow-graph-code-open") as HTMLButtonElement).click()
    /* Asking again is asking the SAME question: this tab, at its revision. */
    expect(ran).toEqual([[DOORS.tab, `${DOORS.target} code`]])
  })

  test("a refusal about another file is not this node's", () => {
    const rows = withProvenance(STEADY, DECLARED)
    const found = runGraphOf(foldRunGraph(rows), { planNodeIds: RECORDED.plan.nodes.map((node) => node.id) })!
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(found.nodes.find((node) => node.id === STEADY)!, found.status.get(STEADY))}
        tab="code"
        doors={DOORS}
        sourceRevision={REVISION}
        codeError={{ path: "flows/other/flow.ts", message: "Path not found" }}
        records={rows}
        onRunCommand={() => {}}
      />
    )
    expect(host.querySelector(".flow-graph-code-error")).toBeNull()
  })

  test("a binary file is stated, not printed", () => {
    const rows = withProvenance(STEADY, DECLARED)
    const found = runGraphOf(foldRunGraph(rows), { planNodeIds: RECORDED.plan.nodes.map((node) => node.id) })!
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(found.nodes.find((node) => node.id === STEADY)!, found.status.get(STEADY))}
        tab="code"
        doors={DOORS}
        sourceRevision={REVISION}
        file={{ repo: "o/r", path: DECLARED.path, ref: REVISION, content: "", truncated: false, binary: true }}
        records={rows}
        onRunCommand={() => {}}
      />
    )
    expect(host.querySelector(".flow-graph-code-file")).toBeNull()
  })

  test("is absent when the engine recorded no declaration site", () => {
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(recordedNode(STEADY), recordedRun(STEADY))}
        tab="code"
        doors={DOORS}
        sourceRevision={REVISION}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    expect(tabs(host)).not.toContain("code")
    /* A tab the node cannot fill falls back to the one it can, never to an empty panel. */
    expect(host.querySelector(".flow-graph-drawer-body")?.getAttribute("data-tab")).toBe("declaration")
  })

  /*
   * D-068: a site says where a node was declared, and only a revision says
   * which bytes were at that line. Without one the only file a reader could
   * be shown is the working tree's, which is not what was keyed or driven,
   * so there is no tab and nothing claims to be that code.
   */
  test("is absent when nothing says which revision the site was read at", () => {
    const rows = withProvenance(STEADY, DECLARED, null)
    const found = runGraphOf(foldRunGraph(rows), { planNodeIds: RECORDED.plan.nodes.map((node) => node.id) })!
    expect(found.sourceRevision).toBeUndefined()
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(found.nodes.find((node) => node.id === STEADY)!, found.status.get(STEADY))}
        tab="code"
        doors={DOORS}
        records={rows}
        onRunCommand={() => {}}
      />
    )
    expect(tabs(host)).not.toContain("code")
    expect(host.querySelector(".flow-graph-code")).toBeNull()
  })

  /*
   * And a file read at another revision — or at none, which is the working
   * tree — is a different file. The viewer stays empty and the door to read
   * the whole file stands where it was.
   */
  test("does not render a file read at another revision", () => {
    const rows = withProvenance(STEADY, DECLARED)
    const found = runGraphOf(foldRunGraph(rows), { planNodeIds: RECORDED.plan.nodes.map((node) => node.id) })!
    for (const ref of [undefined, "c".repeat(40)]) {
      const host = render(
        <FlowGraphDrawer
          node={runDrawerNode(found.nodes.find((node) => node.id === STEADY)!, found.status.get(STEADY))}
          tab="code"
          doors={DOORS}
          sourceRevision={REVISION}
          file={fileFor(
            [{
              id: "file-1",
              kind: "file",
              title: "File",
              status: "active",
              createdAt: 0,
              ordinal: 0,
              payload: { repo: "o/r", path: DECLARED.path, content: "const steady = 1\n", truncated: false, ...(ref === undefined ? {} : { ref }) }
            }],
            "o/r",
            DECLARED,
            REVISION
          )}
          records={rows}
          onRunCommand={() => {}}
        />
      )
      expect(host.querySelector(".flow-graph-code-file")).toBeNull()
      expect(host.querySelector(".flow-graph-code-open")).not.toBeNull()
    }
  })
})

/*
 * D-052 made a node's evidence joinable: the settlement names the dispatches
 * it ran under and carries a bounded, redacted preview of what it settled
 * with. Both tabs below read the RECORDED rows, unedited.
 */
const RETRIED = "root.flow.then.map.all.retried"
const FAILED = "root.flow.then.map.all.recovered.protected"

describe("the Attempts tab", () => {
  test("is one row per attempt the node's own dispatches recorded, with its state and what it took", () => {
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(recordedNode(RETRIED), recordedRun(RETRIED), graph().executionId)}
        tab="attempts"
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    const rows = [...host.querySelectorAll(".flow-graph-attempts li")]
    expect(rows.map((row) => row.getAttribute("data-attempt"))).toEqual(["1", "2"])
    /* The recorded run failed this step once and then succeeded. */
    expect(rows.map((row) => row.getAttribute("data-state"))).toEqual(["failed", "succeeded"])
    expect(rows.map((row) => row.querySelector(".flow-graph-attempt-took")?.textContent)).toEqual(["2ms", "1ms"])
  })

  test("the strip carries the engine's own attempt count, not the number of rows it found", () => {
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(recordedNode(RETRIED), recordedRun(RETRIED), graph().executionId)}
        tab="attempts"
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    expect(host.querySelector("[role='tab'][data-tab='attempts'] .flow-graph-tab-count")?.textContent).toBe("2")
    /* One attempt is one attempt: a node that ran once wears no count at all. */
    const once = render(
      <FlowGraphDrawer
        node={runDrawerNode(recordedNode(STEADY), recordedRun(STEADY), graph().executionId)}
        tab="attempts"
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    expect(once.querySelector("[role='tab'][data-tab='attempts'] .flow-graph-tab-count")).toBeNull()
  })

  test("is absent where the node's record claims no dispatch of its own", () => {
    const stripped = withoutDispatch(STEADY)
    const host = render(
      <FlowGraphDrawer
        node={foldedNode(stripped, STEADY)}
        doors={DOORS}
        records={stripped}
        onRunCommand={() => {}}
      />
    )
    expect(tabs(host)).not.toContain("attempts")
  })
})

describe("the Output tab", () => {
  test("is the bounded preview the settlement recorded, with the size it was cut from", () => {
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(recordedNode(STEADY), recordedRun(STEADY), graph().executionId)}
        tab="output"
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    expect(tabs(host)).toContain("output")
    expect(host.querySelector(".flow-graph-output-preview")?.textContent).toBe("\"steady:recorded\"")
    expect(host.querySelector(".flow-graph-output-bytes")?.textContent).toBe("17 B")
    /* Nothing was cut, so nothing says it was. */
    expect(host.querySelector(".flow-graph-output-truncated")).toBeNull()
  })

  test("a failed node's output is its bounded typed error, marked as the failure it is", () => {
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(recordedNode(FAILED), recordedRun(FAILED), graph().executionId)}
        tab="output"
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    expect(host.querySelector(".flow-graph-output")?.getAttribute("data-state")).toBe("failed")
    expect(host.querySelector(".flow-graph-output-preview")?.textContent).toBe("\"doomed:recorded\"")
  })

  test("says a preview was cut, and by how much", () => {
    const run = recordedRun(STEADY)!
    const host = render(
      <FlowGraphDrawer
        node={{
          ...runDrawerNode(recordedNode(STEADY), run, graph().executionId),
          result: { preview: "\"stead", bytes: 70_000, truncated: true }
        }}
        tab="output"
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    expect(host.querySelector(".flow-graph-output-truncated")).not.toBeNull()
    expect(host.querySelector(".flow-graph-output-bytes")?.textContent).toBe("68.4 KiB")
  })

  test("is absent where the node's record carries no result at all", () => {
    const host = render(
      <FlowGraphDrawer
        node={{ ...runDrawerNode(recordedNode(STEADY), recordedRun(STEADY), graph().executionId), result: undefined }}
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    expect(tabs(host)).not.toContain("output")
  })
})

describe("what a node's history says it costs", () => {
  const MEASURED = { text: "~1.0s", detail: "p50 of 24 runs · p90 1.5s", samples: 24, p50Ms: 1_000, p90Ms: 1_500 }

  test("the head states the p50 and how many runs it is from (D-053)", () => {
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(recordedNode(STEADY), recordedRun(STEADY), graph().executionId)}
        duration={MEASURED}
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    const line = host.querySelector(".flow-graph-drawer-duration")
    expect(line?.textContent).toContain("~1.0s")
    /* The evidence behind the number, in the words the tooltip spells out. */
    expect(line?.textContent).toContain("24 runs")
    expect(line?.getAttribute("title")).toBe("p50 of 24 runs · p90 1.5s")
  })

  test("a node nothing measured says nothing at all", () => {
    const host = render(
      <FlowGraphDrawer
        node={runDrawerNode(recordedNode(STEADY), recordedRun(STEADY), graph().executionId)}
        doors={DOORS}
        records={RECORDED.rows}
        onRunCommand={() => {}}
      />
    )
    expect(host.querySelector(".flow-graph-drawer-duration")).toBeNull()
  })
})

describe("the node a plan has open", () => {
  const node = (over: Partial<PlanCardNode> = {}): PlanCardNode => ({
    id: "root.flow.andThen",
    kind: "step",
    key: `key1_${"0".repeat(64)}`,
    dependsOn: ["root.flow"],
    tier: "compensable",
    status: "run",
    action: "graph/Gate",
    ...over
  })

  test("shows the plan's own key and verdict, and no tab the plan cannot fill", () => {
    const host = render(
      <FlowGraphDrawer node={planDrawerNode(node())} doors={PLAN_DOORS} onRunCommand={() => {}} />
    )
    expect(host.querySelector(".flow-graph-drawer-tag")?.textContent).toBe("graph/Gate")
    expect(host.querySelector(".flow-graph-drawer-word")?.textContent).toBe("run")
    expect(host.querySelector("[data-field='key']")?.textContent).toBe(`key1_${"0".repeat(64)}`)
    /* A plan has no journal, so it has no events; and the wire carries no declaration site for it. */
    expect(tabs(host)).toEqual(["declaration"])
  })

  test("its doors address the plan's card, never a run", () => {
    const ran: Array<[string, string | undefined]> = []
    const host = render(
      <FlowGraphDrawer
        node={planDrawerNode(node())}
        doors={PLAN_DOORS}
        onRunCommand={(name, args) => ran.push([name, args])}
      />
    )
    ;(host.querySelector(".flow-graph-depends [data-flow]") as HTMLButtonElement).click()
    expect(ran).toEqual([["flow.plan.select", "flow-plan-1 root.flow"]])
  })

  /*
   * D-054: the plan carries its own declaration sites now, beside the edges
   * and outside the digest, so a plan node drills into code exactly as a
   * recorded one does.
   */
  test("opens the code of a node the plan says where it was declared", () => {
    const host = render(
      <FlowGraphDrawer
        node={planDrawerNode(node(), { path: "flows/review/flow.ts", line: 12 })}
        tab="code"
        doors={PLAN_DOORS}
        sourceRevision={REVISION}
        onRunCommand={() => {}}
      />
    )
    expect(tabs(host)).toContain("code")
    expect(host.querySelector(".flow-graph-code-path")?.textContent).toBe("flows/review/flow.ts:12")
  })

  /*
   * D-068: the site alone is half the answer. A plan whose host could not
   * name the revision it walked reports the site and no revision, and the
   * reader is shown no code rather than the working tree's.
   */
  test("shows no code for a site the plan named no revision for", () => {
    const host = render(
      <FlowGraphDrawer
        node={planDrawerNode(node(), { path: "flows/review/flow.ts", line: 12 })}
        tab="code"
        doors={PLAN_DOORS}
        onRunCommand={() => {}}
      />
    )
    expect(tabs(host)).not.toContain("code")
    expect(host.querySelector(".flow-graph-code")).toBeNull()
  })

  test("a merge node names no action and is headed by its address", () => {
    const host = render(
      <FlowGraphDrawer
        node={planDrawerNode(node({ id: "root.merge", kind: "merge", action: undefined, dependsOn: [] }))}
        doors={PLAN_DOORS}
        onRunCommand={() => {}}
      />
    )
    expect(host.querySelector(".flow-graph-drawer-tag")?.textContent).toBe("root.merge")
    expect(host.querySelector(".flow-graph-depends")).toBeNull()
  })
})

describe("the drawer owns no application state", () => {
  test("nothing in it is a useState or a useEffect", () => {
    const source = readFileSync(new URL("./FlowGraphDrawer.tsx", import.meta.url), "utf8")
    expect(source).not.toContain("useState")
    expect(source).not.toContain("useEffect")
  })
})

/*
 * The canvas half of the drill-in: a click, a key and a schedule's node, on
 * the plan card's own surface. The surface is imported directly rather than
 * through the card's Suspense boundary, because that boundary is what keeps
 * xyflow out of the main chunk.
 */
describe("the plan canvas drills in", () => {
  const planNode = (id: string, dependsOn: Array<string> = [], over: Partial<PlanCardNode> = {}): PlanCardNode => ({
    id,
    kind: "step",
    key: `key1_${"0".repeat(64)}`,
    dependsOn,
    tier: "sealed",
    status: "run",
    ...over
  })
  const NODES = [planNode("a", [], { action: "files/read" }), planNode("b", ["a"], { action: "agent/run" })]
  const drill = (over: Partial<GraphDrill> = {}): GraphDrill => ({
    repo: "o/r",
    doors: PLAN_DOORS,
    onRunCommand: () => {},
    ...over
  })

  const TRIGGER: TriggerGraphPart = {
    nodes: [{
      id: "trigger:nightly",
      state: "armed",
      row: { id: "nightly", flowId: "review", cron: "0 9 * * 1-5", timezone: "UTC", enabled: true }
    }],
    edges: [{ id: "trigger:nightly->a", from: "trigger:nightly", to: "a" }]
  }

  test("clicking a node opens it through the flow, never through component state", () => {
    const ran: Array<[string, string | undefined]> = []
    const host = render(<FlowGraphSurface nodes={NODES} drill={drill({ onRunCommand: (name, args) => ran.push([name, args]) })} />)
    ;(host.querySelector("[data-node='b']") as HTMLElement).click()
    expect(ran).toEqual([["flow.plan.select", "flow-plan-1 b"]])
  })

  test("the canvas hands the drawer the declaration site the plan reported", () => {
    const host = render(
      <FlowGraphSurface
        nodes={NODES}
        graph={{
          edges: [{ from: "a", to: "b", reason: "value" }],
          nodes: [{ id: "a", declaredAt: { path: "flows/review/flow.ts", line: 12 } }],
          sourceRevision: REVISION
        }}
        drill={drill({ selected: "a", tab: "code", sourceRevision: REVISION })}
      />
    )
    expect(host.querySelector(".flow-graph-code-path")?.textContent).toBe("flows/review/flow.ts:12")
    /* A node the plan named no site for has no Code tab at all (D-035). */
    const other = render(
      <FlowGraphSurface
        nodes={NODES}
        graph={{
          edges: [{ from: "a", to: "b", reason: "value" }],
          nodes: [{ id: "a", declaredAt: { path: "flows/review/flow.ts", line: 12 } }],
          sourceRevision: REVISION
        }}
        drill={drill({ selected: "b", tab: "code", sourceRevision: REVISION })}
      />
    )
    expect(tabs(other)).not.toContain("code")
    /* And neither does a site the plan named no revision for (D-068). */
    const unbound = render(
      <FlowGraphSurface
        nodes={NODES}
        graph={{
          edges: [{ from: "a", to: "b", reason: "value" }],
          nodes: [{ id: "a", declaredAt: { path: "flows/review/flow.ts", line: 12 } }]
        }}
        drill={drill({ selected: "a", tab: "code" })}
      />
    )
    expect(tabs(unbound)).not.toContain("code")
  })

  test("the node the card names wears the selection and opens its drawer", () => {
    const host = render(<FlowGraphSurface nodes={NODES} drill={drill({ selected: "a", tab: "declaration" })} />)
    expect(host.querySelector("[data-node='a']")?.getAttribute("data-selected")).toBe("true")
    expect(host.querySelector("[data-node='b']")?.getAttribute("data-selected")).toBe("false")
    expect(host.querySelector(".flow-graph-drawer")?.getAttribute("data-node")).toBe("a")
    expect(host.querySelector(".flow-graph-drawer-tag")?.textContent).toBe("files/read")
  })

  test("a schedule is a node of its own, and its drawer is the panel that knows what a schedule is", () => {
    const ran: Array<[string, string | undefined]> = []
    const host = render(
      <FlowGraphSurface
        nodes={NODES}
        triggers={TRIGGER}
        drill={drill({ selected: "trigger:nightly", onRunCommand: (name, args) => ran.push([name, args]) })}
      />
    )
    const node = host.querySelector("[data-node='trigger:nightly']")
    expect(node?.getAttribute("data-trigger-state")).toBe("armed")
    expect(node?.textContent).toContain("Every weekday at 09:00 UTC")
    /* The schedule's own panel, opened as this node's drawer (D-031). */
    expect(host.querySelector(".flow-graph-drawer [data-trigger='nightly']")).not.toBeNull()
    ;(host.querySelector(".flow-graph-drawer-close") as HTMLButtonElement).click()
    expect(ran).toEqual([["flow.plan.select", "flow-plan-1"]])
  })

  /*
   * Each node opens a drawer, so each node is a button, and the one that is
   * open says so (flowGraph/NodeAria.ts). React Flow owns the element a
   * reader tabs to, so the role and the open state are written onto that
   * wrapper and the node card inside it carries the selection for the ring.
   */
  test("every drawn node is a button, and the open one says it is open", () => {
    const host = render(<FlowGraphSurface nodes={NODES} triggers={TRIGGER} drill={drill({ selected: "b" })} />)
    const drawn = [...host.querySelectorAll("[role='button'][data-id]")]
    expect(drawn.map((node) => node.getAttribute("data-id")).sort()).toEqual(["a", "b", "trigger:nightly"])
    expect(drawn.flatMap((node) =>
      node.getAttribute("aria-expanded") === "true" ? [node.getAttribute("data-id")] : []
    )).toEqual(["b"])
    expect(host.querySelector("[data-node='b']")?.getAttribute("data-selected")).toBe("true")
  })

  test("the arrows walk the edges, Enter and Space toggle the focused node, and Escape closes", () => {
    const keys = (selected: string | undefined, presses: ReadonlyArray<[string, string | undefined]>) => {
      const ran: Array<[string, string | undefined]> = []
      const host = render(
        <FlowGraphSurface
          nodes={NODES}
          drill={drill({
            ...(selected === undefined ? {} : { selected }),
            onRunCommand: (name, args) => ran.push([name, args])
          })}
        />
      )
      for (const [key, from] of presses) {
        const target = from === undefined ? host.querySelector(".flow-plan-canvas")! : host.querySelector(`[data-node='${from}']`)!
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }))
      }
      return ran
    }
    /* Down walks the edge a → b; up walks the same edge back. */
    expect(keys("a", [["ArrowDown", undefined]])).toEqual([["flow.plan.select", "flow-plan-1 b"]])
    expect(keys("b", [["ArrowUp", undefined]])).toEqual([["flow.plan.select", "flow-plan-1 a"]])
    /* The end of a branch is the end: a key with nowhere to go runs nothing. */
    expect(keys("b", [["ArrowDown", undefined]])).toEqual([])
    /* With nothing open the first arrow opens the first node the layout drew. */
    expect(keys(undefined, [["ArrowDown", undefined]])).toEqual([["flow.plan.select", "flow-plan-1 a"]])
    /* Enter opens the node the focus is on, and Escape closes what is open. */
    expect(keys("a", [["Enter", "b"], ["Escape", undefined]]))
      .toEqual([["flow.plan.select", "flow-plan-1 b"], ["flow.plan.select", "flow-plan-1"]])
    /* A node is a button, and a button answers Space as it answers Enter. */
    expect(keys("a", [[" ", "b"]])).toEqual([["flow.plan.select", "flow-plan-1 b"]])
    /*
     * The open node says `aria-expanded="true"`, which advertises a toggle,
     * so either key on it closes the drawer rather than running nothing.
     */
    expect(keys("b", [["Enter", "b"]])).toEqual([["flow.plan.select", "flow-plan-1"]])
    expect(keys("b", [[" ", "b"]])).toEqual([["flow.plan.select", "flow-plan-1"]])
    /* Nothing open is nothing to close. */
    expect(keys(undefined, [["Escape", undefined]])).toEqual([])
    /* A key that arrived on no node at all opens nothing. */
    expect(keys("a", [[" ", undefined]])).toEqual([])
  })

  /*
   * The focus a reader actually has. React Flow owns the focusable element —
   * it writes `tabindex` onto its OWN node wrapper — and `data-node` is on
   * the node drawn inside it, so every keystroke a person makes arrives from
   * the wrapper and not from the drawn node. A focus read only upwards finds
   * nothing there, which is why Enter opened nothing in a browser while the
   * case above passed.
   */
  test("Enter opens the node whose React Flow wrapper has the focus", () => {
    const ran: Array<[string, string | undefined]> = []
    const host = render(
      <FlowGraphSurface
        nodes={NODES}
        drill={drill({ selected: "a", onRunCommand: (name, args) => ran.push([name, args]) })}
      />
    )
    const wrapper = host.querySelector("[data-node='b']")!.closest(".react-flow__node")!
    expect(wrapper.getAttribute("tabindex")).toBe("0")
    wrapper.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(ran).toEqual([["flow.plan.select", "flow-plan-1 b"]])

    /* The canvas itself holds every node, so it is not one: Enter on the
     * background opens whatever was already open, which is nothing. */
    ran.length = 0
    host.querySelector(".flow-plan-canvas")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(ran).toEqual([])
  })

  /* D-038 / D-050: with the flag off the canvas is the canvas it was. */
  test("without the drill-in there is no selection model, no schedule node and no drawer", () => {
    const host = render(<FlowGraphSurface nodes={NODES} triggers={TRIGGER} />)
    expect(host.querySelector("[role='button'][data-id]")).toBeNull()
    expect(host.querySelector("[role='region']")).not.toBeNull()
    expect(host.querySelector(".flow-graph-drawer")).toBeNull()
    expect(host.querySelector("[data-node='a']")?.getAttribute("data-selected")).toBe("false")
    expect(host.querySelector("[data-node='a']")?.getAttribute("role")).toBeNull()
  })
})

/* The same drill-in on the run's canvas, over the run the engine recorded. */
describe("the run canvas drills in", () => {
  const runDrill = (over: Partial<GraphDrill> = {}): GraphDrill => ({
    repo: "o/r",
    doors: DOORS,
    onRunCommand: () => {},
    ...over
  })

  test("the open node's drawer reads the run's own journal", () => {
    const found = graph()
    const host = render(
      <FlowRunGraphSurface
        nodes={found.nodes}
        edges={found.edges}
        status={found.status}
        records={RECORDED.rows}
        drill={runDrill({ selected: STEADY, tab: "events" })}
      />
    )
    expect(host.querySelector(".flow-graph-drawer")?.getAttribute("data-node")).toBe(STEADY)
    expect([...host.querySelectorAll(".flow-graph-events .flow-graph-event-type")].map((row) => row.textContent))
      .toEqual(["node-scheduled", "node-settled"])
    expect(host.querySelector(`[data-node='${STEADY}']`)?.getAttribute("data-selected")).toBe("true")
  })

  test("clicking a node opens it through the run's own flow", () => {
    const found = graph()
    const ran: Array<[string, string | undefined]> = []
    const host = render(
      <FlowRunGraphSurface
        nodes={found.nodes}
        edges={found.edges}
        status={found.status}
        drill={runDrill({ onRunCommand: (name, args) => ran.push([name, args]) })}
      />
    )
    ;(host.querySelector(`[data-node='${STEADY}']`) as HTMLElement).click()
    expect(ran).toEqual([["runs.graph.select", `run-1 ${STEADY}`]])
  })
})
