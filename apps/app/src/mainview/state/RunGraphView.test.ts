/*
 * The run card's graph view, through the real controller.
 *
 * Three claims: a launch snapshots the plan it was approved on onto the run it
 * started, so the graph draws before the first event arrives; re-opening the
 * run keeps that plan, the view and the camera; and both reader gestures are
 * flows with their actor recorded, never component state.
 *
 * The plan node below is the control plane's own shape, not the card's — the
 * reduction to the drawn fields is what this lane is asserting.
 */
import { describe, expect, test } from "bun:test"
import type { Card } from "@smthrs/rpc/Cards"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { json, loadBox, memoryStorage, settle, silentAgent, waitFor } from "./TestFixtures"
import { readFileSync } from "node:fs"

const createAppController = scopedControllers()
const webStore = () => createAppStore({ kind: "localStorage", storage: memoryStorage() })

const REPO = "codeplanesmithers/smithers-demo"
const FLOW = "review-pr"
const RUN = "run-1"

const said = (outcome: { status: string; value?: string; error?: string }): string =>
  outcome.status === "failed" ? (outcome.error ?? "") : (outcome.value ?? "")

/** One node in the control plane's own shape (FlowPlanBackground.test.ts). */
const planNode = (id: string, action: string, dependsOn: ReadonlyArray<string> = [], key = "0".repeat(64)) => ({
  id,
  kind: "step",
  key: `key1_${key}`,
  material: { version: "flows/key-material/v2", kind: "sealed", body: { action }, inputs: [], layers: [], capabilities: [] },
  effects: { reads: [], writes: [], boundaryMode: "hard" },
  dependsOn,
  conflicts: [],
  strategy: "serialize",
  runtime: "delay-rebase",
  priority: 0,
  generation: 0,
  status: "run"
})

const NODES = [planNode("gate", "graph/Gate"), planNode("steady", "graph/Steady", ["gate"], "1".repeat(64))]

/** A relay double answering the four procedures a launch and a re-open ride. */
const relay = (
  options: {
    readonly nodes?: ReadonlyArray<unknown>
    /** The graph the plan door answered with, when this workspace reports one. */
    readonly graph?: unknown
  } = {}
) => {
  const rows = (projection: string, values: ReadonlyArray<unknown>): Response =>
    json(200, { ok: true, payload: { cursor: { projection, runId: null, value: 0 }, rows: values } })
  const procedure = (name: string, payload: Record<string, unknown>): Response => {
    switch (name) {
      case "List":
        return json(200, { ok: true, payload: { _tag: "flows", items: [{ flowId: FLOW, description: "" }] } })
      case "Plan":
        return json(200, {
          ok: true,
          payload: {
            planId: "plan-1",
            flowId: FLOW,
            digest: "d".repeat(64),
            inputSummary: "{}",
            envelope: { capabilities: [], flows: [], budget: {} },
            deployClass: false,
            nodes: options.nodes ?? NODES,
            ...(options.graph === undefined ? {} : { graph: options.graph }),
            approval: {
              target: { _tag: "Plan", planId: "plan-1", digest: "d".repeat(64), envelope: { capabilities: [], flows: [], budget: {} } },
              scope: "run",
              idempotencyKey: "approve:plan-1"
            }
          }
        })
      case "Run":
        return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: RUN } })
      case "Approval.Submit":
        return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } })
      case "Projection.Snapshot": {
        const selector = (payload.selector ?? {}) as { _tag?: string }
        if (selector._tag === "run-summary") {
          return rows("run-summary", [{
            runId: RUN,
            flowId: FLOW,
            status: "running",
            createdAt: 1,
            updatedAt: 2,
            turns: 0,
            calls: 0,
            callsFailed: 0,
            editsAttempted: 0,
            editsSucceeded: 0,
            inputTokens: 0,
            outputTokens: 0,
            verdict: "running",
            diagnosis: "Verdict   running."
          }])
        }
        return rows(String(selector._tag), [])
      }
      default:
        return json(200, { ok: false, error: { message: `no ${name}` } })
    }
  }
  const services: AppServices = {
    workflowPollMs: 1,
    toastDebounceMs: 0,
    toastAutoDismissMs: 10_000,
    fetchImpl: async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const absolute = new URL(url, "https://app.test")
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (absolute.pathname.endsWith("/contents/.smithers/factory.json")) return json(404, { status: "error", message: "no projection" })
      if (absolute.pathname === "/api/workflow/provision") return json(200, { status: "ready", repo: body?.repo, gatewayId: "gw-1" })
      if (absolute.pathname === "/api/workflow/rpc") {
        return procedure(String(body.procedure), (body.payload ?? {}) as Record<string, unknown>)
      }
      return json(404, { status: "error", message: `no stub for ${absolute.pathname}` })
    }
  }
  return { services }
}

