import { expect, test } from "./browserTest"
import { queryDatabase, trackDatabaseWorker } from "./databaseProbe"
import { installCloudFixture } from "./cloudFixture"

// Initial sync health through the app's real HTTP seam and card dispatch.
// Reference-host freshness and force-push checks remain separate receipts.
test("install Home preserves health before the first successful GitHub sync", async ({ page }) => {
  await trackDatabaseWorker(page)
  await installCloudFixture(page, { capabilities: ["agent", "identity", "install"] })
  await page.route(url => url.pathname === "/api/user" || url.pathname === "/api/auth/session", route => route.fulfill({ json: { id: 1, username: "maya", is_admin: false } }))
  await page.route("**/api/todos", route => route.fulfill({ json: [] }))
  await page.route("**/api/install", route => route.fulfill({ json: {
    steps: ["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"].map(id => ({ id, state: "done" })),
    capacity: 2, this_mac: { capacity: 2, memory_gb: 16, disk_free_gb: 100 },
    github: { app_installed: true, signed_in: true, owner: "maya", squash_allowed: true },
    repository: { owner: "acme", name: "api" }, models: [], chatgpt: false,
    address: { bind: "127.0.0.1:4000", origins: ["http://127.0.0.1:4000"], listen: "mac" }
  } }))
  let state = "stale"
  let retries = 0
  const pause = new Date(Date.now() + 60_000).toISOString()
  await page.route("**/api/github/sync", route => {
    if (route.request().method() === "POST") {
      retries++
      return route.fulfill({ status: 202, json: { state: "accepted" } })
    }
    return route.fulfill({ json: { state, last_success_at: null, ...(state === "limited" ? { retry_at: pause } : {}) } })
  })
  await page.goto("/")
  const home = page.locator(".home").first()
  await expect(home.locator(".sync")).toHaveAttribute("data-health", "stale")
  await expect(home.locator(".sync")).not.toContainText("synced")
  await home.getByRole("button", { name: "Retry", exact: true }).press("Enter")
  await expect.poll(() => retries).toBe(1)
  await expect(page.getByRole("button", { name: "Confirm", exact: true })).toHaveCount(0)
  // Counting the POST proves dispatch, not that its admission receipt survived reload.
  await expect.poll(async () => {
    const rows = await queryDatabase(page, "SELECT value FROM smithers_collection_rows WHERE collection_id = 'app-sessions'") as { value: string }[]
    return rows.some(row => JSON.parse(row.value).githubSyncRequest?.phase === "running")
  }).toBe(true)
  state = "limited"
  await page.reload()
  await expect(home.locator(".sync")).toHaveAttribute("data-health", "limited")
  await expect(home.locator(".sync")).toContainText(pause)
  await expect(home.locator(".sync")).not.toContainText("synced")
  expect(retries).toBe(1)
})
