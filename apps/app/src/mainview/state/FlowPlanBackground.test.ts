/*
 * The plan door obeys the instant-chat rule (AGENTS.md §1).
 *
 * Planning crosses the relay to a workspace that may still be provisioning,
 * so `/flow.plan` persists the card, acknowledges, and returns. The graph
 * fills in the background under the shared toast, a refusal stays on the card
 * with the door that asks again, and asking twice for the same plan is one
 * request, not two.
 */
import { describe, expect, test } from "bun:test"
import { createAppStore, type AppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { json, loadBox, memoryStorage, settle, silentAgent, TEST_BOX } from "./TestFixtures"
import { digest } from "@smthrs/core/Digest"
import type { Card } from "./AppState"

const createAppController = scopedControllers()

const REPO = "smithersai/smithers"
const FLOW = "review"
const CARD = `flow-plan-${REPO}-${FLOW}--workspace-${digest(TEST_BOX).slice(0, 16)}`
const TOAST = `toast-flow.plan:${CARD}`

const planCard = (payload: {
  readonly nodes?: ReadonlyArray<unknown>
  readonly graph?: unknown
}) => ({
  planId: "plan-1",
  flowId: FLOW,
  digest: "d".repeat(64),
  inputSummary: "{}",
  envelope: { capabilities: [], flows: [], budget: {} },
  deployClass: false,
  nodes: payload.nodes ?? [],
  ...(payload.graph === undefined ? {} : { graph: payload.graph }),
  approval: {
    target: { _tag: "Plan", planId: "plan-1", digest: "d".repeat(64), envelope: { capabilities: [], flows: [], budget: {} } },
    scope: "run",
    idempotencyKey: "approve:plan-1"
  }
})

/* One node in the control plane's own shape (gateway.test.ts), not the card's. */
const NODE = {
  id: "read",
  kind: "step",
  key: `key1_${"0".repeat(64)}`,
  material: { version: "flows/key-material/v2", kind: "sealed", body: { action: "files/read" }, inputs: [], layers: [], capabilities: [] },
  effects: { reads: [], writes: [], boundaryMode: "hard" },
  dependsOn: [],
  conflicts: [],
  strategy: "serialize",
  runtime: "delay-rebase",
  priority: 0,
  generation: 0,
  status: "run"
}

/**
 * A relay whose `Plan` answer this test releases by hand.
 *
 * Nothing about the background rule is observable against a call that has
 * already answered: the claim is what the command does WHILE the workspace is
 * still thinking.
 */
const scriptedRelay = (answer: () => unknown) => {
  const plans: Array<unknown> = []
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    plans,
    release: () => release?.(),
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url), "https://app.test").pathname
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { procedure?: string; payload?: unknown } : undefined
      if (path === "/api/workflow/provision") return json(200, { status: "ready", repo: REPO, gatewayId: "gw-1" })
      if (path === "/api/workflow/rpc" && body?.procedure === "Plan") {
        plans.push(body.payload)
        await gate
        return json(200, answer())
      }
      return json(404, { status: "error", message: `no stub for ${path}` })
    }
  }
}

const readyController = async (relay: ReturnType<typeof scriptedRelay>, storage = memoryStorage(), supplied?: AppStore, pageLifetime?: AbortSignal) => {
  const store = supplied ?? await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({
    type: "identity.session.loaded", actor: "system", state: "signed-in",
    login: "will", allowlisted: true, admin: false, scopesPlain: null
  }).isPersisted.promise
  await store.dispatch({
    type: "repositories.loaded", actor: "system",
    repositories: [{ id: REPO, org: "smithersai", ownerKind: "org", name: "smithers", head: null }]
  }).isPersisted.promise
  await loadBox(store, REPO)
  const controller = createAppController(store, silentAgent, {
    fetchImpl: relay.fetchImpl,
    pageLifetime,
    toastDebounceMs: 0,
    toastAutoDismissMs: 10_000
  })
  return { store, controller }
}

const held = (store: Awaited<ReturnType<typeof createAppStore>>): Extract<Card, { kind: "flow-plan" }> | undefined => {
  const card = store.collections.cards.get(CARD)
  return card?.kind === "flow-plan" ? card : undefined
}

