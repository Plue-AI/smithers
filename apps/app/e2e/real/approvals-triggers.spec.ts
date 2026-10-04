import type { Page } from "@playwright/test"
import { authenticatedTest } from "./auth-permissions/profile"
import { scenario } from "./coverage/types"
import { bootProductionRepository, cloudRepoPath, PRODUCTION_REPO } from "./repositories-github/production"
import { appReady, awaitBoot, closeComposer, command, expect, realApi, reloadApp, test } from "./support"

const transcript = (page: Page) => page.getByTestId("transcript")

const bootLocal = async (page: Page): Promise<void> => {
  const startedAt = performance.now()
  await page.goto("/smithersai/smithers")
  await awaitBoot(page, "navigate", startedAt)
  await appReady(page)
}

const workflowPaths = (requests: Array<{ method: string; path: string }>) =>
  requests.filter(({ path }) => path.startsWith("/api/workflow/"))

test("signed-out approvals park behind the real sign-in door and survive reload without a workflow read", scenario("approvals.signed-out-deferred-reload", {
  capabilities: ["identity"],
  coverage: [
    "action:approvals.list", "action:auth.prompt", "host:local", "host:production", "path:permission", "path:persistence",
    "door:slash", "door:user-only", "dimension:approval-auth-boundary", "dimension:reload",
    "evidence:session-and-network-observation"
  ],
  description: "The real signed-out browser cannot enumerate workspace approval state, keeps the protected request's sign-in step after reload, and emits no workflow request."
}), async ({ page, request }) => {
  const requests: Array<{ method: string; path: string }> = []
  page.on("request", (entry) => requests.push({ method: entry.method(), path: new URL(entry.url()).pathname }))
  await bootLocal(page)
  expect((await realApi(page, request, "GET", "/api/user")).status()).toBe(401)

  await command(page, `/approvals.list ${PRODUCTION_REPO}`)
  await expect(page.locator('[data-flow="sign-in"]:visible').last()).toBeVisible()
  await expect(transcript(page)).toContainText(/Sign in with GitHub to continue\./)
  expect(workflowPaths(requests)).toEqual([])

  await reloadApp(page)
  await expect(page.locator('[data-flow="sign-in"]:visible').last()).toBeVisible()
  await expect(page.locator('.smithers-card[data-kind="approvals-inbox"]')).toHaveCount(0)
  expect(workflowPaths(requests)).toEqual([])
  expect((await realApi(page, request, "GET", "/api/user")).status()).toBe(401)
})

test("signed-out dispatcher reads the public mirror, renders one real card, and never invents live trigger rows", scenario("triggers.signed-out-public-declaration", {
  capabilities: [],
  coverage: [
    "action:triggers.list", "host:local", "host:production", "path:success", "door:slash", "door:button",
    "dimension:public-declaration", "dimension:no-live-signed-out", "dimension:network-read",
    "evidence:mirror-response-and-card-readback"
  ],
  description: "The dispatcher reads the repository's actual public factory projection and shows its declared state to an anonymous browser while omitting the signed-in box projection."
}), async ({ page }) => {
  const mirrorReads: Array<{ method: string; path: string; status: number }> = []
  const workflowReads: Array<{ method: string; path: string }> = []
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (url.pathname.includes("/contents/.smithers/factory.json")) mirrorReads.push({ method: response.request().method(), path: url.pathname, status: response.status() })
    if (url.pathname.startsWith("/api/workflow/")) workflowReads.push({ method: response.request().method(), path: url.pathname })
  })
  await bootLocal(page)
  await command(page, "/triggers.list smithersai/smithers")
  await closeComposer(page)
  const card = page.locator('.smithers-card[data-kind="trigger-list"]').last()
  await expect(card).toBeVisible()
  await expect(card).toHaveAttribute("data-testid", "card-trigger-list-smithersai/smithers")
  expect(mirrorReads.length).toBeGreaterThan(0)
  expect(mirrorReads.every(({ method }) => method === "GET")).toBe(true)
  expect(workflowReads).toEqual([])
  await expect(card.locator('[data-testid="trigger-live"]')).toHaveCount(0)
  await expect(card.locator('[data-source="box"]')).toHaveCount(0)
  await reloadApp(page)
  await expect(page.locator('.smithers-card[data-kind="trigger-list"]').last()).toBeVisible()
})

