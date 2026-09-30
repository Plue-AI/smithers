import { expect, test } from "bun:test"
import type { ApprovalRow } from "@smthrs/gateway/GatewayProjection"
import type { Card } from "./AppState"
import { createAppStore, type AppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { approvalCardIdFor } from "./RunReference"
import { applicationIdentityFromFetch, loadBox, memoryStorage, silentAgent, TEST_BOX } from "./TestFixtures"

const createAppController = scopedControllers()
const repo = "owner/private-repo", runId = "private-run", traceId = "private-trace"
const scope = { repo, workspaceId: TEST_BOX, runId }
const approval = {
  runId, requestId: "private-gate", status: "pending", requestedAt: 1, title: "Private deployment?", request: {},
  payload: { target: { _tag: "Node", runId, requestId: "private-gate", digest: "reviewed-digest",
    envelope: { capabilities: [], flows: [], budget: {} } }, scope: "once", idempotencyKey: "private-decision" }
} satisfies ApprovalRow
const summary = { runId, flowId: "test", status: "completed", waitingReason: "approval", createdAt: 1, updatedAt: 2,
  turns: 1, calls: 0, callsFailed: 0, verdict: "Private run finished", diagnosis: "done", editsAttempted: 0,
  editsSucceeded: 0, inputTokens: 0, outputTokens: 0 }
const trace: Extract<Card, { kind: "run-trace" }> = {
  id: traceId, kind: "run-trace", title: "Private run", status: "active", createdAt: 1, ordinal: 1,
  payload: { ...scope, gatewayBindingVersion: 1, workflow: "test", phase: "running", steps: [], result: null, lastSeq: 0 }
}
const waitFor = async (ready: () => boolean) => {
  for (let attempts = 0; attempts < 500; attempts++) {
    if (ready()) return
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  throw new Error("Approval fixture did not settle")
}
type Hold = "receipt" | "provision" | "response"
type Change = "sign-out" | "replacement" | "ABA" | "dispose"

// Controlled HTTP answers and a delayed receipt isolate the race. The real
// dispatcher, journal, privacy retirement and durable reopen stay in the test.
// Holding the caller's receipt AFTER the real write does not block sign-out's
// persistence queue, reproducing a continuation resuming after owner retirement.
const fixture = async (hold: Hold = "receipt", rejectReceipt = false, refuseResponse = false) => {
  const storage = memoryStorage(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const returned = Promise.withResolvers<void>()
  const store = await createAppStore({ kind: "localStorage", storage })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "old-owner",
    provider: "github", allowlisted: true, admin: false, scopesPlain: null }).isPersisted.promise
  await store.dispatch({ type: "repositories.loaded", actor: "system", repositories: [
    { id: repo, org: "owner", ownerKind: "user", name: "private-repo", head: null }
  ] }).isPersisted.promise
  await loadBox(store, repo)
  const requests: string[] = []
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://app.test")
    if (url.pathname === "/api/auth/logout") return new Response(null, { status: 204 })
    if (url.pathname === "/api/workflow/provision") {
      requests.push("provision")
      if (hold === "provision") { entered.resolve(); await release.promise; returned.resolve() }
      return Response.json({ status: "ready", repo, gatewayId: "gateway" })
    }
    if (url.pathname === "/api/workflow/rpc") {
      const body = JSON.parse(String(init?.body)) as { repo: string; procedure: string; payload: {
        selector?: { _tag: string; runId?: string }; workspaceId?: string
      } }
      expect(body.repo).toBe(repo)
      if (body.procedure === "Projection.Snapshot") {
        const projection = body.payload.selector!._tag
        requests.push(projection)
        if (projection === "approvals" && hold === "response") { entered.resolve(); await release.promise; returned.resolve() }
        if (projection === "approvals" && refuseResponse) return Response.json({ ok: false,
          error: { code: "unavailable", message: "Private boot approval refusal" } })
        return Response.json({ ok: true, payload: { cursor: { projection, runId: null, value: 0 },
          rows: projection === "approvals" ? [approval] : projection === "run-summary" ? [summary] : [] } })
      }
      if (body.procedure === "Cancel") return Response.json({ ok: true, payload: { _tag: "Accepted", receiptId: "cancel" } })
    }
    // Independent identity, billing, factory and homepage reads have no data.
    return Response.json({ scopes: [] }, { status: 404 })
  }
  const diagnostics: string[] = []
  const controller = createAppController(store, silentAgent, { fetchImpl,
    clientErrors: { report: (_kind, error) => { diagnostics.push(String(error)) }, reported: () => diagnostics.length },
    applicationIdentity: applicationIdentityFromFetch(fetchImpl), workflowPollMs: 1, toastDebounceMs: 0 })
  await store.settled?.()
  const dispatch = store.dispatch, writes: Parameters<typeof dispatch>[0][] = []
  Object.assign(store, { dispatch: (event: Parameters<typeof dispatch>[0]) => {
    writes.push(event)
    const receipt = dispatch(event)
    if (event.type === "gateway.approvals.observed" && hold === "receipt") {
      return { ...receipt, isPersisted: { promise: receipt.isPersisted.promise.then(async () => {
        entered.resolve()
        await release.promise
        returned.resolve()
        if (rejectReceipt) throw new Error("Private delayed receipt failure")
      }) } }
    }
    return receipt
  } })
  const change = async (kind: Change) => {
    if (kind === "sign-out") {
      expect((await controller.commands.run("auth.sign-out")).status).toBe("executed")
    } else if (kind === "dispose") await controller.dispose()
    else {
      await controller.adoptSession({ state: "signed-in", login: "new-owner", allowlisted: true, admin: false })
      if (kind === "ABA") await controller.adoptSession({ state: "signed-in", login: "old-owner", allowlisted: true, admin: false })
    }
  }
  const close = async () => { release.resolve(); Object.assign(store, { dispatch }); await controller.dispose() }
  return { store, storage, controller, entered, release, returned, requests, writes, diagnostics, change, close }
}

