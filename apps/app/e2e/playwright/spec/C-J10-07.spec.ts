import { expect, test } from "../browserTest"
import { say, mergeOwner } from "./j1-fixtures"

// Browser contract over served Home snapshots and the production reset flow.
// github_main_reset_acceptance_test.go separately proves the composed backend.
test("C-J10-07: main rewrite waits for the owner and refuses stale confirmation", async ({ page }) => {
  await mergeOwner(page)
  await page.route("**/api/auth/session", route => route.fulfill({ json: { id: 1, username: "benortiz", is_admin: false } }))
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: [] } }))
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: {} }))
  await page.route("**/api/todos", route => route.fulfill({ json: [] }))
  await page.route("**/api/github/sync", route => route.fulfill({ json: { state: "fresh", last_success_at: new Date().toISOString() } }))
  const old = "1".repeat(40), first = "2".repeat(40), latest = "3".repeat(40)
  let target = first, settled = false
  const publishers: Array<() => void> = [], writes: unknown[] = []
  await page.routeWebSocket("**/api/live", socket => socket.onMessage(raw => {
    const frame = JSON.parse(String(raw))
    if (frame.t !== "sub") return
    if (frame.topic !== "home") { socket.send(JSON.stringify({ t: "err", id: frame.id, code: "unsupported" })); return }
    let cursor = 0
    const publish = () => socket.send(JSON.stringify({ t: "snap", id: frame.id, cursor: ++cursor, data: {
      repository: "smithers-mvp-canary/node",
      main: { sha: settled ? latest : old, title: "main", health: "fresh", last_success_at: new Date().toISOString() },
      attention: settled ? [] : [{ id: "force-one", kind: "force_push", text: "main rewritten on GitHub",
        actions: [{ tag: "main.reset-to-github", label: "Reset to GitHub main", args: { id: "force-one", old, new: target } }] }],
      items: [], counts: { queued: 0, starting: 0, working: 0, needs_you: 0, paused: 0, failed: 0, in_review: 0, merged: 0, dropped: 0 },
      merged_since_last_look: [], machines: { in_use: 0, capacity: 1, slots: [] }, background_runs: []
    } }))
    publishers.push(publish); publish()
  }))
  await page.route("**/api/stack/attention/force-one", async route => {
    expect(route.request().method()).toBe("POST")
    expect(route.request().headers()["idempotency-key"]).toBeTruthy()
    writes.push(route.request().postDataJSON())
    if (writes.length === 1) {
      target = latest
      await route.fulfill({ status: 409, json: { code: "stale_attention", class: "conflict", message: "Main changed" } })
    } else {
      settled = true
      await route.fulfill({ json: { state: "settled" } })
    }
    publishers.forEach(publish => publish())
  })
  await page.goto("/")
  await say(page, "/stack")
  const home = page.locator(".home").last()
  await expect(home.getByText("main rewritten on GitHub", { exact: true })).toBeVisible()
  expect(writes).toEqual([])
  const reset = home.getByRole("button", { name: "Reset to GitHub main", exact: true })
  await reset.press("Enter")
  await expect.poll(() => writes.length).toBe(1)
  expect(writes[0]).toEqual({ old, new: first })
  await expect(page.getByText("Main changed", { exact: true }).last()).toBeVisible()
  await expect(reset).toBeVisible()
  await reset.press("Enter")
  await expect.poll(() => writes.length).toBe(2)
  expect(writes[1]).toEqual({ old, new: latest })
  await expect(reset).toHaveCount(0)
  await expect(page.getByTestId("composer-input")).toBeEditable()
  await page.reload()
  await say(page, "/stack")
  await expect(page.getByText("main rewritten on GitHub", { exact: true })).toHaveCount(0)
  expect(writes).toHaveLength(2)
})
