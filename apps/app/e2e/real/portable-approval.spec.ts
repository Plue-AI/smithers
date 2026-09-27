import { randomUUID } from "node:crypto"
import type { APIRequestContext, Page } from "@playwright/test"
import { authenticatedTest } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { awaitBoot, expect, productUrl, realApi, reloadApp } from "./support/test"
import { runSlash } from "./issues/local"
import { finishFirstVisit } from "./support/first-visit"
import { pushMainFiles, runningWorkspace, withOwnedRepository } from "./portable/owned-repository"
import { readWorkspaceText } from "./run-inspection/seeded-flow"

authenticatedTest.setTimeout(300_000)

const approvalFlow = (marker: string): string => [
  "---",
  "description: Ask before writing an approval proof.",
  'capabilities: ["fs:read:**", "fs:write:**"]',
  "model: coding/implement",
  "budget:",
  "  tokens: 60000",
  "  milliseconds: 240000",
  "---",
  "",
  `Approval marker: ${marker}`,
  `First call ask with question "Approve the effect ${marker}?". Wait for the actual human decision.`,
  `Only when approved is true, write approval-effect.txt containing ${marker}. Never write that file after denial.`,
  `After either decision, write approval-result.json with marker ${JSON.stringify(marker)} and decision "approved" or "denied" matching the returned approved boolean. Finish.`,
  ""
].join("\n")

const decide = async (page: Page, request: APIRequestContext, decision: "approve" | "deny") => {
  await withOwnedRepository(page, request, async repo => {
    const marker = randomUUID()
    await pushMainFiles(page, request, repo, { "flows/approval-proof/flow.mdx": approvalFlow(marker) })
    await runningWorkspace(page, request, repo, async workspaceId => {
      const started = performance.now()
      await page.goto(productUrl(page, `/${repo.fullName}`), { waitUntil: "domcontentloaded" })
      await awaitBoot(page, "navigate", started)
      await finishFirstVisit(page)
      await runSlash(page, `/box.view ${workspaceId}`)
      await expect(page.getByTestId(`card-workspace-${workspaceId}`)).toBeVisible()
      const accepted = page.waitForResponse(response => response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/workflow/rpc" && response.request().postDataJSON()?.procedure === "Run")
      void accepted.catch(() => undefined)
      await runSlash(page, `/flow.run approval-proof ${repo.fullName} {}`)
      const launch = await accepted
      expect(launch.status()).toBe(200)
      const launched = await launch.json()
      expect(launched.ok).toBe(true)
      const runId = launched.payload?.runId
      expect(runId).toEqual(expect.any(String))
      const projection = async (tag: "approvals" | "run-summary") => {
        const response = await realApi(page, request, "POST", "/api/workflow/rpc", {
          repo: repo.fullName, workspaceId, procedure: "Projection.Snapshot", payload: { selector: { _tag: tag, runId } }
        })
        expect(response.status()).toBe(200)
        const body = await response.json()
        expect(body.ok).toBe(true)
        return body.payload.rows as Array<{ status: string; requestId?: string; payload?: { target?: { requestId?: string } } }>
      }
      await expect.poll(async () => (await projection("approvals")).filter(row => row.status === "pending").length,
        { timeout: 120_000 }).toBe(1)
      const pending = (await projection("approvals")).find(row => row.status === "pending")!
      expect(pending.requestId).toEqual(expect.any(String))
      const file = (path: string) => realApi(page, request, "GET", `${repo.path}/workspaces/${workspaceId}/files/content?path=${path}`)
      expect((await file("approval-effect.txt")).status()).toBe(404)
      expect((await file("approval-result.json")).status()).toBe(404)
      const card = page.locator('.smithers-card[data-kind="approval"]').filter({ hasText: marker })
      await expect(card).toBeVisible({ timeout: 60_000 })
      await reloadApp(page)
      await expect(card).toBeVisible()
      const submitted = page.waitForResponse(response => response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/api/workflow/rpc" && response.request().postDataJSON()?.procedure === "Approval.Submit")
      void submitted.catch(() => undefined)
      const button = card.getByRole("button", { name: decision === "approve" ? "Approve" : "Deny", exact: true })
      await button.focus()
      await expect(button).toBeFocused()
      await button.press("Enter")
      const response = await submitted
      expect(response.request().postDataJSON()).toMatchObject({
        repo: repo.fullName, workspaceId, payload: { decision, target: { runId, requestId: pending.requestId } }
      })
      expect(response.status()).toBe(200)
      expect(await response.json()).toMatchObject({ ok: true, payload: { decision: { _tag: "Accepted" } } })
      const recorded = decision === "approve" ? "approved" : "denied"
      await expect.poll(async () => (await projection("approvals")).find(row => row.requestId === pending.requestId)?.status,
        { timeout: 60_000 }).toBe(recorded)
      await expect.poll(async () => (await projection("run-summary"))[0]?.status,
        { timeout: 120_000 }).toBe("completed")
      expect(JSON.parse(await readWorkspaceText(page, request, repo.fullName, workspaceId, "approval-result.json")))
        .toEqual({ marker, decision: recorded })
      if (decision === "approve") expect(await readWorkspaceText(page, request, repo.fullName, workspaceId, "approval-effect.txt")).toContain(marker)
      else expect((await file("approval-effect.txt")).status()).toBe(404)
      await expect(card).toHaveAttribute("data-status", "acted")
      await expect(card).toContainText(decision === "approve" ? "Approved" : "Denied")
      await reloadApp(page)
      await expect(card).toHaveAttribute("data-status", "acted")
      await expect(card.getByRole("button", { name: /^(Approve|Deny)$/ })).toHaveCount(0)
      expect((await projection("approvals")).find(row => row.requestId === pending.requestId)?.status).toBe(recorded)
    })
  })
}

authenticatedTest("keyboard approval resumes a real parked box flow and persists its effect", scenario("approvals.product-approve", {
  capabilities: ["identity", "cloud"],
  coverage: ["action:approval.approve", "host:local", "host:production", "path:success", "path:persistence", "path:keyboard", "door:button", "door:user-only", "dimension:reload", "dimension:keyboard", "evidence:approval-receipt-terminal-run-and-box-file"]
}), async ({ page, request }) => decide(page, request, "approve"))

authenticatedTest("keyboard denial resumes a real parked box flow without performing its approved effect", scenario("approvals.product-deny", {
  capabilities: ["identity", "cloud"],
  coverage: ["action:approval.deny", "host:local", "host:production", "path:success", "path:persistence", "path:keyboard", "door:button", "door:user-only", "dimension:reload", "dimension:keyboard", "evidence:denial-receipt-terminal-run-and-absent-effect"]
}), async ({ page, request }) => decide(page, request, "deny"))