describe("reload reconnects admitted plans", () => {
  test("a pending plan recovers its saved request and stable Plan key", async () => {
    const storage = memoryStorage()
    const departure = new AbortController()
    const relay = scriptedRelay(() => { throw new TypeError("Failed to fetch") })
    const first = await readyController(relay, storage, undefined, departure.signal)
    await first.controller.planFlow(FLOW, REPO)
    await settle(10)
    const request = held(first.store)?.payload.planRequest
    const key = (relay.plans[0] as { idempotencyKey: string }).idempotencyKey
    departure.abort()
    relay.release()
    await settle(10)
    expect(held(first.store)?.payload.status).toBe("pending")
    await first.controller.dispose()
    await first.store.dispose?.()
    const nextRelay = scriptedRelay(() => ({ ok: true, payload: planCard({ nodes: [NODE] }) }))
    const second = await readyController(nextRelay, storage)
    try {
      await settle(15)
      expect(held(second.store)?.payload.status).toBe("pending")
      expect(held(second.store)?.payload.planRequest).toEqual(request)
      await second.controller.planFlow(FLOW, REPO)
      expect(nextRelay.plans).toHaveLength(1)
      expect((nextRelay.plans[0] as { idempotencyKey: string }).idempotencyKey).toBe(key)
      nextRelay.release()
      relay.release()
      await settle(15)
      expect(held(second.store)?.payload.status).toBe("done")
      expect(held(second.store)?.payload.planRequest).toBeUndefined()
      expect([...second.store.collections.cards.values()].filter(row => row.kind === "flow-plan")).toHaveLength(1)
    } finally { relay.release(); nextRelay.release() }
  })

  test("a settled plan card reopens exactly as it was", async () => {
    const storage = memoryStorage()
    const relay = scriptedRelay(() => ({ ok: true, payload: planCard({ nodes: [NODE], graph: { edges: [] } }) }))
    const first = await readyController(relay, storage)

    await first.controller.planFlow(FLOW, REPO)
    await settle(4)
    relay.release()
    await settle(12)
    const done = held(first.store)
    expect(done?.payload.status).toBe("done")
    await first.controller.dispose()

    const second = await readyController(scriptedRelay(() => ({ ok: true, payload: planCard({}) })), storage)
    expect(held(second.store)?.payload).toEqual(done!.payload)
  })
})

