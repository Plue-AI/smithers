/*
 * A build target's approval row in the approvals inbox: it names the target
 * and revision, carries no run or request time, and decides like any gate.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { approvalActionId } from "../state/ApprovalReference"
import { ApprovalsInboxCardBody } from "./RunsCards"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

const REPO = "codeplanesmithers/smithers-demo"
const target = {
  runId: "plan:plan-7",
  requestId: "plan-7",
  title: "//images:push 177f95506bee",
  approval: { target: { _tag: "Plan" }, scope: "once", idempotencyKey: "approve:plan-7" },
  requestedAt: 0
}
const card = (approvals: Extract<Card, { kind: "approvals-inbox" }>["payload"]["approvals"]): Extract<Card, { kind: "approvals-inbox" }> => ({
  id: `approvals-inbox-${REPO}`,
  kind: "approvals-inbox",
  title: `Approvals — ${REPO}`,
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload: { repo: REPO, approvals }
})

test("a target row shows its target and revision with Approve and Deny, and no run", () => {
  const decisions: Array<{ id: string; decision: string }> = []
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => createRoot(host).render(<ApprovalsInboxCardBody card={card([target])} onDecideApproval={(id, decision) => decisions.push({ id, decision })} />))

  expect(host.querySelector(".sui-approval-question")?.textContent).toBe("//images:push 177f95506bee")
  expect(host.querySelector(".sui-approval-meta")).toBeNull()
  expect(host.textContent).not.toContain("run ")
  expect(host.querySelector("[data-testid='approvals-inbox-count']")?.textContent).toBe("1 approval pending")
  const buttons = [...host.querySelectorAll("button")].filter((button) => button.getAttribute("data-slot") === "confirmation-action")
  expect(buttons).toHaveLength(2)
  for (const button of buttons) (button as HTMLElement).click()
  const id = approvalActionId(`approvals-inbox-${REPO}`, target)
  expect(decisions).toEqual([{ id, decision: "approved" }, { id, decision: "denied" }])
})