const signIn = async (store: Awaited<ReturnType<typeof webStore>>) => {
  store.dispatch({
    type: "identity.session.loaded",
    actor: "system",
    state: "signed-in",
    login: "codeplanesmithers",
    admin: false,
    scopesPlain: null
  })
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: REPO, org: REPO.split("/")[0] ?? "", ownerKind: "user", name: REPO.split("/")[1] ?? "", head: null }]
  })
  await loadBox(store, REPO)
  await settle(2)
}

const runCard = (store: Awaited<ReturnType<typeof webStore>>): Extract<Card, { kind: "run-trace" }> | undefined => {
  const card = [...store.collections.cards.values()].find(card => card.kind === "run-trace" && card.payload.runId === RUN)
  return card?.kind === "run-trace" ? card : undefined
}

const launched = async (
  options: {
    readonly nodes?: ReadonlyArray<unknown>
    readonly graph?: unknown
  } = {}
) => {
  const store = await webStore()
  const controller = createAppController(store, silentAgent, relay(options).services)
  await signIn(store)
  await controller.commands.run("flow.run", FLOW)
  await waitFor(() => runCard(store)?.payload.phase === "running")
  return { store, controller }
}

describe("a launch snapshots the plan onto the run it started", () => {
  test("keeps the drawn fields of every plan node, and the plan's own identity", async () => {
    const { store } = await launched()
    expect(runCard(store)?.payload.plan).toEqual({
      planId: "plan-1",
      digest: "d".repeat(64),
      nodes: [
        { id: "gate", kind: "step", key: NODES[0]!.key, dependsOn: [], tier: "sealed", action: "graph/Gate", status: "run" },
        { id: "steady", kind: "step", key: NODES[1]!.key, dependsOn: ["gate"], tier: "sealed", action: "graph/Steady", status: "run" }
      ]
    })
  })

  /*
   * The labelled edges and the declaration sites are the graph builder's own
   * observations, and the plan door is already told them. Dropping them here
   * left the card with `dependsOn`, which says which nodes wait and never
   * why, so the graph drawn before the first event could state no reason for
   * any edge and the drawer could open no code.
   */
  test("keeps the labelled edges and the declaration sites that answer carried", async () => {
    const { store } = await launched({
      graph: {
        edges: [{ from: "gate", to: "steady", reason: "continuation" }],
        nodes: [{ id: "gate", declaredAt: { path: "flows/review.ts", line: 8 } }, { id: "steady" }]
      }
    })
    expect(runCard(store)?.payload.plan?.graph).toEqual({
      edges: [{ from: "gate", to: "steady", reason: "continuation" }],
      nodes: [{ id: "gate", declaredAt: { path: "flows/review.ts", line: 8 } }, { id: "steady" }]
    })
  })

  test("states no graph at all when the workspace reported none", async () => {
    const { store } = await launched()
    expect(runCard(store)?.payload.plan).not.toHaveProperty("graph")
  })

  test("states no plan at all when the workspace answered with no nodes", async () => {
    const { store } = await launched({ nodes: [] })
    expect(runCard(store)?.payload.plan).toBeUndefined()
  })

  test("carries the plan, the view and the camera through a re-open", async () => {
    const { store, controller } = await launched()
    await controller.commands.run("runs.trace.view", `${RUN} graph`)
    await controller.commands.run("runs.graph.follow", `${RUN} on`)
    const before = runCard(store)?.payload
    await controller.commands.run("runs.open", RUN)
    await waitFor(() => (store.session().runOpenRequests ?? []).length === 0)
    expect(runCard(store)?.payload).toMatchObject({
      traceView: "graph",
      graph: { follow: true },
      plan: before?.plan ?? {}
    })
  })
})