describe("the plan door returns before the workspace answers", () => {
  test("the command acknowledges a pending card, then the toast and the graph settle with the job", async () => {
    const relay = scriptedRelay(() => ({ ok: true, payload: planCard({ nodes: [NODE], graph: { edges: [] } }) }))
    const { store, controller } = await readyController(relay)

    const acknowledged = await controller.planFlow(FLOW, REPO)
    // The command answered while the relay's Plan call is still unresolved.
    expect(acknowledged).toEqual({ value: `plan-requested flow=${FLOW} repo=${REPO}` })
    await settle(4)
    expect(held(store)?.payload.status).toBe("pending")
    expect(held(store)?.payload.nodes).toBeUndefined()
    expect(store.collections.toasts.get(TOAST)?.status).toBe("running")

    // Chat and the doors beside it keep working while the plan is in flight.
    await store.dispatch({ type: "message.appended", actor: "user", text: "meanwhile" }).isPersisted.promise
    expect([...store.collections.messages.values()].some((row) => row.text === "meanwhile")).toBe(true)
    expect((await controller.commands.run("card.dismiss", CARD)).status).not.toBe("unknown-command")

    relay.release()
    await settle(12)
    expect(held(store)?.payload.status).toBe("done")
    expect(held(store)?.payload.nodes?.map((node) => node.id)).toEqual(["read"])
    expect(held(store)?.payload.planId).toBe("plan-1")
    expect(store.collections.toasts.get(TOAST)?.status).toBe("ok")
  })

  /*
   * D-054: the workspace reports where each node was declared, beside the
   * edges and outside the approval digest. The card keeps it, because it is
   * what the drawer's Code tab anchors on.
   */
  test("the declaration sites the workspace reported reach the card", async () => {
    const relay = scriptedRelay(() => ({
      ok: true,
      payload: planCard({
        nodes: [NODE],
        graph: { edges: [], nodes: [{ id: "read", declaredAt: { path: "flows/review/flow.ts", line: 12 } }] }
      })
    }))
    const { store, controller } = await readyController(relay)

    await controller.planFlow(FLOW, REPO)
    await settle(4)
    relay.release()
    await settle(12)
    expect(held(store)?.payload.graph?.nodes)
      .toEqual([{ id: "read", declaredAt: { path: "flows/review/flow.ts", line: 12 } }])
  })

  test("asking twice for the same plan is one Plan call and one card", async () => {
    const relay = scriptedRelay(() => ({ ok: true, payload: planCard({ nodes: [NODE] }) }))
    const { store, controller } = await readyController(relay)

    const first = await controller.planFlow(FLOW, REPO)
    const second = await controller.planFlow(FLOW, REPO)
    expect(second).toEqual(first)
    await settle(4)
    expect(relay.plans).toHaveLength(1)
    expect([...store.collections.cards.values()].filter((card) => card.kind === "flow-plan")).toHaveLength(1)

    relay.release()
    await settle(12)
    expect(relay.plans).toHaveLength(1)
    expect(held(store)?.payload.status).toBe("done")
  })

  /*
   * The card id is an identity, not a transcript. It reaches the DOM as a
   * `data-card` attribute and the toast as `toast-flow.plan:<id>`, so the
   * input goes in as a digest of its canonical bytes: the same input is the
   * same card whatever order its keys arrived in, and no value a person typed
   * is readable off the page.
   */
  test("the same input in another key order is one card, and no input value reaches the id", async () => {
    const relay = scriptedRelay(() => ({ ok: true, payload: planCard({ nodes: [NODE] }) }))
    const { store, controller } = await readyController(relay)

    await controller.planFlow(FLOW, REPO, { issue: "531", title: "secret-title" })
    await controller.planFlow(FLOW, REPO, { title: "secret-title", issue: "531" })
    await settle(4)

    const cards = [...store.collections.cards.values()].filter((card) => card.kind === "flow-plan")
    expect(cards).toHaveLength(1)
    expect(relay.plans).toHaveLength(1)
    expect(cards[0]!.id).not.toContain("secret-title")
    expect(cards[0]!.id).not.toContain("531")
    expect([...store.collections.toasts.keys()].join(" ")).not.toContain("secret-title")
    // The input itself still rides the card, where the body reads it.
    expect(cards[0]!.kind === "flow-plan" ? cards[0]!.payload.input : undefined).toEqual({ issue: "531", title: "secret-title" })

    relay.release()
    await settle(12)
    expect(relay.plans).toHaveLength(1)
  })

  test("a refusal stays on the card with the door that asks again, and never claims a plan", async () => {
    const relay = scriptedRelay(() => ({ ok: false, error: { message: "the workspace has no flow called review" } }))
    const { store, controller } = await readyController(relay)

    await controller.planFlow(FLOW, REPO)
    await settle(4)
    relay.release()
    await settle(12)

    const card = held(store)
    expect(card?.payload.status).toBe("failed")
    expect(card?.payload.error).toBe("the workspace has no flow called review")
    expect(card?.payload.nodes).toBeUndefined()
    expect(card?.payload.planId).toBeUndefined()
    expect(store.collections.toasts.get(TOAST)?.status).toBe("failed")

    // Retryable: the in-flight guard released, so the same ask reaches the
    // relay again, on the card it already has.
    await controller.planFlow(FLOW, REPO)
    expect(held(store)?.payload.status).toBe("pending")
    await settle(12)
    expect(relay.plans).toHaveLength(2)
    expect([...store.collections.cards.values()].filter((row) => row.kind === "flow-plan")).toHaveLength(1)
    expect(held(store)?.payload.status).toBe("failed")
  })
})

const WORKSPACES = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"] as const

