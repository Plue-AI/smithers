import { releaseInterruptedApproval } from "./ApprovalRecovery"
import { describe, expect, test } from "bun:test"
import type { ApprovalRow } from "@smthrs/gateway/GatewayProjection"
import type { Card } from "./AppState"
import { approvalActionId, parseApprovalActionId } from "./ApprovalReference"
import { createAppStore, type AppStore } from "./AppStore"
import { memoryStorage } from "./TestFixtures"
import { runtimeApprovalKey } from "./RuntimeProjection"
import { reconcileRunApprovals } from "./controller/approval-reconciliation"
import { createWorkflowPumpController } from "./controller/workflow-pump"
import type { ControllerContext } from "./controller/context"

const repo = "owner/repo"
const workspaceA = "83e75ae5-0920-4000-8000-000000000001"
const workspaceB = "83e75ae5-0920-4000-8000-000000000002"
const row = (runId = "run", requestId = "deploy", status: ApprovalRow["status"] = "pending"): ApprovalRow => ({
  runId, requestId, status, requestedAt: 1, title: "Deploy?", request: {},
  payload: { target: { _tag: "Node", runId, requestId, digest: "sha256:reviewed", envelope: { capabilities: [], flows: [], budget: {} } },
    scope: "once", idempotencyKey: `${runId}:${requestId}` }
})
const card = (id: string, workspaceId: string, request = row()): Extract<Card, { kind: "approval" }> => ({
  id, kind: "approval", status: "active", title: request.title, createdAt: 1, ordinal: 1,
  payload: { repo, workspaceId, gatewayBindingVersion: 1, runId: request.runId, requestId: request.requestId,
    approval: request.payload as unknown as Record<string, unknown>, capability: request.title }
})
const inbox = (id: string, workspaceId: string): Extract<Card, { kind: "approvals-inbox" }> => ({
  id, kind: "approvals-inbox", status: "active", title: "Approvals", createdAt: 1, ordinal: 2,
  payload: { repo, workspaceId, gatewayBindingVersion: 1, approvals: [row("run-a"), row("run-b")].map((request) => ({
    runId: request.runId, requestId: request.requestId, title: request.title, requestedAt: request.requestedAt,
    approval: request.payload as unknown as Record<string, unknown>, pending: true
  })) }
})
const read = (store: AppStore, id: string) => {
  const result = store.collections.cards.get(id)
  if (result?.kind !== "approval") throw new Error(`Missing approval ${id}`)
  return result
}
const readInbox = (store: AppStore, id: string) => {
  const result = store.collections.cards.get(id)
  if (result?.kind !== "approvals-inbox") throw new Error(`Missing inbox ${id}`)
  return result
}

test("approval action identities preserve punctuation and bind all three identifiers", () => {
  const target = { runId: 'run: @ /"', requestId: "a:b/c@d?e%f" }
  const action = approvalActionId("inbox: workspace @ /", target)
  expect(action).not.toMatch(/\s/)
  expect(parseApprovalActionId(action)).toEqual({ cardId: "inbox: workspace @ /", ...target })
  expect(approvalActionId("inbox", { runId: "a:b", requestId: "c" })).not.toBe(approvalActionId("inbox", { runId: "a", requestId: "b:c" }))
  expect(parseApprovalActionId("approval-row@%oops")).toBeUndefined()
})

