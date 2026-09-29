import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { json, loadBox, memoryStorage, settle, waitFor, silentAgent } from "./TestFixtures"
import type { Card } from "./AppState"
import { runtimeRunKey } from "./RuntimeProjection"
import { createControllerContext } from "./controller/context"
import { createFailureController } from "./controller/failures"
import { createFlowAuthoringController } from "./controller/flowAuthoring"
import { FLOW_AUTHORING_ENTRY } from "@smthrs/rpc/FlowAuthoring"

const createController = scopedControllers()
const REPO = "test/authoring"
const node = (id: string) => ({ id, kind: "step", key: `key1_${(id === "read" ? "a" : "b").repeat(64)}`,
  material: { version: "flows/key-material/v2", kind: "sealed", body: { action: id }, inputs: [], layers: [], capabilities: [] },
  effects: { reads: [], writes: [], boundaryMode: "hard" }, dependsOn: [], conflicts: [], strategy: "serialize", runtime: "delay-rebase", priority: 0, generation: 0, status: "run" })
const fixture = () => {
  let release!: () => void
  const launch = new Promise<void>(resolve => { release = resolve })
  const calls: Array<{ procedure: string; payload: any }> = []
  const state = { terminal: false, fail: false, planFail: false, events: [] as any[], version: 1, runId: "author-1",
    recorded: new Map<string, { terminal: boolean; events: any[] }>() }
  const fetchImpl = async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/provision")) return json(200, { status: "ready", repo: REPO })
    const body = JSON.parse(String(init?.body ?? "{}"))
    /* The relay refuses a body that names no box, as the Worker does. */
    if (typeof body.workspaceId !== "string") return json(400, { status: "error", code: "request_invalid", message: "Body must name a box: workspaceId." })
    const { procedure, payload } = body
    calls.push({ procedure, payload })
    if (procedure === "Plan") {
      if (payload.flowId === "create-flow") {
        await launch
        if (state.fail) return json(200, { ok: false, error: { message: "authoring unavailable" } })
      }
      else if (state.planFail) return json(200, { ok: false, error: { message: "source cannot compile" } })
      return json(200, { ok: true, payload: { planId: `plan-${payload.flowId}-${state.version}`, flowId: payload.flowId, digest: "d".repeat(64),
        approval: { target: { _tag: "Plan", planId: `plan-${payload.flowId}-${state.version}`, digest: "d".repeat(64), envelope: { capabilities: [], flows: [], budget: {} } }, scope: "run", idempotencyKey: "approve" },
        inputSummary: "{}", envelope: { capabilities: [], flows: [], budget: {} }, deployClass: false,
        nodes: payload.flowId === "create-flow" ? [] : [node("read"), ...(state.version === 2 ? [node("validate")] : [])] } })
    }
    if (procedure === "Approval.Submit") return json(200, { ok: true, payload: { decision: { _tag: "Accepted", receiptId: "a" }, resume: { _tag: "Accepted", receiptId: "r" } } })
    if (procedure === "Run") return json(200, { ok: true, payload: { _tag: "Accepted", receiptId: "r", runId: state.runId } })
    if (procedure === "Projection.Snapshot") {
      const selector = payload.selector
      const recorded = state.recorded.get(selector.runId) ?? state
      return json(200, { ok: true, payload: { rows: selector._tag === "run-summary" ? [{ runId: selector.runId, flowId: "create-flow", status: recorded.terminal ? "completed" : "running",
        createdAt: 1, updatedAt: 2 + recorded.events.length + Number(recorded.terminal), turns: 1, calls: 1, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0,
        verdict: recorded.terminal ? "done" : "running", diagnosis: "running" }] : selector._tag === "run-events" ? recorded.events.filter(event => event.sequence > (payload.after?.value ?? -1)) : [] } })
    }
    return json(404, {})
  }
  return { state, calls, release, fetchImpl }
}
const ready = async (relay: ReturnType<typeof fixture>, storage = memoryStorage()) => {
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await loadBox(store, REPO)
  const controller = createController(store, silentAgent, { fetchImpl: relay.fetchImpl, workflowPollMs: 1, toastDebounceMs: 0, toastAutoDismissMs: 10000 })
  return { store, controller }
}
const runs = (store: Awaited<ReturnType<typeof createAppStore>>) => Array.from<Card>(store.collections.cards.values()).filter((card): card is Extract<Card, { kind: "run-trace" }> => card.kind === "run-trace")
const plans = (store: Awaited<ReturnType<typeof createAppStore>>) => Array.from<Card>(store.collections.cards.values()).filter((card): card is Extract<Card, { kind: "flow-plan" }> => card.kind === "flow-plan")

