import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import type { ApprovalRow } from "@smthrs/gateway/GatewayProjection"
import { createAppStore } from "../state/AppStore"
import { memoryStorage } from "../state/TestFixtures"
import { runtimeApprovalKey } from "../state/RuntimeProjection"
import type { Card } from "../state/AppState"
import type { CardActions } from "./CardFamily"
import { approvalCardFamily } from "./ApprovalCard"
GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())

for (const decision of ["approved", "denied"] as const) test(`private runtime grant submits ${decision} and retains its receipt`, async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const scope = { repo: "owner/repo", workspaceId: "83e75ae5-0920-4000-8000-000000000001", runId: "run" }
  const row: ApprovalRow = { ...scope, requestId: "ask/run/digest", title: "Allow the effect?", request: {}, requestedAt: 1, status: "pending",
    payload: { target: { _tag: "Node", runId: "run", requestId: "ask/run/digest", digest: "digest", envelope: { capabilities: [], flows: ["ask"], budget: {} } }, scope: "run", idempotencyKey: "grant" } }
  const card: Extract<Card, { kind: "approval" }> = { id: "grant", kind: "approval", title: row.title, status: "active", ordinal: 1, createdAt: 1,
    payload: { ...scope, requestId: row.requestId, capability: row.title, approval: row.payload as unknown as Record<string, unknown> } }
  const calls: unknown[] = []
  const actions = { projectionStore: store, onDecideApproval: (...args: unknown[]) => calls.push(args), onRunCommand: () => {} } as unknown as CardActions
  const host = document.createElement("div"), root = createRoot(host)
  try {
    await store.dispatch({ type: "gateway.approvals.observed", actor: "system", scope, rows: [row] }).isPersisted.promise
    await act(async () => root.render(approvalCardFamily.approval.render(card, actions)))
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons.map(button => button.textContent)).toEqual(["Approve", "Deny"])
    await act(async () => buttons[decision === "approved" ? 0 : 1]!.click())
    expect(calls).toEqual([["grant", decision]])
    const id = runtimeApprovalKey(scope, row.requestId, "digest")
    await act(async () => { await store.dispatch({ type: "gateway.approval.submission.changed", actor: "user", submission: { id, submissionId: "press", state: "pending" } }).isPersisted.promise })
    expect([...host.querySelectorAll<HTMLButtonElement>("button")].every(button => button.disabled)).toBe(true)
    await act(async () => { await store.dispatch({ type: "gateway.approval.submission.changed", actor: "user", submission: { id, submissionId: "press", state: decision, decidedAt: 2 } }).isPersisted.promise })
    expect(host.querySelectorAll("button")).toHaveLength(0)
    expect(host.textContent).toContain(decision === "approved" ? "Approved" : "Denied")
  } finally { await act(async () => root.unmount()); await store.dispose?.() }
})