describe("plan workspace and account ownership", () => {
  test.each([false, true])("plans from different workspaces have independent cards (first settled=%s)", async firstSettled => {
    const gates = WORKSPACES.map(() => Promise.withResolvers<void>())
    const calls: string[] = []
    const relay = scriptedRelay(() => ({}))
    const { store, controller } = await readyController({ ...relay, fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/workflow/provision")) return json(200, { status: "ready" })
      const body = JSON.parse(String(init?.body ?? "{}"))
      if (body.procedure !== "Plan") return json(404, {})
      calls.push(body.workspaceId)
      const index = WORKSPACES.indexOf(body.workspaceId)
      await gates[index]!.promise
      return json(200, { ok: true, payload: { ...planCard({}), planId: `plan-${index}` } })
    } })
    for (const [index, workspaceId] of WORKSPACES.entries()) {
      await store.dispatch({ type: "card.upsert", actor: "system", card: {
        id: `source-${index}`, kind: "flow-plan", title: "Source", status: "active", createdAt: 1, ordinal: index,
        payload: { repo: REPO, flowId: FLOW, status: "done", workspaceId }
      } }).isPersisted.promise
    }
    const cards = () => [...store.collections.cards.values()].filter((card): card is Extract<typeof card, { kind: "flow-plan" }> => card.kind === "flow-plan" && !card.id.startsWith("source-"))
    try {
      await controller.planFlow(FLOW, REPO, {}, "source-0")
      await settle(10)
      if (firstSettled) { gates[0]!.resolve(); await settle(10) }
      await controller.planFlow(FLOW, REPO, {}, "source-1")
      await controller.planFlow(FLOW, REPO, {}, "source-1")
      await settle(10)
      expect(calls).toEqual([...WORKSPACES])
      expect(cards()).toHaveLength(2)
      gates[1]!.resolve()
      await settle(10)
      gates[0]!.resolve()
      await settle(10)
      expect(WORKSPACES.map(workspaceId => cards().find(card => card.payload.workspaceId === workspaceId)?.payload.planId)).toEqual(["plan-0", "plan-1"])
    } finally { gates.forEach(gate => gate.resolve()) }
  })

  test.each(["will", "another"])("account %s can plan after sign-out while the old reply is held", async login => {
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    let calls = 0
    const relay = scriptedRelay(() => ({}))
    const { store, controller } = await readyController({ ...relay, fetchImpl: async (url, init) => {
      if (String(url).endsWith("/api/workflow/provision")) return json(200, { status: "ready" })
      const body = JSON.parse(String(init?.body ?? "{}"))
      if (body.procedure !== "Plan") return json(404, {})
      const index = calls++
      await gates[index]!.promise
      return json(200, { ok: true, payload: { ...planCard({}), planId: `account-${index}` } })
    } })
    try {
      await controller.planFlow(FLOW, REPO)
      await settle(10)
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
      await settle(10)
      await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
      // Sign-out forgets the account's boxes; the new session loads its own.
      await loadBox(store, REPO)
      await controller.planFlow(FLOW, REPO)
      await settle(10)
      expect(calls).toBe(2)
      gates[0]!.resolve()
      await settle(10)
      expect(held(store)?.payload.status).toBe("pending")
      await controller.planFlow(FLOW, REPO)
      expect(calls).toBe(2)
      gates[1]!.resolve()
      await settle(10)
      expect(held(store)?.payload.planId).toBe("account-1")
    } finally { gates.forEach(gate => gate.resolve()) }
  })
})

test("an account change during provisioning sends no Plan and resolves no successful toast", async () => {
  const provisioning = Promise.withResolvers<void>()
  let entered = false
  let plans = 0
  const relay = scriptedRelay(() => ({}))
  const { store, controller } = await readyController({ ...relay, fetchImpl: async (url, init) => {
    if (String(url).endsWith("/api/workflow/provision")) { entered = true; await provisioning.promise; return json(200, { status: "ready" }) }
    if (JSON.parse(String(init?.body ?? "{}")).procedure === "Plan") plans++
    return json(200, { ok: true, payload: planCard({}) })
  } })
  try {
    await controller.planFlow(FLOW, REPO)
    await settle(10)
    expect(entered).toBe(true)
    expect([...store.collections.toasts.values()].filter(toast => toast.status === "running")).toHaveLength(1)
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, allowlisted: false, admin: false, scopesPlain: null }).isPersisted.promise
    provisioning.resolve()
    await settle(15)
    expect(plans).toBe(0)
    expect(held(store)).toBeUndefined()
    expect([...store.collections.toasts.values()].some(toast => toast.status === "ok" && /Planned|Box ready/.test(toast.title))).toBe(false)
  } finally { provisioning.resolve() }
})