describe("approval observation recovery", () => {
  test("reset removes a decided observation whose insert has not committed", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    try {
      const observation = store.dispatch({ type: "gateway.approvals.observed", actor: "system",
        scope: { repo, workspaceId: workspaceA, runId: "run" }, rows: [row("run", "deploy", "approved")] })
      const reset = store.dispatch({ type: "app.reset", actor: "user" })
      await observation.isPersisted.promise
      await reset.isPersisted.promise
      expect(store.collections.runtimeApprovals.size).toBe(0)
      expect((await store.verifyState()).valid).toBe(true)
    } finally { await store.dispose?.() }
  })

  for (const decision of ["approved", "denied"] as const) test(`${decision} is visible only after its local receipt survives reload`, async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    const scope = { repo, workspaceId: workspaceA, runId: "run" }
    const id = runtimeApprovalKey(scope, "deploy", "sha256:reviewed")
    try {
      await store.dispatch({ type: "card.upsert", actor: "system", card: card("a", workspaceA) }).isPersisted.promise
      await store.dispatch({ type: "gateway.approvals.observed", actor: "system", scope, rows: [row()] }).isPersisted.promise
      await store.dispatch({ type: "gateway.approval.submission.changed", actor: "user",
        submission: { id, submissionId: "attempt", state: "pending" } }).isPersisted.promise
      const receipt = store.dispatch({ type: "gateway.approval.submission.changed", actor: "user",
        submission: { id, submissionId: "attempt", state: decision, decidedAt: 2 } })
      const beforeSave = read(store, "a").payload
      // Unrelated input must stay usable without exposing the queued decision.
      const chat = store.dispatch({ type: "composer.changed", actor: "user", draft: "Still usable" })
      const afterInput = read(store, "a").payload
      await receipt.isPersisted.promise
      await chat.isPersisted.promise
      expect(beforeSave.decision).toBeUndefined()
      expect(beforeSave.pending).toBe(true)
      expect(afterInput.decision).toBeUndefined()
      expect(read(store, "a").payload.decision).toBe(decision)
      await store.dispose?.()
      const restored = await createAppStore({ kind: "localStorage", storage })
      try {
        expect(read(restored, "a").payload.decision).toBe(decision)
        expect((await restored.verifyState()).valid).toBe(true)
      } finally { await restored.dispose?.() }
    } finally { await store.dispose?.() }
  })

  test("a failed decision save never presents a completed approval", async () => {
    const storage = memoryStorage()
    let rejectWrites = false
    const store = await createAppStore({ kind: "localStorage", storage: { ...storage,
      setItem: (key, value) => { if (rejectWrites) throw new Error("disk full"); storage.setItem(key, value) }
    } })
    const scope = { repo, workspaceId: workspaceA, runId: "run" }
    const id = runtimeApprovalKey(scope, "deploy", "sha256:reviewed")
    const displayed: string[] = []
    const observer = store.collections.runtimeApprovals.subscribeChanges(changes => {
      for (const change of changes) displayed.push(change.value.row.status)
    })
    try {
      await store.dispatch({ type: "gateway.approvals.observed", actor: "system", scope, rows: [row()] }).isPersisted.promise
      await store.dispatch({ type: "gateway.approval.submission.changed", actor: "user",
        submission: { id, submissionId: "attempt", state: "pending" } }).isPersisted.promise
      rejectWrites = true
      const receipt = store.dispatch({ type: "gateway.approval.submission.changed", actor: "user",
        submission: { id, submissionId: "attempt", state: "approved", decidedAt: 2 } })
      await expect(receipt.isPersisted.promise).rejects.toThrow("disk full")
      expect(displayed).not.toContain("approved")
      expect(store.collections.runtimeApprovals.get(id)?.row.status).toBe("pending")
    } finally { rejectWrites = false; observer.unsubscribe(); await store.dispose?.() }
  })

  test("reload releases only interrupted submission guards, preserving the reviewed requests", async () => {
    const storage = memoryStorage()
    const store = await createAppStore({ kind: "localStorage", storage })
    await store.dispatch({ type: "card.upsert", actor: "system", card: card("a", workspaceA) }).isPersisted.promise
    await store.dispatch({ type: "card.approval.decision.pending", actor: "user", id: "a" }).isPersisted.promise
    await store.dispatch({ type: "card.upsert", actor: "system", card: inbox("inbox", workspaceA) }).isPersisted.promise
    const trusted = structuredClone(store.approvalRequest("a"))
    await store.dispose?.()
    const reopened = await createAppStore({ kind: "localStorage", storage })
    expect(read(reopened, "a").payload.pending).toBe(false)
    expect(read(reopened, "a").payload.decision).toBeUndefined()
    expect(read(reopened, "a").payload.error).toContain("outcome is unknown")
    expect(readInbox(reopened, "inbox").payload.approvals.every((entry) => entry.pending !== true && entry.decision === undefined)).toBe(true)
    expect(reopened.approvalRequest("a")).toEqual(trusted)
    await reconcileRunApprovals(reopened, { repo, workspaceId: workspaceA, runId: "run" }, [row("run", "deploy", "approved")])
    expect(read(reopened, "a").payload.decision).toBe("approved")
    expect(read(reopened, "a").payload.decidedAt).toBeUndefined()
    await reopened.dispose?.()
  })

  test("observed decisions bind workspace, run, request and reviewed digest", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    for (const entry of [card("a", workspaceA), card("b", workspaceB), card("other", workspaceA, row("other-run")),
      inbox("inbox-a", workspaceA), inbox("inbox-b", workspaceB)]) {
      await store.dispatch({ type: "card.upsert", actor: "system", card: entry }).isPersisted.promise
    }
    const original = row("run", "deploy", "approved")
    const wrongDigest = { ...original, payload: { ...original.payload, target: { ...original.payload.target, digest: "different" } } }
    await reconcileRunApprovals(store, { repo, workspaceId: workspaceA, runId: "run" }, [wrongDigest])
    expect(read(store, "a").payload.decision).toBeUndefined()
    await reconcileRunApprovals(store, { repo, workspaceId: workspaceA, runId: "run" }, [row("run", "deploy", "denied")])
    expect(read(store, "a").payload.decision).toBe("denied")
    expect(read(store, "b").payload.decision).toBeUndefined()
    expect(read(store, "other").payload.decision).toBeUndefined()
    await reconcileRunApprovals(store, { repo, workspaceId: workspaceA, runId: "run-b" }, [row("run-b", "deploy", "approved")])
    expect(readInbox(store, "inbox-a").payload.approvals.map((entry) => entry.decision)).toEqual([undefined, "approved"])
    expect(readInbox(store, "inbox-b").payload.approvals.map((entry) => entry.decision)).toEqual([undefined, undefined])
    expect([...store.collections.transitions.values()].filter((event) => event.type === "gateway.approvals.observed")).toHaveLength(3)
    await store.dispose?.()
  })

  test("the pump reconciles externally decided approvals even when the run has already completed", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    await store.dispatch({ type: "card.upsert", actor: "system", card: card("a", workspaceA) }).isPersisted.promise
    await store.dispatch({ type: "card.upsert", actor: "system", card: {
      id: "trace", kind: "run-trace", status: "active", title: "Run", createdAt: 1, ordinal: 3,
      payload: { repo, workspaceId: workspaceA, gatewayBindingVersion: 1, runId: "run", workflow: "test",
        phase: "waiting-approval", steps: [], result: null, lastSeq: 0 }
    } }).isPersisted.promise
    let reads = 0
    const ctx = { store, services: {}, workflowPollMs: 1, unref: () => {},
      runPumps: new Map(), pumpPokes: new Map(), finishTutorialChange: async () => {}, gateway: {
        run: async () => ({ status: "ok", value: { runId: "run", flowId: "test", status: "completed", createdAt: 1, updatedAt: 2, turns: 1, calls: 1, callsFailed: 0, verdict: "done", diagnosis: "done", editsAttempted: 0, editsSucceeded: 0, inputTokens: 0, outputTokens: 0 } }),
        approvals: async (actualRepo: string, actualRun: string, binding: unknown) => {
          expect([actualRepo, actualRun, binding]).toEqual([repo, "run", { workspaceId: workspaceA }])
          reads++
          return { status: "ok", value: [row("run", "deploy", "denied")] }
        },
        runEvents: async () => ({ status: "ok", value: [] })
      } } as unknown as ControllerContext
    await createWorkflowPumpController(ctx, () => 4).pumpWorkflowRun("trace")
    expect(reads).toBe(1)
    expect(read(store, "a").payload.decision).toBe("denied")
    expect(store.collections.cards.get("trace")?.status).toBe("acted")
    await store.dispose?.()
  })
})

test("a failed inbox forward releases only that request and retains other pending decisions", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  try {
    const value = inbox("inbox", workspaceA)
    await store.dispatch({ type: "card.upsert", actor: "system", card: value }).isPersisted.promise
    await releaseInterruptedApproval(store, store.collections.cards.get(value.id), "The browser did not save the decision.", { requestId: "deploy", runId: "run-a" })
    const current = store.collections.cards.get(value.id)
    expect(current?.kind).toBe("approvals-inbox")
    if (current?.kind !== "approvals-inbox") throw Error("missing inbox")
    expect(current.payload.approvals[0]).toMatchObject({ pending: undefined, decisionError: "The browser did not save the decision." })
    expect(current.payload.approvals[1]?.pending).toBe(true)
  } finally { await store.dispose?.() }
})
