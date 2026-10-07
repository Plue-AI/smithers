import { expect, test } from "../browserTest"
import { installCloudFixture } from "../cloudFixture"
import { say } from "./j1-fixtures"
import historyFixture from "../../../src/mainview/state/testdata/earlier-history.json"

// UI projection; the authenticated packaged-host and tab-close rehearsals run
// in compose/working_together_conversation_integration_test.go.
test("C-APP-04: the composer admits host prompts and Earlier remains read-only", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["install", "identity", "agent"] })
  const entries: unknown[] = []
  let admissionCount = 0
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries } }))
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: { queue: [] } }))
  await page.route("**/api/conversations/main/prompt", async route => {
    expect(route.request().postDataJSON()).toMatchObject({ prompt: "Show the repository summary", idempotencyKey: expect.any(String) })
    admissionCount++
    entries.push({ id: "summary", author: 1, authorLogin: "scoped-user", runId: "summary-run", prompt: "Show the repository summary", state: "completed", frames: [
      { runId: "summary-run", type: "delta", kind: "text", text: "Repository summary." }, { runId: "summary-run", type: "done", reason: "stop" }
    ] })
    await route.fulfill({ status: 202, json: { turnId: "summary", terminal: false } })
  })
  await page.route("**/api/branches?*", route => route.fulfill({ json: [] }))
  await page.route("**/api/agent/conversations", route => route.fulfill({ json: historyFixture.index }))
  await page.route("**/api/agent/conversations/replay", route => route.fulfill({ json: historyFixture.replay }))
  const legacyWrites: string[] = []
  page.on("request", request => { if (request.method() === "POST" && /\/api\/(agent|chat)\/turn/.test(request.url())) legacyWrites.push(request.url()) })
  await page.goto("/")
  await say(page, "Show the repository summary")
  await expect(page.getByTestId("transcript").getByText("Repository summary.", { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByTestId("transcript").getByText("Repository summary.", { exact: true })).toBeVisible()
  await say(page, "/branches")
  await page.locator('[data-node="earlier"]').press("Enter")
  const earlier = page.getByRole("region", { name: "Earlier", exact: true })
  await earlier.getByRole("button", { name: "Legacy journal question", exact: true }).press("Enter")
  await expect(earlier).toContainText("Archived journal greeting")
  await expect(earlier.locator(".archive-entries button")).toHaveCount(0)
  expect(admissionCount).toBe(1)
  expect(legacyWrites).toEqual([])
})
