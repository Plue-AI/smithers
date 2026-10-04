import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of C-UI-13; its unit/CLI acceptance evidence remains separate.
// Written before implementation: mvp.md §6, §8; lands with T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-16, T-APP-15, T-FLW-07, T-FLW-08, T-UI-14
test("C-UI-13: Card doors reach the replacement Views", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6, §8; lands with T-APP-01, T-APP-02, T-APP-03, T-APP-04, T-APP-05, T-APP-06, T-APP-07, T-APP-16, T-APP-15, T-FLW-07, T-FLW-08, T-UI-14")
  // Required seed: every wired card and its pending wiring fixtures. Static
  // reachability and legacy-file deletion remain the unit check's responsibility.
  await owner(page)
  await page.goto("/")
  for (const [line, copy] of [
    ["/stack", "Upgrade Stripe to v15"], ["/todo T8", "Upgrade Stripe to v15"],
    ["/branch retry-webhooks", "retry-webhooks"], ["/flow todo", "todo"],
    ["/wiki", "Wiki"], ["/settings", "This Mac"], ["/members", "Members"],
    ["/help", "Commands"], ["/agent implementer", "Instructions"]
  ]) {
    await say(page, line!)
    const card = page.locator(".smithers-card").last()
    await expect(card).toBeVisible()
    await expect(card).toContainText(copy!)
    await expect(card).not.toContainText("Set up a job")
  }
  await say(page, "Merge T8")
  await expect(page.getByText("Review & merge", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Merged T8", { exact: true })).toHaveCount(0)
})

// SetupView already mounts through the install seam on first paint.
test("C-UI-13: Setup View mounts from the install fixture", async ({ page }) => {
  await page.route("**/api/install", route => route.fulfill({ json: {
    address: { listen: "mac", bind: "127.0.0.1", origins: ["http://localhost:4000"] },
    steps: ["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"]
      .map(id => ({ id, state: "pending" })),
    this_mac: { memory_gb: 64, disk_free_gb: 200, capacity: 4 },
    github: { signed_in: false, app_installed: false },
    models: [
      { role: "fast", provider: "Cerebras", key: "none" },
      { role: "coding", provider: "Anthropic", key: "none" },
      { role: "jev", provider: "Vercel", key: "none" }
    ], chatgpt: false, capacity: 4
  } }))
  await page.goto("/")
  const setup = page.getByRole("region", { name: "Set up Smithers" })
  await expect(setup).toBeVisible()
  await expect(setup.getByRole("button", { name: "Address", exact: true })).toBeEnabled()
  await expect(setup.getByText("64 GB · 200 GB free", { exact: true })).toBeVisible()
  await expect(setup).not.toContainText("Set up a job")
  await page.reload()
  await expect(page.getByRole("region", { name: "Set up Smithers" })).toBeVisible()
})