test("authoring acknowledges before launch, deduplicates, and keeps its toast through real execution", async () => {
  const relay = fixture()
  const { store, controller } = await ready(relay)
  let result: unknown
  void controller.createWorkflow("add validation", REPO).then(value => { result = value })
  try {
    await waitFor(() => result !== undefined)
    expect(result).toEqual({ value: `flow-requested repo=${REPO}` })
    expect(runs(store)).toHaveLength(1)
    expect(runs(store)[0]?.payload.phase).toBe("launching")
    await controller.createWorkflow("add validation", REPO)
    expect(relay.calls.filter(call => call.procedure === "Plan")).toHaveLength(1)
    await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.title === "Creating a flow" && toast.status === "running"))
    expect([...store.collections.toasts.values()].some(toast => toast.title === "Creating a flow" && toast.status === "running")).toBe(true)
    await store.dispatch({ type: "message.appended", actor: "user", text: "still here" }).isPersisted.promise
    relay.release()
    await waitFor(() => runs(store)[0]?.payload.runId === "author-1")
    expect(runs(store)[0]?.payload.runId).toBe("author-1")
    expect([...store.collections.toasts.values()].some(toast => toast.title === "Creating a flow" && toast.status === "running")).toBe(true)
    relay.state.terminal = true
    await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.title === "Authoring finished" && toast.status === "ok"))
    expect([...store.collections.toasts.values()].some(toast => toast.title === "Authoring finished" && toast.status === "ok")).toBe(true)
  } finally { relay.release() }
})

test("settled source receipts replan on the same card, retain selection and compare the prior plan", async () => {
  const relay = fixture()
  relay.release()
  const { store, controller } = await ready(relay)
  await controller.createWorkflow("make a review flow", REPO)
  await waitFor(() => runs(store)[0]?.payload.runId === "author-1")
  relay.state.events = [{ sequence: 1, occurredAt: 1, kind: "control.agent.cell-call-settled", payload: { callId: "write-1", flowName: "write", outcome: "success", value: { path: "flows/review/flow.ts", bytesWritten: 12, created: true } } }]
  await waitFor(() => plans(store)[0]?.payload.status === "done")
  const before = plans(store)[0]
  expect(before?.payload.nodes?.map(n => n.id)).toEqual(["read"])
  expect(before?.ordinal).toBe(runs(store)[0]!.ordinal - 1)
  await controller.commands.run("flow.plan.select", `${before!.id} read`)
  relay.state.version = 2
  relay.state.events.push({ sequence: 2, occurredAt: 2, kind: "control.agent.cell-call-settled", payload: { callId: "write-2", flowName: "edit", outcome: "success", value: { path: "flows/review/flow.ts", replacements: 1 } } })
  await waitFor(() => plans(store)[0]?.payload.nodes?.length === 2)
  expect(plans(store)).toHaveLength(1)
  const after = plans(store)[0]!
  expect(after.id).toBe(before!.id)
  expect(after.payload.nodes?.map(n => n.id)).toEqual(["read", "validate"])
  expect(after.payload.against).toBe(before!.payload.planId)
  expect(after.payload.view?.node).toBe("read")
  expect(after.payload.previousPlan?.nodes.map((n) => n.id)).toEqual(["read"])
  const count = relay.calls.filter(call => call.procedure === "Plan").length
  await settle(20)
  expect(relay.calls.filter(call => call.procedure === "Plan")).toHaveLength(count)

  /*
   * The author is still working. Both redraws above happened off journal
   * PAGES, not off a terminal summary: the run's own status is `running` and
   * its toast is still open, which is what "shown live" means. The pump calls
   * the observer on every page it persists (workflow-pump.ts), so removing
   * that call fails this test rather than deferring it to the end.
   */
  expect(store.committedRuntimeRun(runtimeRunKey(runs(store)[0]!.payload))?.summary?.status).toBe("running")
  expect([...store.collections.toasts.values()].some(toast => toast.title === "Creating a flow" && toast.status === "running")).toBe(true)

  /* And it keeps working: the next write redraws the canvas again, still mid-run. */
  relay.state.version = 3
  relay.state.events.push({ sequence: 3, occurredAt: 3, kind: "control.agent.cell-call-settled", payload: { callId: "write-3", flowName: "edit", outcome: "success", value: { path: "flows/review/flow.ts", replacements: 1 } } })
  await waitFor(() => plans(store)[0]?.payload.planId === "plan-review-3")
  expect(store.committedRuntimeRun(runtimeRunKey(runs(store)[0]!.payload))?.summary?.status).toBe("running")
  expect(plans(store)).toHaveLength(1)
})

