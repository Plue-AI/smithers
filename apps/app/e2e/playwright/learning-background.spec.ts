import { expect, test } from "./browserTest"
import { installCloudFixture } from "./cloudFixture"
import { installFixture } from "../../src/mainview/state/seams/InstallFixtures.test-support"
import { fillComposer } from "./composer"

// Real Home Container -> card action -> typed command -> durable HTTP seam.
// Literal HTTP/socket responses qualify browser dispatch, not machine isolation.
test("Home Learning Retry stays usable through launch and completion; Dismiss survives reload", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route("**/api/user", route => route.fulfill({ json: { id: 1, username: "maya", is_admin: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/todos", route => route.fulfill({ json: [] }))
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: [] } }))
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: {} }))
  const id = "00000000-0000-4000-8000-000000000007"
  let state = "failed", dismissed = false, posts = 0, retryFailed = false
  const retryKeys: string[] = []
  let launch!: () => void
  const pending = new Promise<void>(resolve => { launch = resolve })
  let finishDismiss!: () => void
  const dismissPending = new Promise<void>(resolve => { finishDismiss = resolve })
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw))
    if (frame.t !== "sub") return
    if (frame.topic !== "home") { socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" })); return }
    socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: 1, data: {
      repository: "owner/repo", main: { sha: "1234567890abcdef1234567890abcdef12345678", title: "Learning door", last_success_at: "2026-10-08T00:00:00Z", health: "fresh" },
      attention: [], items: [], counts: { queued: 0, starting: 0, working: 0, needs_you: 0, paused: 0, failed: 0, in_review: 0, merged: 0, dropped: 0 },
      merged_since_last_look: [], machines: { in_use: 0, capacity: 3, slots: [] },
      background_runs: dismissed ? [] : [{ id, title: "Learning · T7", state: "failed", actions: [{ tag: "background.retry", label: "Retry" }, { tag: "background.dismiss", label: "Dismiss" }] }]
    } }))
  }))
  await page.route(`**/api/runs/${id}`, async route => {
    posts++
    const { op } = route.request().postDataJSON()
    if (op === "retry") {
      retryKeys.push(route.request().headers()["idempotency-key"])
      if (!retryFailed) {
        retryFailed = true
        await route.fulfill({ status: 503, json: { code: "background_retry_unavailable", class: "infra", message: "Isolated Retry unavailable" } })
        return
      }
      await pending; state = "running"
      await route.fulfill({ status: 202, json: { state: "accepted", run_id: id } })
    }
    else { dismissed = true; await dismissPending; await route.fulfill({ json: { state: "dismissed", run_id: id } }) }
  })
  await page.route(`**/api/runs/${id}/background-status`, route => route.fulfill({ json: { state, run_id: id } }))
  await page.goto("/")
  await fillComposer(page, "/stack"); await page.keyboard.press("Enter")
  const home = page.locator(".home").first()
  await expect(home).toContainText("Learning · T7")
  await home.getByRole("button", { name: "Retry", exact: true }).last().click()
  await expect.poll(() => posts).toBe(1)
  await expect(page.getByText("Run action failed", { exact: true }).last()).toBeVisible()
  await expect(home).toContainText("Learning · T7")
  await home.getByRole("button", { name: "Retry", exact: true }).last().click()
  await expect.poll(() => posts).toBe(2)
  // Repeated input during an unresolved launch must share the durable request.
  await home.getByRole("button", { name: "Retry", exact: true }).last().click()
  await fillComposer(page, "Keep chatting")
  await expect(page.getByTestId("composer-input")).toHaveValue("Keep chatting")
  launch()
  await expect(page.getByText("Retrying run", { exact: true })).toBeVisible()
  state = "success"
  await expect(page.getByText("Run completed", { exact: true })).toBeVisible()
  await home.getByRole("button", { name: "Dismiss", exact: true }).press("Enter")
  await expect.poll(() => dismissed).toBe(true)
  await expect(page.getByText("Dismissing run", { exact: true })).toBeVisible()
  finishDismiss()
  // Reload after the client has persisted the receipt.
  await expect(page.getByText("Dismissed", { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.locator(".home").first()).not.toContainText("Learning · T7")
  expect(posts).toBe(3)
  expect(retryKeys).toHaveLength(2)
  expect(retryKeys[0]).toMatch(/^[a-f0-9-]{36}$/)
  expect(retryKeys[1]).toBe(retryKeys[0])
})