const privateMarkers = [runId, traceId, repo, approval.requestId, approval.title, summary.verdict, "Private delayed receipt failure"]
const carriesPrivate = (value: unknown): boolean => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? ""
  return privateMarkers.some(marker => text.includes(marker))
}
const privateWrites = (writes: Awaited<ReturnType<typeof fixture>>["writes"]) => writes.filter(event =>
  event.type === "gateway.run.observed" ||
  event.type === "gateway.approvals.observed" && carriesPrivate(event.rows) ||
  event.type === "card.upsert" && (event.card.kind === "approval" || carriesPrivate(event.card.payload)) ||
  event.type === "card.updated" && carriesPrivate(event.patch) ||
  event.type === "message.appended" && carriesPrivate(event.text)
)
const actionableEnvelope = (store: AppStore, id: string) => {
  const card = store.approvalRequest(id)
  if (card?.kind !== "approval") throw new Error(`Missing actionable approval ${id}`)
  return card.payload.approval
}
const assertRetired = async (store: AppStore) => {
  expect([...store.collections.cards.values()].filter(card => card.kind === "approval")).toEqual([])
  expect([...store.collections.cards.values()].some(card => carriesPrivate(card.payload))).toBe(false)
  expect(store.collections.runtimeApprovals.size).toBe(0)
  expect([...store.collections.messages.values()].some(message => carriesPrivate(message.text))).toBe(false)
  expect((await store.verifyState()).valid).toBe(true)
}

