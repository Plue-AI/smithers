import { controlTabKey, expect, test, type Page } from "./browserTest"
import { installCloudFixture } from "./cloudFixture"

const repo = "smithersai/smithers"
const gate = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve }); return { promise, release } }
const send = async (page: Page, text: string) => {
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.getByRole("button", { name: "Chat", exact: true }).click()
  await input.fill(text)
  await page.getByTestId("composer-send").click()
  await expect(input).toHaveValue("")
}

test("flow launch leaves Chat usable through preparation, launch, reload and remote completion", async ({ page }) => {
  const preparation = gate(), launch = gate()
  let ready = false, complete = false
  const calls: Array<{ procedure: string; payload: { idempotencyKey?: string; selector?: { _tag: string } } }> = []
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat"] })
  await page.route("**/api/workflow/provision", async route => {
    await preparation.promise
    await route.fulfill({ status: ready ? 200 : 503, headers: { "Retry-After": "0" }, json: ready ? { status: "ready" } : { code: "workspace_starting", message: "Waking up" } })
  })
  await page.route("**/api/workflow/rpc", async route => {
    const call = route.request().postDataJSON()
    calls.push(call)
    let payload: unknown = {}
    if (call.procedure === "Plan") payload = { planId: "plan-background", digest: "digest", envelope: { capabilities: [], flows: [], budget: {} } }
    if (call.procedure === "Run") { await launch.promise; payload = { runId: "background-run" } }
    if (call.procedure === "Projection.Snapshot") payload = { rows: call.payload.selector._tag === "run-summary" ? [{
      runId: "background-run", flowId: "review-pr", status: complete ? "completed" : "running", createdAt: 1, updatedAt: complete ? 3 : 2,
      turns: 1, calls: 1, callsFailed: 0, editsAttempted: 0, editsSucceeded: 0, inputTokens: 1, outputTokens: 1, verdict: complete ? "Done" : "Running", diagnosis: "Recorded status"
    }] : [] }
    await route.fulfill({ json: { ok: true, payload } })
  })
  await page.goto("/")
  await expect(page.getByTestId("first-run-actions")).toBeVisible()
  await send(page, `/flow.run review-pr ${repo} {"args":"inspect"}`)
  const card = page.locator('[data-kind="run-trace"]')
  await expect(card).toContainText("Requested")
  const id = await card.getAttribute("data-testid")
  const toast = page.locator('[data-toast-status="running"]').filter({ hasText: "review-pr" })
  await expect(toast).toBeVisible()
  await send(page, `/flow.run review-pr ${repo} {"args":"inspect"}`)
  await expect(card).toHaveCount(1)
  const input = page.getByTestId("composer-input")
  if (!await input.isVisible()) await page.getByRole("button", { name: "Chat", exact: true }).click()
  await input.fill("Chat stays usable")
  await expect(input).toBeEditable()
  await expect(input).toHaveValue("Chat stays usable")
  expect(calls.filter(call => call.procedure === "Run")).toHaveLength(0)
  preparation.release()
  await expect(toast).toBeVisible()
  ready = true
  await expect.poll(() => calls.filter(call => call.procedure === "Run").length).toBe(1)
  await expect(card).toContainText("Requested")
  await expect(toast).toBeVisible()
  await send(page, `/flow.run review-pr ${repo} {"args":"inspect"}`)
  await expect(card).toHaveCount(1)
  launch.release()
  await expect(card).toHaveAttribute("data-run-id", "background-run")
  await expect(card).toHaveAttribute("data-testid", id!)
  await expect(toast).toBeVisible()
  const snapshotsBeforeDuplicate = calls.filter(call => call.procedure === "Projection.Snapshot").length
  await send(page, `/flow.run review-pr ${repo} {"args":"inspect"}`)
  // Let the running request complete another projection cycle before checking deduplication.
  await expect.poll(() => calls.filter(call => call.procedure === "Projection.Snapshot").length, { timeout: 15_000 }).toBeGreaterThan(snapshotsBeforeDuplicate)
  expect(calls.filter(call => call.procedure === "Run")).toHaveLength(1)
  await page.reload()
  await expect(card).toHaveAttribute("data-run-id", "background-run")
  await expect(toast).toBeVisible()
  expect(calls.filter(call => call.procedure === "Run")).toHaveLength(1)
  complete = true
  const completed = page.locator('[data-toast-status="ok"]').filter({ hasText: "review-pr" })
  await expect(completed).toBeVisible({ timeout: 15_000 })
  await expect(completed.locator(".toast-title")).toContainText(/\bDone\b/)
  await expect(card.getByText("Finished.", { exact: true })).toBeVisible()
})

test("a launch refusal survives reload and its keyboard Retry reuses the request", async ({ page }) => {
  let refuse = true
  const refusal = gate()
  const plans: string[] = []
  await installCloudFixture(page, { capabilities: ["agent", "identity", "cloud", "cloud.pat"] })
  await page.route("**/api/workflow/provision", route => route.fulfill({ json: { status: "ready" } }))
  await page.route("**/api/workflow/rpc", async route => {
    const call = route.request().postDataJSON()
    if (call.procedure === "Plan") {
      plans.push(call.payload.idempotencyKey)
      if (refuse) await refusal.promise
      return route.fulfill({ json: refuse ? { ok: false, error: { message: "Provider unavailable", detail: { code: "provider_unavailable" } } }
        : { ok: true, payload: { planId: "retry-plan", digest: "digest", envelope: {} } } })
    }
    return route.fulfill({ json: { ok: true, payload: call.procedure === "Run" ? { runId: "retried-run" } : { rows: [] } } })
  })
  await page.goto("/")
  await expect(page.getByTestId("first-run-actions")).toBeVisible()
  await send(page, `/flow.run review-pr ${repo}`)
  const card = page.locator('[data-kind="run-trace"]')
  await expect(page.locator('[data-toast-status="running"]').filter({ hasText: "review-pr" })).toBeVisible()
  refusal.release()
  await expect(page.locator('[data-toast-status="failed"]').filter({ hasText: "review-pr" })).toBeVisible()
  await expect(card.getByRole("alert")).toHaveText("Provider unavailable")
  await page.reload()
  await expect(card.getByRole("alert")).toHaveText("Provider unavailable")
  expect(plans).toHaveLength(1)
  refuse = false
  const retry = card.getByRole("button", { name: "Retry", exact: true })
  for (let stop = 0; stop < 50 && !await retry.evaluate(button => button === document.activeElement); stop++) await page.keyboard.press(controlTabKey(page))
  await expect(retry).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(card).toHaveAttribute("data-run-id", "retried-run")
  expect(plans).toHaveLength(2)
  expect(plans[1]).toBe(plans[0])
})
