/*
 * `flow.plan against=<runId>`: the re-key preview, end to end through the
 * controller.
 *
 * The plan the run was approved on, the journal it wrote and the fresh plan
 * this test's relay answers with are all the recording in
 * `cards/fixtures/GraphRunJournal.json`, which a real bridged engine
 * produced. The edit is that plan with one or more of its keys moved, which is
 * what an edit to the source does to a plan (D-030), and the rows the relay
 * serves are the gateway's own projection of the same recording.
 */
import * as GatewayProjection from "@smthrs/gateway/GatewayProjection"
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { ControlEvent, RunSummaryRow } from "./controller/gateway"
import type { Card } from "./AppState"
import { createAppStore, type AppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { json, loadBox, memoryStorage, settle, silentAgent, TEST_BOX } from "./TestFixtures"
import { digest } from "@smthrs/core/Digest"

const createAppController = scopedControllers()

const REPO = "smithersai/smithers"
const RUN = "run-1"

interface Recorded {
  readonly flow: string
  readonly plan: {
    readonly planId: string
    readonly digest: string
    readonly nodes: ReadonlyArray<{ readonly id: string; readonly key: string; readonly dependsOn: ReadonlyArray<string>; readonly action?: string }>
  }
  readonly rows: ReadonlyArray<ControlEvent>
}

const RECORDED: Recorded = JSON.parse(
  readFileSync(new URL("../cards/fixtures/GraphRunJournal.json", import.meta.url), "utf8")
)
const FLOW = RECORDED.flow
const BOX_KEY = digest(TEST_BOX).slice(0, 16)
const CARD = `flow-plan-${REPO}-${FLOW}--vs-${RUN}-workspace-${BOX_KEY}`
const EDITED = ["root.flow.then.map.all.cached", "root.flow.then.map", "root"]

/** The recorded plan's nodes, as the card carries them. */
const cardNodes = RECORDED.plan.nodes.map((node) => ({
  id: node.id,
  kind: "step" as const,
  key: node.key,
  dependsOn: [...node.dependsOn],
  tier: "sealed" as const,
  ...(node.action === undefined ? {} : { action: node.action }),
  status: "run" as const
}))

/** One hex digit of a key changed: what an edit to the source does to it. */
const moved = (key: string): string => `${key.slice(0, -1)}${key.endsWith("a") ? "b" : "a"}`

/** The rows the gateway's own projection serves for this recording. */
const MEASURED = GatewayProjection.flowDurations(
  FLOW,
  GatewayProjection.nodeDurations(RECORDED.rows as ReadonlyArray<never>)
)

/** The same plan as the control plane answers it, with some keys moved. */
const planAnswer = (edited: ReadonlyArray<string> = EDITED) => ({
  planId: "plan-2",
  flowId: FLOW,
  digest: "d".repeat(64),
  inputSummary: "{}",
  envelope: { capabilities: [], flows: [], budget: {} },
  deployClass: false,
  nodes: RECORDED.plan.nodes.map((node) => ({
    id: node.id,
    kind: "step",
    key: edited.includes(node.id) ? moved(node.key) : node.key,
    material: {
      version: "flows/key-material/v2",
      kind: "sealed",
      ...(node.action === undefined ? { body: {} } : { body: { action: node.action } }),
      inputs: [],
      layers: [],
      capabilities: []
    },
    effects: { reads: [], writes: [], boundaryMode: "hard" },
    dependsOn: [...node.dependsOn],
    conflicts: [],
    strategy: "serialize",
    runtime: "delay-rebase",
    priority: 0,
    generation: 0,
    status: "run"
  })),
  approval: {
    target: { _tag: "Plan", planId: "plan-2", digest: "d".repeat(64), envelope: { capabilities: [], flows: [], budget: {} } },
    scope: "run",
    idempotencyKey: "approve:plan-2"
  }
})

const SUMMARY: RunSummaryRow = {
  runId: RUN, flowId: FLOW, status: "completed", createdAt: 1, updatedAt: 2,
  turns: 1, calls: 1, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0,
  inputTokens: 0, outputTokens: 0, verdict: "done", diagnosis: "done"
}

const RUN_CARD: Extract<Card, { kind: "run-trace" }> = {
  id: "run-card-1",
  kind: "run-trace",
  title: FLOW,
  status: "acted",
  ordinal: 1,
  createdAt: 1,
  payload: {
    repo: REPO,
    workspaceId: TEST_BOX,
    runId: RUN,
    workflow: FLOW,
    phase: "completed",
    steps: [],
    result: null,
    lastSeq: 0,
    plan: { planId: RECORDED.plan.planId, digest: RECORDED.plan.digest, nodes: cardNodes }
  }
}

/** What the workspace answers with: one edit, and one measured history. */
interface Served {
  readonly plan?: ReturnType<typeof planAnswer>
  /** The plan nodes whose key the edit moved. */
  readonly edited?: ReadonlyArray<string>
  /**
   * The `flow-durations` rows, or the refusal a box whose selector union
   * predates the projection answers with.
   */
  readonly durations?: ReadonlyArray<GatewayProjection.FlowDurationRow> | "refused"
}

const relay = (served: Served = {}) => async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url), "https://app.test").pathname
  const body = typeof init?.body === "string" ? JSON.parse(init.body) as { procedure?: string; payload?: { selector?: { _tag?: string } } } : undefined
  if (path === "/api/workflow/provision") return json(200, { status: "ready", repo: REPO, gatewayId: "gw-1" })
  if (path === "/api/workflow/rpc" && body?.procedure === "Plan") return json(200, { ok: true, payload: served.plan ?? planAnswer(served.edited) })
  if (path === "/api/workflow/rpc" && body?.payload?.selector?._tag === "flow-durations") {
    return served.durations === "refused"
      ? json(200, { ok: false, error: { message: "Unknown projection selector" } })
      : json(200, { ok: true, payload: { rows: served.durations ?? [] } })
  }
  return json(404, { status: "error", message: `no stub for ${path}` })
}