for (const change of ["sign-out", "replacement", "ABA", "dispose"] as const) {
  for (const hold of ["receipt", "provision", "response"] as const) test(`approvals.open retires ${hold} continuation after ${change}`, async () => {
    const t = await fixture(hold)
    const result = t.controller.commands.run("approvals.open", runId)
    let reopened: AppStore | undefined
    try {
      await t.entered.promise
      if (hold === "receipt") expect(t.store.collections.runtimeApprovals.size).toBe(1)
      await t.change(change)
      const after = t.writes.length
      t.release.resolve()
      const outcome = await result
      expect(outcome.status).toBe("failed")
      expect(JSON.stringify(outcome)).not.toContain("opened for run")
      expect(privateWrites(t.writes.slice(after))).toEqual([])
      if (hold === "provision") expect(t.requests).toEqual(["provision"])
      await t.close()
      reopened = await createAppStore({ kind: "localStorage", storage: t.storage })
      if (change !== "dispose") await assertRetired(reopened)
      else expect([...reopened.collections.cards.values()].filter(card => card.kind === "approval")).toEqual([])
    } finally { await t.close(); await result; await reopened?.dispose?.() }
  })

  for (const rejectReceipt of [false, true]) test(`run pump retires held approval receipt after ${change} (${rejectReceipt ? "reject" : "resolve"})`, async () => {
    const t = await fixture("receipt", rejectReceipt)
    let reopened: AppStore | undefined
    try {
      await t.store.dispatch({ type: "card.upsert", actor: "system", card: trace }).isPersisted.promise
      expect((await t.controller.commands.run("flow.run.retry", traceId)).status).toBe("executed")
      await t.entered.promise
      expect(t.store.collections.runtimeApprovals.size).toBe(1)
      await t.change(change)
      const after = t.writes.length, reads = t.requests.length, reported = t.diagnostics.length
      t.release.resolve()
      await t.returned.promise
      // Drain the continuation released by the receipt, including its catch.
      await new Promise(resolve => setTimeout(resolve, 0))
      await t.store.settled?.()
      expect(privateWrites(t.writes.slice(after))).toEqual([])
      expect(t.requests.slice(reads)).toEqual([])
      expect(t.diagnostics.slice(reported).filter(carriesPrivate)).toEqual([])
      await t.close()
      reopened = await createAppStore({ kind: "localStorage", storage: t.storage })
      if (change !== "dispose") await assertRetired(reopened)
      else expect([...reopened.collections.cards.values()].filter(card => card.kind === "approval")).toEqual([])
    } finally { await t.close(); await reopened?.dispose?.() }
  })

  test(`approvals.open refuses a rejected stale receipt neutrally after ${change}`, async () => {
    const t = await fixture("receipt", true)
    const result = t.controller.commands.run("approvals.open", runId)
    try {
      await t.entered.promise
      await t.change(change)
      const after = t.writes.length
      t.release.resolve()
      const outcome = await result
      expect(outcome.status).toBe("failed")
      expect(JSON.stringify(outcome)).not.toContain("Private delayed receipt failure")
      if (change !== "dispose") expect(outcome).toMatchObject({
        error: "The account changed before the approvals could be read. Run the command again." })
      expect(privateWrites(t.writes.slice(after))).toEqual([])
    } finally { await t.close(); await result }
  })
}

test("same-account approvals.open waits for the real receipt then retains actionable approvals after reload", async () => {
  const t = await fixture(), id = approvalCardIdFor(t.store, scope, approval.requestId)
  let answered = false, reopened: AppStore | undefined
  const result = t.controller.commands.run("approvals.open", runId).then(outcome => { answered = true; return outcome })
  try {
    await t.entered.promise
    expect(answered).toBe(false)
    expect(t.store.collections.cards.get(id)).toBeUndefined()
    t.controller.changeDraft("Chat remains usable")
    await t.store.settled?.()
    expect(t.store.session().draft).toBe("Chat remains usable")
    t.release.resolve()
    expect(await result).toMatchObject({ status: "executed", value: `1 approval opened for run ${runId}.` })
    expect(actionableEnvelope(t.store, id)).toEqual(approval.payload)
    await t.close()
    reopened = await createAppStore({ kind: "localStorage", storage: t.storage })
    expect(actionableEnvelope(reopened, id)).toEqual(approval.payload)
    expect((await reopened.verifyState()).valid).toBe(true)
  } finally { await t.close(); await result; await reopened?.dispose?.() }
})