test("failed authoring stays visible and the same request is retryable", async () => {
  const relay = fixture()
  relay.state.fail = true
  relay.release()
  const { store, controller } = await ready(relay)
  await controller.createWorkflow("make a review flow", REPO)
  await waitFor(() => runs(store)[0]?.payload.observationError !== undefined)
  expect(runs(store)[0]?.payload.observationError).toContain("The workspace refused the call.")
  relay.state.fail = false
  await controller.createWorkflow("make a review flow", REPO)
  await waitFor(() => runs(store)[0]?.payload.runId === "author-1")
  expect(runs(store)).toHaveLength(1)
  expect(runs(store)[0]?.payload.runId).toBe("author-1")
})

test("a source that cannot be planned stays failed and does not strand or repeat the authoring observer", async () => {
  const relay = fixture()
  relay.release()
  relay.state.planFail = true
  const { store, controller } = await ready(relay)
  await controller.createWorkflow("make a review flow", REPO)
  await waitFor(() => runs(store)[0]?.payload.runId === "author-1")
  relay.state.events = [{ sequence: 1, occurredAt: 1, kind: "control.agent.cell-call-settled", payload: { callId: "write-1", flowName: "write", outcome: "success", value: { path: "flows/review/flow.ts" } } }]
  await waitFor(() => plans(store)[0]?.payload.status === "failed")
  expect(plans(store)[0]?.payload.error).toBe("The workspace refused the call.")
  expect(plans(store)[0]?.payload.error).not.toContain("source cannot compile")
  expect(plans(store)[0]?.payload.sourceReceipt?.runCardId).toBe(runs(store)[0]!.id)
  relay.state.terminal = true
  await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.title === "Authoring finished" && toast.status === "ok"))
  expect([...store.collections.toasts.values()].some(toast => toast.title === "Authoring finished" && toast.status === "ok")).toBe(true)
  expect(relay.calls.filter(call => call.procedure === "Plan" && call.payload.flowId === "review")).toHaveLength(1)
})

test("a launch from a previous identity cannot write a run or a completion toast", async () => {
  const relay = fixture()
  const { store, controller } = await ready(relay)
  await controller.createWorkflow("make a review flow", REPO)
  await waitFor(() => relay.calls.some(call => call.procedure === "Plan"))
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "someone-else", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  relay.release()
  await settle(30)
  expect(runs(store)).toHaveLength(0)
  expect(relay.calls.filter(call => call.procedure === "Run")).toHaveLength(0)
  expect([...store.collections.toasts.values()].some(toast => toast.title === "Authoring finished")).toBe(false)
})

test("reload reconnects a pending launch with the same control idempotency key", async () => {
  const relay = fixture()
  const storage = memoryStorage()
  const first = await ready(relay, storage)
  void first.controller.createWorkflow("make a review flow", REPO)
  try {
    await waitFor(() => relay.calls.some(call => call.procedure === "Plan"))
    const firstKey = relay.calls.find(call => call.procedure === "Plan")?.payload.idempotencyKey
    expect(firstKey).toBeTypeOf("string")
    await first.controller.dispose()
    const second = await ready(relay, storage)
    second.controller.resumeWorkflowRuns()
    await waitFor(() => relay.calls.filter(call => call.procedure === "Plan").length === 2)
    expect(relay.calls.filter(call => call.procedure === "Plan").map(call => call.payload.idempotencyKey)).toEqual([firstKey, firstKey])
    relay.release()
    await waitFor(() => runs(second.store)[0]?.payload.runId === "author-1")
    expect(runs(second.store)).toHaveLength(1)
    expect(runs(second.store)[0]?.payload.runId).toBe("author-1")
  } finally { relay.release() }
})

