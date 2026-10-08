import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { installCloudFixture } from "../cloudFixture"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// Browser proof through the install HTTP seam, catalog, cardActions and Home.
// Composed backend tests separately qualify stream admission and persisted health.
test("C-J10-06: sync age and Retry stay honest while Chat remains usable", async ({ page }) => {
  await installCloudFixture(page, { capabilities: ["identity", "install"] })
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "canary-owner", is_admin: false } }))
  await page.route("**/api/members", route => route.fulfill({ json: {
    members: [{ login: "canary-owner", name: "Will", avatar_url: "https://example.com/owner.png", color_index: 0,
      role: "owner", needs_access: false, suspended: false, actions: [] }],
    access_url: "https://github.com/smithers-mvp-canary/node/settings/access"
  } }))
  await page.route("**/api/conversations/main", route => route.fulfill({ json: { id: "main", entries: [] } }))
  await page.route("**/api/conversations/main/view-state", route => route.fulfill({ json: { toasts_hidden: false, global_toasts_hidden: false } }))
  await page.route("**/api/install", route => route.fulfill({ json: installFixture() }))
  await page.route("**/api/todos", route => route.fulfill({ json: [] }))
  const base = Date.parse("2026-10-06T12:00:00Z")
  await page.clock.setFixedTime(base)
  let health: { state: string; last_success_at: string; cause?: string } = {
    state: "fresh", last_success_at: new Date(base - 40_000).toISOString()
  }
  let posts = 0, reads = 0, accepted = false
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  await page.route("**/api/github/sync", async route => {
    if (route.request().method() === "POST") {
      posts++
      expect(route.request().headers()["idempotency-key"]).toBeTruthy()
      await pending
      await route.fulfill({ status: 202, json: { state: "accepted" } })
      accepted = true
    } else {
      reads++
      await route.fulfill({ json: health })
    }
  })
  try {
    await page.goto("/")
    await say(page, "/help")
    await expect(page.getByText("Commands", { exact: true }).last()).toBeVisible()
    // Startup acquires a real browser writer lock before timers are virtualized.
    await page.clock.install({ time: base })
    await say(page, "/github")
    const sync = page.locator(".sync").last()
    await expect(sync).toHaveText("synced 40 s ago")
    await expect(sync).toHaveAttribute("data-health", "fresh")
    expect(posts).toBe(0)
    expect(reads).toBeGreaterThan(0)
    await page.clock.setFixedTime(base + 80_000)
    await page.clock.runFor(1100)
    await expect(sync).toHaveAttribute("data-health", "fresh")
    await page.clock.setFixedTime(base + 81_000)
    await page.clock.runFor(1100)
    await expect(sync).toHaveAttribute("data-health", "stale")
    await page.getByRole("button", { name: "Retry", exact: true }).last().press("Enter")
    await expect.poll(() => posts).toBe(1)
    await page.getByRole("button", { name: "Retry", exact: true }).last().press("Enter")
    await say(page, "/help")
    await expect(page.getByText("Commands", { exact: true }).last()).toBeVisible()
    await expect(page.getByTestId("composer-input")).toBeEditable()
    await expect(sync).toHaveAttribute("data-health", "stale")
    await expect(page.getByRole("button", { name: "Confirm", exact: true })).toHaveCount(0)
    // The shared progress stack intentionally debounces for 300 ms; advance the virtual clock.
    await page.clock.runFor(300)
    await expect(page.getByText("Syncing GitHub", { exact: true }).last()).toBeVisible()
    release()
    await expect.poll(() => accepted).toBe(true)
    await expect(sync).toHaveAttribute("data-health", "stale")
    await expect(page.getByText("Syncing GitHub", { exact: true }).last()).toBeVisible()
    health = { state: "fresh", last_success_at: new Date(base + 81_000).toISOString() }
    await page.clock.runFor(10_100)
    await expect(sync).toHaveAttribute("data-health", "fresh")
    expect(posts).toBe(1)
    await expect(page.getByText("Syncing GitHub", { exact: true })).toHaveCount(0)
    health = { ...health, state: "refused", cause: "not_installed" }
    await page.clock.runFor(10_100)
    await expect(sync).toHaveAttribute("data-health", "refused")
    await expect(sync).toContainText("GitHub App not installed")
    // A person can retry after restoring App access outside Smithers.
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveCount(1)
    await expect(page.getByRole("button", { name: "Retry", exact: true })).toHaveAttribute("data-flow", "github")
  } finally { release() }
})