describe("the graph view's reader gestures", () => {
  test("runs.trace.view graph persists, and is recorded as the actor's act", async () => {
    const { store, controller } = await launched()
    expect(said(await controller.commands.run("runs.trace.view", `${RUN} graph`))).toBe(`trace-view run=${RUN} view=graph`)
    expect(runCard(store)?.payload.traceView).toBe("graph")
    expect([...store.collections.transitions.values()].some((record) => {
      if (record.type !== "card.updated") return false
      const payload = JSON.parse(record.payload)
      return payload.id === runCard(store)?.id && payload.patch?.payload?.traceView === "graph"
    })).toBe(true)
  })

  test("runs.graph.follow turns the camera on, and off again durably", async () => {
    const { store, controller } = await launched()
    expect(said(await controller.commands.runForAgent("runs.graph.follow", `${RUN} on`))).toBe(`graph-follow run=${RUN} follow=on`)
    expect(runCard(store)?.payload.graph).toEqual({ follow: true })
    expect(said(await controller.commands.runForAgent("runs.graph.follow", `${RUN} off`))).toBe(`graph-follow run=${RUN} follow=off`)
    // Following is the default. An explicit off must survive persistence.
    expect(runCard(store)?.payload.graph).toEqual({ follow: false })
    expect([...store.collections.transitions.values()].some((record) => {
      if (record.type !== "card.upsert") return false
      const payload = JSON.parse(record.payload)
      return payload.card?.id === runCard(store)?.id && payload.card?.payload?.graph?.follow === false
    })).toBe(true)
  })

  test("both gestures need the run's card first", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, relay().services)
    await signIn(store)
    expect(said(await controller.commands.run("runs.trace.view", "run-9 graph"))).toContain("runs.open run-9")
    expect(said(await controller.commands.run("runs.graph.follow", "run-9 on"))).toContain("runs.open run-9")
  })
})

describe("runs.graph.execution: which execution of the run forest the graph draws", () => {
  /* The recorded GraphFixture run: its journal names run-1, and Gate is a child execution with a graph. */
  const RECORDED: { readonly rows: ReadonlyArray<Record<string, unknown>> } =
    JSON.parse(readFileSync(new URL("../cards/fixtures/GraphRunJournal.json", import.meta.url), "utf8"))
  const GATE = "c7eac2d2567599c2bcbcbaa35ac4e07acf21e6e01c23753262361a60a7e0f07d"

  test("opens a recorded child in place, closes the open drawer, keeps the camera, and returns by replacement", async () => {
    const { store, controller } = await launched()
    const card = runCard(store)!
    await store.dispatch({ type: "card.upsert", actor: "system",
      card: { ...card, payload: { ...card.payload, events: [...RECORDED.rows], graph: { follow: false, node: "gate", tab: "events" } } } }).isPersisted.promise
    expect(said(await controller.commands.runForAgent("runs.graph.execution", `${RUN} nope`))).toBe(`Run ${RUN} has no graph for execution nope.`)
    expect(runCard(store)?.payload.graph).toEqual({ follow: false, node: "gate", tab: "events" })
    expect(said(await controller.commands.runForAgent("runs.graph.execution", `${RUN} ${GATE}`))).toBe(`graph-execution run=${RUN} execution=${GATE}`)
    expect(runCard(store)?.payload.graph).toEqual({ follow: false, execution: GATE })
    expect(said(await controller.commands.runForAgent("runs.graph.execution", RUN))).toBe(`graph-execution run=${RUN} execution=default`)
    /* A replacement, not a merge: the cleared execution does not come back from the journal. */
    expect(runCard(store)?.payload.graph).toEqual({ follow: false })
  })

  test("needs the run's card first", async () => {
    const store = await webStore()
    const controller = createAppController(store, silentAgent, relay().services)
    await signIn(store)
    expect(said(await controller.commands.run("runs.graph.execution", "run-9"))).toContain("runs.open run-9")
  })
})