const ready = async (rows: ReadonlyArray<ControlEvent>, served: Served = {}) => {
  const store: AppStore = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({
    type: "identity.session.loaded", actor: "system", state: "signed-in",
    login: "will", admin: false, scopesPlain: null
  }).isPersisted.promise
  await store.dispatch({
    type: "repositories.loaded", actor: "system",
    repositories: [{ id: REPO, org: "smithersai", ownerKind: "org", name: "smithers", head: null }]
  }).isPersisted.promise
  await loadBox(store, REPO)
  await store.dispatch({ type: "card.upsert", actor: "system", card: RUN_CARD }).isPersisted.promise
  await store.dispatch({
    type: "gateway.run.observed", actor: "system",
    observation: { scope: { repo: REPO, runId: RUN, workspaceId: TEST_BOX }, summary: SUMMARY, journal: { mode: "full", events: [...rows] } }
  }).isPersisted.promise
  const controller = createAppController(store, silentAgent, {
    fetchImpl: relay(served),
    toastDebounceMs: 0,
    toastAutoDismissMs: 10_000
  })
  return { store, controller }
}

const preview = (store: AppStore) => {
  const card = store.collections.cards.get(CARD)
  return card?.kind === "flow-plan" ? card.payload : undefined
}

describe("a plan compared against a run this client launched", () => {
  test("states the work, the run's own wall clock, and no cache-hit count", async () => {
    const { store, controller } = await ready(RECORDED.rows)
    await controller.planFlow(FLOW, REPO, undefined, undefined, RUN)
    await settle(12)
    const payload = preview(store)
    expect(payload?.status).toBe("done")
    expect(payload?.against).toBe(RUN)
    expect(payload?.rekey?.rerun).toBe(3)
    expect(payload?.rekey?.total).toBe(11)
    const timed = RECORDED.rows.flatMap((row) => typeof row.occurredAt === "number" ? [row.occurredAt] : [])
    expect(payload?.rekey?.wasMs).toBe(timed[timed.length - 1]! - timed[0]!)
    // D-044: the recorded run settled nothing clean, so there is no count.
    expect(payload?.rekey?.cleanSettlements).toBeUndefined()
  })

  test("a run that really did settle a node clean carries that count", async () => {
    const rows = RECORDED.rows.map((row) => {
      const envelope = row.payload as { eventType?: string; payload?: Record<string, unknown> }
      return envelope.eventType === "flows.engine.node-settled" &&
          envelope.payload?.["nodeId"] === "root.flow.then.map.all.cached"
        ? { ...row, payload: { ...envelope, payload: { ...envelope.payload, outcome: "clean" } } }
        : row
    })
    const { store, controller } = await ready(rows as ReadonlyArray<ControlEvent>)
    await controller.planFlow(FLOW, REPO, undefined, undefined, RUN)
    await settle(12)
    expect(preview(store)?.rekey?.cleanSettlements).toBe(1)
  })

  test("the preview is its own card, so a plain plan of the flow keeps its own", async () => {
    const { store, controller } = await ready(RECORDED.rows)
    await controller.planFlow(FLOW, REPO, undefined, undefined, RUN)
    await settle(12)
    await controller.planFlow(FLOW, REPO)
    await settle(12)
    expect(preview(store)?.rekey?.rerun).toBe(3)
    const plain = store.collections.cards.get(`flow-plan-${REPO}-${FLOW}--workspace-${BOX_KEY}`)
    expect(plain?.kind === "flow-plan" && plain.payload.rekey).toBeUndefined()
  })

  test("the estimate is on the card the first time it is asked for, not the second", async () => {
    // The gateway holds every successful measurement. An unchanged failed
    // action still needs to run, so the overall estimate remains absent.
    const { store, controller } = await ready(RECORDED.rows, {
      edited: ["root.flow.then.map.all.cached"],
      durations: MEASURED
    })
    await controller.planFlow(FLOW, REPO, undefined, undefined, RUN)
    await settle(12)
    expect(preview(store)?.rekey?.rerun).toBe(1)
    expect(preview(store)?.rekey?.etaMs).toBeUndefined()
  })

  test("a box that refuses the durations projection still states the work, and no estimate", async () => {
    const { store, controller } = await ready(RECORDED.rows, {
      edited: ["root.flow.then.map.all.cached"],
      durations: "refused"
    })
    await controller.planFlow(FLOW, REPO, undefined, undefined, RUN)
    await settle(12)
    expect(preview(store)?.rekey?.rerun).toBe(1)
    expect(preview(store)?.rekey?.etaMs).toBeUndefined()
  })

  test("a run this client did not launch has no plan to compare, so no numbers are invented", async () => {
    const { store, controller } = await ready(RECORDED.rows)
    await controller.planFlow(FLOW, REPO, undefined, undefined, "run-elsewhere")
    await settle(12)
    const card = store.collections.cards.get(`flow-plan-${REPO}-${FLOW}--vs-run-elsewhere-workspace-${BOX_KEY}`)
    expect(card?.kind === "flow-plan" && card.payload.status).toBe("done")
    expect(card?.kind === "flow-plan" && card.payload.rekey).toBeUndefined()
    expect(card?.kind === "flow-plan" && card.payload.against).toBe("run-elsewhere")
  })
})

