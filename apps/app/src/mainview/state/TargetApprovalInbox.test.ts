/*
 * Build target approvals in the approvals inbox: a box's pending
 * `system/target` plans list beside the runs' gates, a row's Approve or Deny
 * submits the plan's own approval payload, and a box that predates the plan
 * listing still lists its runs' gates.
 */
import { describe, expect, test } from "bun:test"
import type { Card } from "@smthrs/rpc/Cards"
import type { AppServices } from "./AppController"
import { createAppStore } from "./AppStore"
import { approvalActionId } from "./ApprovalReference"
import { scopedControllers } from "./ControllerTestScope"
import { createGatewaySeam, INVALID_PROJECTION_CODE } from "./controller/gateway"
import { json, loadBox, memoryStorage, settle, silentAgent, TEST_BOX, waitFor } from "./TestFixtures"

const createAppController = scopedControllers()
const REPO = "codeplanesmithers/smithers-demo"
const envelope = { capabilities: [], flows: [], budget: {} }

/** A stored plan as `List { _tag: "plans" }` reports it. */
const plan = (planId: string, input: unknown) => ({
  card: {
    planId,
    flowId: "system/target",
    digest: `digest-${planId}`,
    inputSummary: "",
    envelope,
    deployClass: true,
    nodes: [],
    approval: {
      target: { _tag: "Plan", planId, digest: `digest-${planId}`, envelope },
      scope: "once",
      idempotencyKey: `approve:${planId}`
    }
  },
  input,
  decision: "pending"
})
const push = plan("plan-7", { label: "//images:push", digest: "177f95506bee0123456789" })

const gate = {
  runId: "run-a",
  requestId: "req-1",
  title: "Push the branch?",
  request: { question: "Push the branch?" },
  payload: {
    target: { _tag: "Node", runId: "run-a", requestId: "req-1", digest: "sha256:test", envelope },
    scope: "run",
    idempotencyKey: "approve:req-1"
  },
  requestedAt: 1500,
  status: "pending"
}

/** A relay double serving the approvals projection, the plan listing and decisions. */
const relay = (plans: { readonly pages?: ReadonlyArray<ReadonlyArray<unknown>>; refuse?: boolean }) => {
  const lists: Array<Record<string, unknown>> = []
  const submitted: Array<{ approval: unknown; decision: string }> = []
  const procedure = (name: string, payload: Record<string, unknown>): Response => {
    switch (name) {
      case "List": {
        lists.push(payload)
        if (plans.refuse === true) return json(200, { ok: false, error: { message: "payload decode failed" } })
        const pages = plans.pages ?? [[]]
        const index = payload.cursor === undefined ? 0 : Number(payload.cursor)
        return json(200, {
          ok: true,
          payload: { _tag: "plans", items: pages[index] ?? [], ...(index + 1 < pages.length ? { nextCursor: String(index + 1) } : {}) }
        })
      }
      case "Approval.Submit": {
        const { decision, ...approval } = payload
        submitted.push({ approval, decision: String(decision) })
        return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" } } })
      }
      case "Projection.Snapshot":
        return json(200, {
          ok: true,
          payload: { cursor: { projection: "approvals", runId: null, value: 0 }, rows: (payload.selector as { _tag?: string })._tag === "approvals" && (payload.selector as { runId?: string }).runId === undefined ? [gate] : [] }
        })
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
      const path = new URL(url, "https://app.test").pathname
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      if (path === "/api/workflow/provision") return json(200, { status: "ready", repo: body?.repo, gatewayId: "gw-1" })
      if (path === "/api/workflow/rpc") return procedure(String(body.procedure), (body.payload ?? {}) as Record<string, unknown>)
      return json(404, { status: "error", message: `no stub for ${path}` })
    }
  }
  return { services, lists, submitted, plans }
}

const signedIn = async (services: AppServices) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, services)
  store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "codeplanesmithers", admin: false, scopesPlain: null })
  store.dispatch({
    type: "repositories.loaded",
    actor: "system",
    repositories: [{ id: REPO, org: "codeplanesmithers", ownerKind: "user", name: "smithers-demo", head: null }]
  })
  await loadBox(store, REPO, TEST_BOX)
  await settle(2)
  return { store, controller }
}

const listInbox = async ({ store, controller }: Awaited<ReturnType<typeof signedIn>>) => {
  const outcome = await controller.commands.run("approvals.list")
  await waitFor(() => (store.session().approvalsInboxRequests ?? []).length === 0, 10_000)
  await store.settled?.()
  const card = store.collections.cards.get(`approvals-inbox-${REPO}-${TEST_BOX}`) as Extract<Card, { kind: "approvals-inbox" }> | undefined
  return { outcome, card }
}