test("same-account approvals.open reports a rejected receipt without opening an approval", async () => {
  const t = await fixture("receipt", true)
  const result = t.controller.commands.run("approvals.open", runId)
  try {
    await t.entered.promise
    t.release.resolve()
    const outcome = await result
    expect(outcome.status).toBe("failed")
    expect(JSON.stringify(outcome)).not.toContain("opened for run")
    expect([...t.store.collections.cards.values()].filter(card => card.kind === "approval")).toEqual([])
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { await t.close(); await result }
})

test("same-account pump publishes approvals and run completion only after its held receipt", async () => {
  const t = await fixture(), id = approvalCardIdFor(t.store, scope, approval.requestId)
  let reopened: AppStore | undefined
  try {
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: trace }).isPersisted.promise
    expect((await t.controller.commands.run("flow.run.retry", traceId)).status).toBe("executed")
    await t.entered.promise
    expect(t.store.collections.cards.get(id)).toBeUndefined()
    expect(t.requests).toEqual(["run-summary", "approvals"])
    t.release.resolve()
    await waitFor(() => t.store.collections.cards.get(traceId)?.status === "acted")
    expect(actionableEnvelope(t.store, id)).toEqual(approval.payload)
    expect(t.requests.slice(0, 3)).toEqual(["run-summary", "approvals", "run-events"])
    expect([...t.store.collections.cards.values()].filter(card => card.kind === "approval")).toHaveLength(1)
    await t.close()
    reopened = await createAppStore({ kind: "localStorage", storage: t.storage })
    expect(actionableEnvelope(reopened, id)).toEqual(approval.payload)
    expect(reopened.collections.cards.get(traceId)).toMatchObject({ status: "acted", payload: { phase: "completed" } })
    expect((await reopened.verifyState()).valid).toBe(true)
  } finally { await t.close(); await reopened?.dispose?.() }
})

test("a replaced pump cannot publish after its successor has completed", async () => {
  const t = await fixture(), id = approvalCardIdFor(t.store, scope, approval.requestId)
  try {
    await t.store.dispatch({ type: "card.upsert", actor: "system", card: trace }).isPersisted.promise
    expect((await t.controller.commands.run("flow.run.retry", traceId)).status).toBe("executed")
    await t.entered.promise
    // Cancellation removes the original watcher; its accepted receipt starts
    // the successor while the original still awaits the local approval receipt.
    expect((await t.controller.commands.run("flow.run.stop", traceId)).status).toBe("executed")
    await waitFor(() => t.store.collections.cards.get(traceId)?.status === "acted" && t.requests.includes("flow-durations"))
    expect(actionableEnvelope(t.store, id)).toEqual(approval.payload)
    await t.store.settled?.()
    const after = t.writes.length, reads = t.requests.length
    t.release.resolve()
    await t.returned.promise
    await new Promise(resolve => setTimeout(resolve, 0))
    await t.store.settled?.()
    expect(privateWrites(t.writes.slice(after))).toEqual([])
    expect(t.requests.slice(reads)).toEqual([])
    expect([...t.store.collections.cards.values()].filter(card => card.kind === "approval")).toHaveLength(1)
    expect((await t.store.verifyState()).valid).toBe(true)
  } finally { await t.close() }
})

const bootCard = (kind: "approval" | "approvals-inbox"): Card => {
  const common = { id: "boot-approval", title: "Private approval", status: "active" as const, createdAt: 1, ordinal: 1 }
  return kind === "approval" ? { ...common, kind, payload: { ...scope, gatewayBindingVersion: 1,
    capability: approval.title, requestId: approval.requestId, approval: approval.payload } }
    : { ...common, kind, payload: { repo, workspaceId: TEST_BOX, gatewayBindingVersion: 1, approvals: [
      { runId, requestId: approval.requestId, title: approval.title, requestedAt: 1, approval: approval.payload }
    ] } }
}
const bootDiagnostics = (diagnostics: string[]) => diagnostics.filter(record => record.includes('"seam":"approval.reconcile"'))