test("a default-box plan cannot replace an older card bound to another box", async () => {
  const relay = scriptedRelay(() => ({ ok: true, payload: planCard({}) }))
  const { store, controller } = await readyController(relay)
  const legacyId = `flow-plan-${REPO}-${FLOW}-`
  await store.dispatch({ type: "card.upsert", actor: "system", card: {
    id: legacyId, kind: "flow-plan", title: "Earlier plan", status: "active", ordinal: 1, createdAt: 1,
    payload: { repo: REPO, flowId: FLOW, status: "done", workspaceId: WORKSPACES[0], planId: "earlier" }
  } }).isPersisted.promise
  try {
    await controller.planFlow(FLOW, REPO)
    relay.release()
    await settle(15)
    const earlier = store.collections.cards.get(legacyId)
    expect(earlier?.kind === "flow-plan" && earlier.payload.planId).toBe("earlier")
    expect(held(store)?.payload.workspaceId).toBe(TEST_BOX)
    expect(held(store)?.payload.planId).toBe("plan-1")
  } finally { relay.release() }
})


test("Plan waits for its request commit before acknowledgment and network work", async () => {
  const gate = Promise.withResolvers<void>()
  const original = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const store: AppStore = { ...original, dispatch: transition => {
    if (transition.type === "card.upsert" && transition.card.kind === "flow-plan") {
      return { isPersisted: { promise: gate.promise.then(() => original.dispatch(transition).isPersisted.promise) } } as ReturnType<AppStore["dispatch"]>
    }
    return original.dispatch(transition)
  } }
  const relay = scriptedRelay(() => ({ ok: true, payload: planCard({}) }))
  const { controller } = await readyController(relay, memoryStorage(), store)
  let answer: unknown
  const request = controller.planFlow(FLOW, REPO).then(value => { answer = value })
  try {
    await settle(10)
    expect(answer).toBeUndefined()
    expect(relay.plans).toHaveLength(0)
  } finally { gate.resolve(); relay.release(); await request }
})

test("an unsaved Plan request makes no remote call and can be retried", async () => {
  const original = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  let reject = true
  const store: AppStore = { ...original, dispatch: transition => {
    if (reject && transition.type === "card.upsert" && transition.card.kind === "flow-plan") {
      return { isPersisted: { promise: Promise.reject(new Error("disk full")) } } as ReturnType<AppStore["dispatch"]>
    }
    return original.dispatch(transition)
  } }
  const relay = scriptedRelay(() => ({ ok: true, payload: planCard({}) }))
  const { controller } = await readyController(relay, memoryStorage(), store)
  try {
    expect(await controller.planFlow(FLOW, REPO)).toBe("The plan request could not be saved. Try again.")
    expect(relay.plans).toHaveLength(0)
    reject = false
    await controller.planFlow(FLOW, REPO)
    await settle(10)
    expect(relay.plans).toHaveLength(1)
  } finally { relay.release() }
})

test("the Plan toast waits for the result commit and duplicate input stays one request", async () => {
  const gate = Promise.withResolvers<void>()
  let saving = false
  const original = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const store: AppStore = { ...original, dispatch: transition => {
    if (transition.type === "card.upsert" && transition.card.kind === "flow-plan" && transition.card.payload.status === "done") {
      saving = true
      return { isPersisted: { promise: gate.promise.then(() => original.dispatch(transition).isPersisted.promise) } } as ReturnType<AppStore["dispatch"]>
    }
    return original.dispatch(transition)
  } }
  const relay = scriptedRelay(() => ({ ok: true, payload: planCard({ nodes: [NODE] }) }))
  const { controller } = await readyController(relay, memoryStorage(), store)
  try {
    await controller.planFlow(FLOW, REPO)
    relay.release()
    await settle(15)
    expect(saving).toBe(true)
    expect(store.collections.toasts.get(TOAST)?.status).toBe("running")
    expect(held(store)?.payload.status).toBe("pending")
    await controller.planFlow(FLOW, REPO)
    expect(relay.plans).toHaveLength(1)
    await store.dispatch({ type: "composer.changed", actor: "user", draft: "Chat during storage" }).isPersisted.promise
    gate.resolve()
    await settle(15)
    expect(held(store)?.payload.status).toBe("done")
    expect(store.collections.toasts.get(TOAST)?.status).toBe("ok")
  } finally { gate.resolve(); relay.release() }
})

