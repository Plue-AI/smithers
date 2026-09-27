import { expect, test } from "bun:test"
import type { ApprovalRow } from "@smthrs/gateway/GatewayProjection"
import type { Card } from "../AppState"
import { createAppStore } from "../AppStore"
import { memoryStorage, silentAgent } from "../TestFixtures"
import { runtimeApprovalKey } from "../RuntimeProjection"
import { createControllerContext } from "./context"
import { createWorkflowController } from "./workflows"

const scope = { repo: "owner/repo", workspaceId: "83e75ae5-0920-4000-8000-000000000001", runId: "run" }
const row: ApprovalRow = {
  runId: scope.runId, requestId: "gate", status: "pending", requestedAt: 1, title: "Read build logs?", request: {},
  payload: { target: { _tag: "Node", runId: scope.runId, requestId: "gate", digest: "sha256:reviewed", envelope: { capabilities: [], flows: [], budget: {} } }, scope: "once", idempotencyKey: "run:gate" }
}
const id = runtimeApprovalKey(scope, row.requestId, "sha256:reviewed")
const approval: Extract<Card, { kind: "approval" }> = {
  id: "gate-card", kind: "approval", status: "active", title: row.title, createdAt: 1, ordinal: 1,
  payload: { ...scope, gatewayBindingVersion: 1, requestId: row.requestId, capability: row.title, approval: row.payload as unknown as Record<string, unknown> }
}
const inbox: Extract<Card, { kind: "approvals-inbox" }> = {
  id: "inbox", kind: "approvals-inbox", status: "active", title: "Approvals", createdAt: 1, ordinal: 2,
  payload: { repo: scope.repo, workspaceId: scope.workspaceId, gatewayBindingVersion: 1,
    approvals: [{ runId: row.runId, requestId: row.requestId, title: row.title, requestedAt: row.requestedAt, approval: row.payload as unknown as Record<string, unknown> }] }
}

for (const surface of ["card", "inbox"] as const) {
  for (const boundary of ["current", "disposed", "superseded"] as const) {
    test(`${surface} recovery respects a ${boundary} submission`, async () => {
      const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
      const ctx = createControllerContext(store, silentAgent, {})
      const held = Promise.withResolvers<void>()
      const started = Promise.withResolvers<void>()
      Object.assign(ctx.gateway, {
        submitApproval: async () => ({ status: "error", message: "Decision response lost" }),
        approvals: async () => { started.resolve(); await held.promise; return { status: "ok", value: [{ ...row, status: "approved" }] } }
      })
      const workflows = createWorkflowController(ctx, () => 3, async () => {})
      let pending: Promise<void> | undefined
      try {
        await store.dispatch({ type: "card.upsert", actor: "system", card: surface === "card" ? approval : inbox }).isPersisted.promise
        await store.dispatch({ type: "gateway.approvals.observed", actor: "system", scope, rows: [row] }).isPersisted.promise
        if (surface === "card") await store.dispatch({ type: "card.approval.decision.pending", actor: "user", id: approval.id }).isPersisted.promise
        pending = surface === "card" ? workflows.forwardApprovalDecision(approval, "approved") : workflows.forwardInboxApprovalDecision(inbox.id, row.requestId, "approved", row.runId)
        await started.promise
        if (boundary === "disposed") await ctx.dispose()
        else if (boundary === "superseded") {
          const current = store.collections.runtimeApprovals.get(id)!
          await store.dispatch({ type: "gateway.approval.submission.changed", actor: "system", submission: { id, submissionId: current.submissionId!, state: "failed", error: "Retry" } }).isPersisted.promise
          await store.dispatch({ type: "gateway.approval.submission.changed", actor: "user", submission: { id, submissionId: "new-attempt", state: "pending" } }).isPersisted.promise
        }
        const before = await store.eventHistory()
        const projection = [...store.collections.runtimeApprovals.values()]
        held.resolve()
        await pending
        if (boundary === "current") {
          expect(store.collections.runtimeApprovals.get(id)?.row.status).toBe("approved")
          expect(store.collections.runtimeApprovals.get(id)?.pending).not.toBe(true)
        } else {
          expect(await store.eventHistory()).toEqual(before)
          expect([...store.collections.runtimeApprovals.values()]).toEqual(projection)
        }
      } finally { held.resolve(); await pending; await ctx.dispose(); await store.dispose?.() }
    })
  }
}