test("a newer receipt arriving before the Plan door opens cannot strand its observer", async () => {
  const relay = fixture()
  relay.release()
  const { store, controller } = await ready(relay)
  const execute = controller.commands.run
  let releasePlan!: () => void
  const held = new Promise<void>(resolve => { releasePlan = resolve })
  let requested = false
  Object.assign(controller.commands, { run: async (...args: Parameters<typeof execute>) => {
    if (args[0] === "flow.plan") { requested = true; await held }
    return execute(...args)
  } })
  try {
    await controller.createWorkflow("make a review flow", REPO)
    await waitFor(() => runs(store)[0]?.payload.runId === "author-1")
    const event = (sequence: number) => ({ sequence, occurredAt: sequence, kind: "control.agent.cell-call-settled", payload: {
      callId: `write-${sequence}`, flowName: "write", outcome: "success", value: { path: "flows/review/flow.ts" }
    } })
    relay.state.events = [event(1)]
    await waitFor(() => requested)
    relay.state.version = 2
    relay.state.events.push(event(2))
    await waitFor(() => store.committedRuntimeRun(runtimeRunKey(runs(store)[0]!.payload))?.events.length === 2)
    relay.state.terminal = true
    releasePlan()
    await waitFor(() => plans(store)[0]?.payload.nodes?.length === 2)
    await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.title === "Authoring finished" && toast.status === "ok"))
    expect(plans(store)).toHaveLength(1)
    expect(relay.calls.filter(call => call.procedure === "Plan" && call.payload.flowId === "review")).toHaveLength(1)
  } finally { releasePlan() }
})

test("reload ignores older authors and the next edit compares the latest plan", async () => {
  const relay = fixture()
  relay.release()
  const storage = memoryStorage()
  const first = await ready(relay, storage)
  for (let version = 1; version <= 2; version += 1) {
    relay.state.version = version
    relay.state.runId = `author-${version}`
    relay.state.terminal = true
    relay.state.events = [{ sequence: 1, occurredAt: version, kind: "control.agent.cell-call-settled", payload: {
      callId: `write-${version}`, flowName: "write", outcome: "success", value: { path: "flows/review/flow.ts" }
    } }]
    relay.state.recorded.set(relay.state.runId, { terminal: true, events: relay.state.events })
    await first.controller.createWorkflow(`edit ${version}`, REPO)
    await waitFor(() => plans(first.store)[0]?.payload.planId === `plan-review-${version}`)
  }
  const before = plans(first.store)[0]!
  const count = relay.calls.filter(call => call.procedure === "Plan" && call.payload.flowId === "review").length
  await first.controller.dispose()
  const second = await ready(relay, storage)
  second.controller.resumeWorkflowRuns()
  await settle(30)
  expect(plans(second.store)[0]?.payload.sourceReceipt).toEqual(before.payload.sourceReceipt)
  expect(relay.calls.filter(call => call.procedure === "Plan" && call.payload.flowId === "review")).toHaveLength(count)

  relay.state.version = 3
  relay.state.runId = "author-3"
  relay.state.events = [{ sequence: 1, occurredAt: 3, kind: "control.agent.cell-call-settled", payload: {
    callId: "write-3", flowName: "edit", outcome: "success", value: { path: "flows/review/flow.ts" }
  } }]
  await second.controller.createWorkflow("edit 3", REPO)
  await waitFor(() => plans(second.store)[0]?.payload.planId === "plan-review-3")
  expect(plans(second.store)).toHaveLength(1)
  expect(plans(second.store)[0]?.payload.previousPlan?.planId).toBe("plan-review-2")
})

test("a request whose card could not be saved can be requested again", async () => {
  const relay = fixture()
  relay.release()
  const disk = memoryStorage()
  let fail = false
  const storage = { ...disk, setItem: (key: string, value: string) => { if (fail) { fail = false; throw new Error("disk unavailable") } disk.setItem(key, value) } }
  const { store, controller } = await ready(relay, storage)
  fail = true
  await expect(controller.createWorkflow("make a review flow", REPO)).rejects.toThrow()
  expect(relay.calls.filter(call => call.procedure === "Plan")).toHaveLength(0)
  expect(await controller.createWorkflow("make a review flow", REPO)).toEqual({ value: `flow-requested repo=${REPO}` })
  await waitFor(() => runs(store)[0]?.payload.runId === "author-1")
  expect(runs(store)).toHaveLength(1)
})