test("a refused result commit leaves a retryable failure with the original Plan key", async () => {
  let reject = true
  const original = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const store: AppStore = { ...original, dispatch: transition => {
    if (reject && transition.type === "card.upsert" && transition.card.kind === "flow-plan" && transition.card.payload.status === "done") {
      return { isPersisted: { promise: Promise.reject(new Error("disk full")) } } as ReturnType<AppStore["dispatch"]>
    }
    return original.dispatch(transition)
  } }
  const relay = scriptedRelay(() => ({ ok: true, payload: planCard({ nodes: [NODE] }) }))
  const { controller } = await readyController(relay, memoryStorage(), store)
  await controller.planFlow(FLOW, REPO)
  const request = held(store)?.payload.planRequest
  relay.release()
  await settle(15)
  expect(held(store)?.payload.status).toBe("failed")
  expect(held(store)?.payload.planRequest).toEqual(request)
  expect(store.collections.toasts.get(TOAST)?.status).toBe("failed")
  reject = false
  await controller.planFlow(FLOW, REPO)
  await settle(15)
  expect(held(store)?.payload.status).toBe("done")
  expect(new Set(relay.plans.map(plan => (plan as { idempotencyKey: string }).idempotencyKey))).toEqual(new Set([`plan:${request!.id}`]))
})

test("retrying a refused comparison retains its original card and Plan key", async () => {
  let refuse = true
  const relay = scriptedRelay(() => refuse ? { ok: false, error: { message: "Try again" } } : { ok: true, payload: planCard({}) })
  const { store, controller } = await readyController(relay)
  await store.dispatch({ type: "card.upsert", actor: "system", card: {
    id: "original-preview", kind: "flow-plan", title: "Plan", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: REPO, flowId: FLOW, status: "done", workspaceId: TEST_BOX, planId: "old-plan", digest: "a".repeat(64), nodes: [] }
  } }).isPersisted.promise
  relay.release()
  await controller.planFlow(FLOW, REPO, {}, undefined, "old-plan")
  await settle(15)
  const failed = store.collections.cards.get("original-preview")
  expect(failed?.kind === "flow-plan" && failed.payload.status).toBe("failed")
  refuse = false
  await controller.planFlow(FLOW, REPO, {}, undefined, "old-plan")
  await settle(15)
  const done = store.collections.cards.get("original-preview")
  expect(done?.kind === "flow-plan" && done.payload.status).toBe("done")
  expect(done?.kind === "flow-plan" && done.payload.against).toBe("old-plan")
  expect([...store.collections.cards.values()].filter(card => card.kind === "flow-plan")).toHaveLength(1)
  expect(relay.plans).toHaveLength(2)
  expect(new Set(relay.plans.map(plan => (plan as { idempotencyKey: string }).idempotencyKey)).size).toBe(1)
})

test("Plan snapshots the caller's input before delayed provisioning", async () => {
  const gate = Promise.withResolvers<void>()
  const relay = scriptedRelay(() => ({ ok: true, payload: planCard({}) }))
  const { store, controller } = await readyController({ ...relay, fetchImpl: async (url, init) => {
    if (String(url).endsWith("/api/workflow/provision")) await gate.promise
    return relay.fetchImpl(url, init)
  } })
  const input = { nested: { issue: 1 } }
  await controller.planFlow(FLOW, REPO, input)
  input.nested.issue = 99
  gate.resolve()
  await settle(15)
  expect((relay.plans[0] as { input: unknown }).input).toEqual({ nested: { issue: 1 } })
  const plan = [...store.collections.cards.values()].find(card => card.kind === "flow-plan")
  expect(plan?.kind === "flow-plan" && plan.payload.input).toEqual({ nested: { issue: 1 } })
  relay.release()
})