describe("build target approvals in the inbox", () => {
  test("a pending target lists beside the runs' gates and Approve submits its plan payload", async () => {
    const double = relay({ pages: [[push]] })
    const app = await signedIn(double.services)
    const { card } = await listInbox(app)

    expect(double.lists).toEqual([{ _tag: "plans", filters: { flowId: "system/target", decision: "pending" } }])
    expect(card?.payload.approvals.map((row) => [row.runId, row.title])).toEqual([
      ["run-a", "Push the branch?"],
      ["plan:plan-7", "//images:push 177f95506bee"]
    ])

    await app.controller.commands.run("approval.approve", approvalActionId(card!.id, { runId: "plan:plan-7", requestId: "plan-7" }))
    await settle(4)
    expect(double.submitted).toEqual([{ approval: push.card.approval, decision: "approve" }])
    const decided = app.store.collections.cards.get(card!.id) as Extract<Card, { kind: "approvals-inbox" }>
    expect(decided.payload.approvals.map((row) => row.decision)).toEqual([undefined, "approved"])
  })

  test("Deny submits the same payload as a denial", async () => {
    const double = relay({ pages: [[push]] })
    const app = await signedIn(double.services)
    const { card } = await listInbox(app)
    await app.controller.commands.run("approval.deny", approvalActionId(card!.id, { runId: "plan:plan-7", requestId: "plan-7" }))
    await settle(4)
    expect(double.submitted).toEqual([{ approval: push.card.approval, decision: "deny" }])
  })

  test("a refused plan listing keeps the target rows already listed", async () => {
    const double = relay({ pages: [[push]] })
    const app = await signedIn(double.services)
    await listInbox(app)
    double.plans.refuse = true
    const { card } = await listInbox(app)
    expect(double.lists).toHaveLength(2)
    expect(card?.payload.approvals.map((row) => [row.runId, row.approval])).toEqual([
      ["run-a", gate.payload],
      ["plan:plan-7", push.card.approval]
    ])
  })

  test("a box without the plan listing still lists its runs' gates", async () => {
    const double = relay({ refuse: true })
    const app = await signedIn(double.services)
    const { card } = await listInbox(app)
    expect(double.lists).toHaveLength(1)
    expect(card?.payload.approvals.map((row) => row.runId)).toEqual(["run-a"])
  })
})

describe("the gateway's target approval read", () => {
  const seam = (answer: (payload: Record<string, unknown>) => unknown) => {
    const payloads: Array<Record<string, unknown>> = []
    const gateway = createGatewaySeam({
      baseUrl: "https://app.test",
      bindingFor: () => ({ workspaceId: "box-1" }),
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { payload: Record<string, unknown> }
        payloads.push(body.payload)
        return new Response(JSON.stringify(answer(body.payload)), { status: 200 })
      },
      errorMessageOf: async (_response, fallback) => fallback
    })
    return { gateway, payloads }
  }

  test("walks every page and keeps only plans that name a target revision", async () => {
    const other = plan("plan-8", { suite: "not a target" })
    const mirror = plan("plan-9", { label: "//images:mirror", digest: "abc" })
    const { gateway, payloads } = seam((payload) => ({
      ok: true,
      payload: payload.cursor === undefined
        ? { _tag: "plans", items: [push, other], nextCursor: "8" }
        : { _tag: "plans", items: [mirror] }
    }))
    const read = await gateway.targetApprovals(REPO)
    expect(payloads.map((payload) => payload.cursor)).toEqual([undefined, "8"])
    expect(read as unknown).toEqual({
      status: "ok",
      value: [
        { runId: "plan:plan-7", requestId: "plan-7", title: "//images:push 177f95506bee", request: push.input, payload: push.card.approval, requestedAt: 0, status: "pending" },
        { runId: "plan:plan-9", requestId: "plan-9", title: "//images:mirror abc", request: mirror.input, payload: mirror.card.approval, requestedAt: 0, status: "pending" }
      ]
    })
  })

  test("stops at an empty page even when it names a cursor", async () => {
    const { gateway, payloads } = seam(() => ({ ok: true, payload: { _tag: "plans", items: [], nextCursor: "1" } }))
    expect(await gateway.targetApprovals(REPO)).toEqual({ status: "ok", value: [] })
    expect(payloads).toHaveLength(1)
  })

  test("refuses a listing longer than fifty pages rather than answer part of it", async () => {
    const { gateway, payloads } = seam((payload) => ({
      ok: true,
      payload: { _tag: "plans", items: [push], nextCursor: String(Number(payload.cursor ?? 0) + 1) }
    }))
    const read = await gateway.targetApprovals(REPO)
    expect(payloads).toHaveLength(50)
    expect(read).toEqual({ status: "error", message: "The workspace lists more build targets than Smithers reads." })
  })

  test("refuses an answer that is not a plan page, and passes a refusal through", async () => {
    const flows = seam(() => ({ ok: true, payload: { _tag: "flows", items: [] } }))
    expect(await flows.gateway.targetApprovals(REPO)).toMatchObject({ status: "error", code: INVALID_PROJECTION_CODE })
    const refused = seam(() => ({ ok: false, error: { message: "no plans here" } }))
    expect(await refused.gateway.targetApprovals(REPO)).toMatchObject({ status: "error", detail: "no plans here" })
  })
})