for (const kind of ["approval", "approvals-inbox"] as const) {
  for (const change of ["sign-out", "replacement", "ABA", "dispose"] as const) {
    for (const outcome of ["response", "refusal", "receipt-rejection"] as const) {
      test(`boot ${kind} reconciliation retires ${outcome} after ${change}`, async () => {
        const receipt = outcome === "receipt-rejection"
        const t = await fixture(receipt ? "receipt" : "response", receipt, outcome === "refusal")
        let reopened: AppStore | undefined
        try {
          await t.store.dispatch({ type: "card.upsert", actor: "system", card: bootCard(kind) }).isPersisted.promise
          t.controller.resumeWorkflowRuns()
          await t.entered.promise
          expect(t.requests).toEqual(["approvals"])
          if (receipt) expect(t.store.collections.runtimeApprovals.size).toBe(1)
          await t.change(change)
          const after = t.writes.length, reported = t.diagnostics.length
          t.release.resolve()
          await t.returned.promise
          await new Promise(resolve => setTimeout(resolve, 0))
          await t.store.settled?.()
          expect(t.writes.slice(after).filter(event => event.type === "gateway.approvals.observed")).toEqual([])
          expect(bootDiagnostics(t.diagnostics.slice(reported))).toEqual([])
          expect(privateWrites(t.writes.slice(after))).toEqual([])
          await t.close()
          reopened = await createAppStore({ kind: "localStorage", storage: t.storage })
          if (change !== "dispose") await assertRetired(reopened)
          else expect(reopened.collections.runtimeApprovals.size).toBe(receipt ? 1 : 0)
        } finally { await t.close(); await reopened?.dispose?.() }
      })
    }
  }

  test(`same-account boot ${kind} reconciliation persists and retains an actionable gate`, async () => {
    const t = await fixture("response")
    let reopened: AppStore | undefined
    try {
      await t.store.dispatch({ type: "card.upsert", actor: "system", card: bootCard(kind) }).isPersisted.promise
      t.controller.resumeWorkflowRuns()
      await t.entered.promise
      expect(t.store.collections.runtimeApprovals.size).toBe(0)
      t.release.resolve()
      await waitFor(() => t.store.collections.runtimeApprovals.size === 1)
      await t.store.settled?.()
      expect(t.store.approvalRequest("boot-approval")).toMatchObject({ kind })
      expect(bootDiagnostics(t.diagnostics)).toEqual([])
      await t.close()
      reopened = await createAppStore({ kind: "localStorage", storage: t.storage })
      expect(reopened.collections.runtimeApprovals.size).toBe(1)
      expect(reopened.approvalRequest("boot-approval")).toMatchObject({ kind })
      expect((await reopened.verifyState()).valid).toBe(true)
    } finally { await t.close(); await reopened?.dispose?.() }
  })

  test(`same-account boot ${kind} reconciliation reports its failed receipt`, async () => {
    const t = await fixture("receipt", true)
    try {
      await t.store.dispatch({ type: "card.upsert", actor: "system", card: bootCard(kind) }).isPersisted.promise
      t.controller.resumeWorkflowRuns()
      await t.entered.promise
      t.release.resolve()
      await waitFor(() => bootDiagnostics(t.diagnostics).length === 1)
      const diagnostic = JSON.parse(bootDiagnostics(t.diagnostics)[0]!) as { seam: string; subject: string; message: string }
      expect(diagnostic).toMatchObject({ seam: "approval.reconcile", subject: runId })
      expect(diagnostic.message).toContain("Private delayed receipt failure")
      expect((await t.store.verifyState()).valid).toBe(true)
    } finally { await t.close() }
  })

  test(`same-account boot ${kind} reconciliation reports a refused gateway response`, async () => {
    const t = await fixture("response", false, true)
    try {
      await t.store.dispatch({ type: "card.upsert", actor: "system", card: bootCard(kind) }).isPersisted.promise
      t.controller.resumeWorkflowRuns()
      await t.entered.promise
      t.release.resolve()
      await waitFor(() => bootDiagnostics(t.diagnostics).length === 1)
      expect(JSON.parse(bootDiagnostics(t.diagnostics)[0]!)).toMatchObject({ seam: "approval.reconcile", subject: runId })
      expect(t.store.collections.runtimeApprovals.size).toBe(0)
      expect((await t.store.verifyState()).valid).toBe(true)
    } finally { await t.close() }
  })
}