test("reload during provisioning resumes the saved Plan on its pinned workspace", async () => {
  const storage = memoryStorage()
  const gate = Promise.withResolvers<void>()
  const relay = scriptedRelay(() => ({ ok: true, payload: planCard({}) }))
  const first = await readyController({ ...relay, fetchImpl: async (url, init) => {
    if (String(url).endsWith("/api/workflow/provision")) await gate.promise
    return relay.fetchImpl(url, init)
  } }, storage)
  await first.store.dispatch({ type: "card.upsert", actor: "system", card: { id: "source", kind: "flow-plan", title: "Source", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: REPO, flowId: FLOW, status: "done", workspaceId: WORKSPACES[0] } } }).isPersisted.promise
  await first.controller.planFlow(FLOW, REPO, { issue: 1 }, "source")
  const pending = [...first.store.collections.cards.values()].find(card => card.kind === "flow-plan" && card.payload.status === "pending")!
  expect(pending.kind === "flow-plan" && pending.payload.planRequest).toBeDefined()
  await first.controller.dispose()
  await first.store.dispose?.()
  const nextRelay = scriptedRelay(() => ({ ok: true, payload: planCard({}) }))
  const scopes: unknown[] = []
  const second = await readyController({ ...nextRelay, fetchImpl: async (url, init) => {
    if (String(url).endsWith("/api/workflow/rpc")) scopes.push(JSON.parse(String(init?.body)).workspaceId)
    return nextRelay.fetchImpl(url, init)
  } }, storage)
  try {
    nextRelay.release()
    gate.resolve()
    await settle(20)
    const restored = second.store.collections.cards.get(pending.id)
    expect(restored?.kind === "flow-plan" && restored.payload.status).toBe("done")
    expect(nextRelay.plans).toHaveLength(1)
    expect(relay.plans).toHaveLength(0)
    expect(new Set(scopes)).toEqual(new Set([WORKSPACES[0]]))
    expect((nextRelay.plans[0] as { input: unknown }).input).toEqual({ issue: 1 })
  } finally { gate.resolve(); relay.release(); nextRelay.release() }
})

test("a legacy pending plan without admission remains visibly retryable after reload", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "card.upsert", actor: "system", card: { id: CARD, kind: "flow-plan", title: "Earlier plan", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: REPO, flowId: FLOW, status: "pending" } } }).isPersisted.promise
  const relay = scriptedRelay(() => ({ ok: true, payload: planCard({}) }))
  const { controller } = await readyController(relay, memoryStorage(), store)
  expect(held(store)?.payload.status).toBe("failed")
  expect(relay.plans).toHaveLength(0)
  await controller.planFlow(FLOW, REPO)
  expect(held(store)?.payload.planRequest).toBeDefined()
  relay.release()
})

test("an admitted pending plan saved with no box settles failed on reload and asks nothing", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "card.upsert", actor: "system", card: { id: CARD, kind: "flow-plan", title: "Earlier plan", status: "active", createdAt: 1, ordinal: 1,
    payload: { repo: REPO, flowId: FLOW, status: "pending", planRequest: { id: "saved", owner: "will" } } } }).isPersisted.promise
  const relay = scriptedRelay(() => ({ ok: true, payload: planCard({}) }))
  await readyController(relay, memoryStorage(), store)
  for (let tick = 0; tick < 100 && held(store)?.payload.status !== "failed"; tick++) await settle(2)
  expect(held(store)?.payload).toMatchObject({ status: "failed", error: "This plan's box is gone." })
  expect(relay.plans).toHaveLength(0)
  relay.release()
})

test("Retry while a failed result write is settling starts the same request again", async () => {
  const failedCommit = Promise.withResolvers<void>()
  const original = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const store: AppStore = { ...original, dispatch: transition => {
    const write = original.dispatch(transition)
    if (transition.type === "card.upsert" && transition.card.kind === "flow-plan" && transition.card.payload.status === "failed") {
      return { isPersisted: { promise: write.isPersisted.promise.then(() => failedCommit.promise) } } as ReturnType<AppStore["dispatch"]>
    }
    return write
  } }
  let failed = true
  const relay = scriptedRelay(() => failed ? { ok: false, error: { message: "Try later" } } : { ok: true, payload: planCard({}) })
  const { controller } = await readyController(relay, memoryStorage(), store)
  try {
    await controller.planFlow(FLOW, REPO)
    relay.release()
    await settle(15)
    expect(held(store)?.payload.status).toBe("failed")
    const request = held(store)?.payload.planRequest
    failed = false
    await controller.planFlow(FLOW, REPO)
    await settle(15)
    expect(relay.plans).toHaveLength(2)
    failedCommit.resolve()
    await settle(10)
    expect(held(store)?.payload.status).toBe("done")
    expect(store.collections.toasts.get(TOAST)?.status).toBe("ok")
    expect(new Set(relay.plans.map(plan => (plan as { idempotencyKey: string }).idempotencyKey))).toEqual(new Set([`plan:${request!.id}`]))
  } finally { failedCommit.resolve(); relay.release() }
})