authenticatedTest("production dispatcher and approvals are read from the authenticated canary workspace", scenario("production.triggers-approvals-readonly", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:triggers.list", "action:approvals.list", "host:production", "path:success", "path:persistence", "path:keyboard",
    "door:slash", "door:button", "dimension:authenticated-projection", "dimension:empty-state", "dimension:keyboard",
    "evidence:workflow-api-and-card-readback"
  ],
  description: "An authenticated production browser reads both workspace projections, verifies empty-state truth from the real canary workspace, and checks the dispatcher card's keyboard activation."
}), async ({ page, request }) => {
  authenticatedTest.setTimeout(240_000)
  await bootProductionRepository(page)
  const reads: Array<{ method: string; path: string; status: number }> = []
  let approvalsRequest: Record<string, unknown> | undefined
  page.on("response", (response) => {
    const url = new URL(response.url())
    if (url.pathname === "/api/workflow/rpc") {
      const body = response.request().postDataJSON()
      if (body?.procedure === "Projection.Snapshot" && body?.payload?.selector?._tag === "approvals") approvalsRequest = body
    }
    if (url.pathname.startsWith("/api/workflow/") || url.pathname.endsWith("/repository-jobs") || url.pathname.includes("/contents/.smithers/factory.json")) {
      reads.push({ method: response.request().method(), path: url.pathname, status: response.status() })
    }
  })

  await command(page, `/triggers.list ${PRODUCTION_REPO}`)
  await closeComposer(page)
  const triggers = page.locator('.smithers-card[data-kind="trigger-list"]').last()
  await expect(triggers).toBeVisible()
  await expect(triggers.getByTestId("trigger-register")).toBeVisible()
  await expect.poll(() => reads.some(({ path }) => path === cloudRepoPath(PRODUCTION_REPO, "/repository-jobs"))).toBe(true)

  await command(page, `/approvals.list ${PRODUCTION_REPO}`)
  await closeComposer(page)
  const approvals = page.locator('.smithers-card[data-kind="approvals-inbox"]').last()
  await expect(approvals).toBeVisible({ timeout: 180_000 })
  await expect(approvals).toContainText(new RegExp(`No approvals are pending on ${PRODUCTION_REPO.replace("/", "\\/")}`))
  await expect.poll(() => approvalsRequest).toBeDefined()
  // Every relayed call names its box.
  expect(typeof approvalsRequest!.workspaceId, "the approvals read must name its box").toBe("string")

  const approvalApi = await realApi(page, request, "POST", "/api/workflow/rpc", approvalsRequest!)
  expect(approvalApi.status()).toBe(200)
  const body = await approvalApi.json() as { ok?: unknown; payload?: { rows?: unknown } }
  expect(body.ok).toBe(true)
  expect(body.payload?.rows).toEqual([])
  await reloadApp(page)
  await expect(page.locator('.smithers-card[data-kind="approvals-inbox"]').last()).toBeVisible()
})

authenticatedTest("production Register a rule opens the schedule form by keyboard and cancelling writes nothing", scenario("production.triggers-register-form", {
  capabilities: ["identity", "cloud"],
  coverage: [
    "action:triggers.list", "action:triggers.register", "host:production", "path:success", "path:keyboard",
    "door:slash", "door:button", "dimension:register-form", "dimension:keyboard", "dimension:no-write",
    "evidence:form-readback-and-network-observation"
  ],
  description: "The authenticated production dispatcher's Register button opens the triggers.register form by keyboard; Schedule stays disabled until a flow is named, and Cancel sends no write."
}), async ({ page }) => {
  await bootProductionRepository(page)
  /* Relayed reads are POSTs too; a write is anything else sent to the relay or the repository-job routes. */
  const reads = new Set(["List", "Projection.Snapshot"])
  const writes: Array<{ method: string; path: string; procedure?: string }> = []
  page.on("request", (request) => {
    const url = new URL(request.url())
    if (request.method() === "GET") return
    if (url.pathname === "/api/workflow/rpc") {
      const procedure = (request.postDataJSON() as { procedure?: string } | null)?.procedure
      if (procedure === undefined || !reads.has(procedure)) writes.push({ method: request.method(), path: url.pathname, ...(procedure === undefined ? {} : { procedure }) })
    } else if (url.pathname.startsWith("/api/workflow/") || url.pathname.includes("/repository-jobs")) writes.push({ method: request.method(), path: url.pathname })
  })
  await command(page, `/triggers.list ${PRODUCTION_REPO}`)
  await closeComposer(page)
  const card = page.locator('.smithers-card[data-kind="trigger-list"]').last()
  await expect(card).toBeVisible()
  const register = card.getByTestId("trigger-register")
  await register.focus()
  await expect(register).toBeFocused()
  await register.press("Enter")
  const form = page.locator('form.flow-form[data-flow-name="triggers.register"]').last()
  await expect(form).toBeVisible()
  await expect(form.getByTestId("flow-form-flow")).toBeVisible()
  await expect(form.getByTestId("flow-form-submit")).toHaveText("Schedule")
  await expect(form.getByTestId("flow-form-submit")).toBeDisabled()
  await form.getByTestId("flow-form-flow").fill("nightly-lint")
  await expect(form.getByTestId("flow-form-submit")).toBeEnabled()
  await form.getByTestId("flow-form-cancel").click()
  await expect(form).toHaveCount(0)
  expect(writes).toEqual([])
})
