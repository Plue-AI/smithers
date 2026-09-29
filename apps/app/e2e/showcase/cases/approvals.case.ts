import { expect } from "@playwright/test"
import { showcase } from "../showcase"
import { boxRunCardId, runningBox } from "../../playwright/cloudFixture"

const REPO = "smithersai/smithers"
const ENVELOPE = { capabilities: [], flows: [], budget: {} }

/** One pending gate as the approvals projection answers it (state/controller/gateway.test.ts). */
const gate = (runId: string, requestId: string, title: string, requestedAt: number) => ({
  runId, requestId, title, request: { question: title },
  payload: {
    target: { _tag: "Node", runId, requestId, digest: `sha256:${requestId}`, envelope: ENVELOPE },
    scope: "run", idempotencyKey: `approve:${requestId}`
  },
  requestedAt, status: "pending"
})

export default showcase({
  id: "approvals",
  order: 106,
  title: "Needs attention",
  summary: "Gates, parked and failed runs in one place: approve, deny, resume, stop all.",
  flows: ["runs.attention", "approvals.open", "approval.approve", "approvals.list", "approval.deny", "runs.open", "runs.resume", "runs.list", "flow.run.stop-all"],
  run: async ({ page, app, backend }) => {
    const now = Date.now()
    const decided = new Map<string, string>()
    const cancelled = new Set<string>()
    let resumed = false
    const gates = [
      gate("run-land-68", "req-land", "Land PR #68 on main?", now - 120_000),
      gate("run-deps-4", "req-deps", "Upgrade effect to 4.0.0-rc.116?", now - 40_000)
    ]
    const summary = (runId: string, flowId: string, status: string) => ({
      runId, flowId, status, createdAt: now - 600_000, updatedAt: now - 30_000, turns: 4, calls: 9, callsFailed: status === "failed" ? 1 : 0,
      editsAttempted: 2, editsSucceeded: 2, inputTokens: 0, outputTokens: 0, verdict: status, diagnosis: status,
      ...(status === "waiting-approval" ? { waitingReason: "approval" } : status === "parked" ? { waitingReason: "quota" } : {})
    })
    const PARKED = "run-triage-31"
    const RUNS = [["run-land-68", "land"], ["run-deps-4", "upgrade-deps"], [PARKED, "triage-issue"], ["run-lint-9", "lint"]] as const
    const state = (id: string): string => cancelled.has(id) ? "cancelled" : id === "run-lint-9" ? "failed"
      : id === PARKED ? (resumed ? "running" : "parked")
      : decided.has(id === "run-land-68" ? "req-land" : "req-deps") ? (decided.get(id === "run-land-68" ? "req-land" : "req-deps") === "approve" ? "running" : "cancelled")
      : "waiting-approval"
    await backend.cloud({ capabilities: ["agent", "identity", "cloud", "cloud.pat"], workspaces: [runningBox(REPO)] })
    await backend.json("/api/workflow/provision", { status: "ready", repo: REPO, gatewayId: "gw-1" })
    await backend.route(url => url.pathname === "/api/workflow/rpc", route => {
      const call = route.request().postDataJSON() as { procedure: string; payload: { selector?: { _tag?: string }; target?: { requestId?: string }; decision?: string } }
      const ok = (payload: unknown) => route.fulfill({ json: { ok: true, payload } })
      if (call.procedure === "Approval.Submit") {
        decided.set(call.payload.target?.requestId ?? "", call.payload.decision ?? "")
        return ok({ decision: { _tag: "Accepted", receiptId: "a" } })
      }
      if (call.procedure === "Cancel") { cancelled.add((call.payload as { runId?: string }).runId ?? ""); return ok({ _tag: "Accepted", receiptId: "c" }) }
      if (call.procedure === "Resume") { resumed = true; return ok({ _tag: "Accepted", receiptId: "r" }) }
      if (call.procedure === "Projection.Snapshot") {
        const tag = call.payload.selector?._tag
        const runId = (call.payload.selector as { runId?: string } | undefined)?.runId
        const rows = tag === "approvals" ? gates.filter(row => !decided.has(row.requestId) && (runId === undefined || row.runId === runId))
          : tag === "workspace-runs" ? RUNS.map(([id, flow]) => summary(id, flow, state(id)))
          : tag === "run-summary" ? [summary(runId ?? PARKED, "triage-issue", state(runId ?? PARKED))]
          : []
        return ok({ cursor: { projection: tag, runId: null, value: 0 }, rows })
      }
      return ok({ _tag: "Accepted", receiptId: "ok" })
    })

    await app.open("/")
    await app.click(page.getByRole("button", { name: "Dismiss", exact: true }))
    await app.slash(`/runs.attention ${REPO}`)
    const attention = page.locator('[data-kind="run-list"]').last()
    await expect(attention).toContainText("run-lint-9")
    await app.closeComposer()
    await app.show(attention)
    await app.beat(500)

    // One run's gate, opened from the attention row, is decided on its own card.
    await app.click(attention.getByRole("button", { name: "Answer" }).first())
    const approval = page.locator('[data-kind="approval"]').last()
    await expect(approval).toContainText("Land PR #68")
    await app.show(approval)
    await app.beat(500)
    await app.click(approval.getByRole("button", { name: /approve/i }))
    await app.saw("approval.approve", () => expect.poll(() => decided.get("req-land")).toBe("approve"))
    await app.beat(500)

    await app.slash(`/approvals.list ${REPO}`)
    const inbox = page.locator('[data-kind="approvals-inbox"]').last()
    await expect(inbox.getByTestId("approvals-inbox-count")).toHaveText("1 approval pending")
    await app.closeComposer()
    await app.show(inbox)
    await app.beat(500)
    const deps = inbox.locator(".sui-approval-question", { hasText: "Upgrade effect" }).locator("xpath=ancestor::*[.//button][1]")
    await app.click(deps.getByRole("button", { name: /deny/i }))
    await app.saw("approval.deny", () => expect.poll(() => decided.get("req-deps")).toBe("deny"))
    await expect(inbox).toContainText("Denied")
    // Decided rows leave the count and keep their question (#1938).
    await expect(inbox.getByTestId("approvals-inbox-count")).toHaveText("0 approvals pending")
    await expect(inbox.locator(".sui-approval-question", { hasText: "Upgrade effect" })).toBeVisible()
    await app.beat(500)

    // The run parked on provider quota resumes; Stop all ends every live run.
    await app.show(attention)
    await app.click(attention.getByTestId(`runs-open-${PARKED}`))
    const parked = page.getByTestId(`card-${boxRunCardId(REPO, PARKED)}`)
    await app.show(parked)
    await app.click(parked.getByTestId(`flow-run-resume-${PARKED}`))
    await expect(parked).toContainText("Running", { timeout: 10_000 })
    await app.beat(500)
    await app.show(attention)
    await app.click(attention.getByRole("button", { name: "All runs" }))
    const all = page.locator('[data-kind="run-list"]').last()
    await expect(all.getByTestId("run-list-stop-all")).toBeVisible()
    await app.show(all)
    await app.click(all.getByTestId("run-list-stop-all"))
    await expect.poll(() => cancelled.has(PARKED), { timeout: 10_000 }).toBe(true)
    await expect(parked.getByTestId(`run-outcome-${PARKED}`)).toHaveAttribute("data-phase", "cancelled", { timeout: 10_000 })
    await app.show(parked)
  }
})