test("an authoring wait holds no scope registration after it settles and still wakes on disposal", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const signIn = (login: string) => store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login, allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await signIn("will")
  const ctx = createControllerContext(store, silentAgent, { toastDebounceMs: 0, toastAutoDismissMs: 10000 })
  const { withToast } = createFailureController(ctx)
  /* Count the background authoring work in flight, through the real toast door. */
  let running = 0
  Object.assign(ctx, { withToast: (async (key, title, doneTitle, work, ...rest) => {
    running += 1
    try { return await withToast(key, title, doneTitle, work, ...rest) } finally { running -= 1 }
  }) satisfies typeof withToast })
  const register = ctx.onDispose
  let registrations = 0
  Object.assign(ctx, { onDispose: (finalizer: () => void | Promise<void>) => { registrations += 1; return register(finalizer) } })
  const authoring = createFlowAuthoringController(ctx, () => 0, async () => true, async () => {})
  /* A launched author whose run has not been read yet: every resume waits on it. */
  const launched = () => store.dispatch({ type: "card.upsert", actor: "system", card: { id: "flow-author-wait", kind: "run-trace", title: "Creating a flow", status: "active", ordinal: 1, createdAt: 1,
    payload: { repo: REPO, gatewayBindingVersion: 1, runId: "author-1", workflow: FLOW_AUTHORING_ENTRY, phase: "running", steps: [], result: null, lastSeq: 0,
      input: { args: "wait" }, authoring: { requestId: "request-1", owner: "will" } } } }).isPersisted.promise
  const constructed = registrations
  /* Each focus resumes the author; each account switch ends that wait. */
  for (let focus = 0; focus < 3; focus += 1) {
    await launched()
    authoring.resume()
    expect(running).toBe(1)
    await signIn("someone-else")
    await waitFor(() => running === 0)
    await signIn("will")
  }
  expect(registrations).toBe(constructed)
  await launched()
  authoring.resume()
  expect(running).toBe(1)
  await ctx.dispose()
  await waitFor(() => running === 0)
  await store.dispose?.()
})

test("an untagged authoring failure toasts its sentence and keeps the raw words only on the card", async () => {
  const RAW = "TypeError: undefined is not an object (evaluating 'launched.value.runId')"
  const relay = fixture()
  relay.release()
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await loadBox(store, REPO)
  let thrown = false
  const guarded = new Proxy(store, { get: (target, key, receiver) => key === "dispatch"
    ? (transition: Parameters<typeof store.dispatch>[0]) => {
      if (!thrown && transition.type === "card.upsert" && transition.card.kind === "run-trace" && transition.card.payload.runId === "author-1") { thrown = true; throw new Error(RAW) }
      return target.dispatch(transition)
    } : Reflect.get(target, key, receiver) })
  const controller = createController(guarded, silentAgent, { fetchImpl: relay.fetchImpl, workflowPollMs: 1, toastDebounceMs: 0, toastAutoDismissMs: 10000 })
  await controller.createWorkflow("make a review flow", REPO)
  await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.title === "Creating a flow" && toast.status === "failed"))
  const toast = [...store.collections.toasts.values()].find(toast => toast.title === "Creating a flow")!
  expect(toast.detail).toBe("The flow could not be created. Not your fault.")
  expect(runs(store)[0]?.payload.observationError).toContain(RAW)
})

test("a gateway refusal toasts the registry sentence, never its raw words", async () => {
  const relay = fixture()
  relay.state.fail = true
  relay.release()
  const { store, controller } = await ready(relay)
  await controller.createWorkflow("make a review flow", REPO)
  await waitFor(() => [...store.collections.toasts.values()].some(toast => toast.title === "Creating a flow" && toast.status === "failed"))
  const detail = [...store.collections.toasts.values()].find(toast => toast.title === "Creating a flow")?.detail
  expect(detail).toBe("The workspace refused the call.")
  expect(detail).not.toContain("authoring unavailable")
})