test("a comparison uses only the matching workspace's run with that id", async () => {
  const { store, controller } = await ready(RECORDED.rows)
  const workspaceId = "11111111-1111-4111-8111-111111111111"
  await store.dispatch({ type: "card.upsert", actor: "system", card: {
    id: "workspace-source", kind: "flow-plan", title: "Source", status: "active", ordinal: 2, createdAt: 1,
    payload: { repo: REPO, flowId: FLOW, status: "done", workspaceId }
  } }).isPersisted.promise
  const scoped = () => [...store.collections.cards.values()].find((card): card is Extract<typeof card, { kind: "flow-plan" }> =>
    card.kind === "flow-plan" && card.payload.workspaceId === workspaceId && card.payload.against === RUN)
  await controller.planFlow(FLOW, REPO, undefined, "workspace-source", RUN)
  await settle(15)
  expect(scoped()?.payload.status).toBe("done")
  expect(scoped()?.payload.rekey).toBeUndefined()
  await store.dispatch({ type: "card.upsert", actor: "system", card: {
    ...RUN_CARD, id: "workspace-run", payload: { ...RUN_CARD.payload, workspaceId }
  } }).isPersisted.promise
  await controller.planFlow(FLOW, REPO, undefined, "workspace-source", RUN)
  await settle(15)
  expect(scoped()?.payload.rekey?.rerun).toBe(3)
})


test("a re-key estimate ignores measurements from a different workspace", async () => {
  const plan = planAnswer([])
  const first = plan.nodes[0]!
  const actionTag = cardNodes[0]!.action ?? FLOW
  const { store, controller } = await ready([], { plan: { ...plan, nodes: [{ ...first, dependsOn: [] }] }, durations: "refused" })
  await store.dispatch({ type: "flow-durations.loaded", actor: "system", repo: REPO, flowId: FLOW, workspaceId: "another-workspace",
    rows: [{ actionTag, samples: 4, p50Ms: 9000, p90Ms: 10000 }] }).isPersisted.promise
  await controller.planFlow(FLOW, REPO, undefined, undefined, RUN)
  await settle(15)
  expect(preview(store)?.status).toBe("done")
  expect(preview(store)?.rekey?.etaMs).toBeUndefined()
  await store.dispatch({ type: "flow-durations.loaded", actor: "system", repo: REPO, flowId: FLOW, workspaceId: TEST_BOX,
    rows: [{ actionTag, samples: 4, p50Ms: 1000, p90Ms: 2000 }] }).isPersisted.promise
  await controller.planFlow(FLOW, REPO, undefined, undefined, RUN)
  await settle(15)
  expect(preview(store)?.rekey?.etaMs).toBe(1000)
})
