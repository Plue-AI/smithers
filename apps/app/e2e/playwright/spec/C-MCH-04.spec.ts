import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"
import { installFixture } from "../../../src/mainview/state/seams/InstallFixtures.test-support"

// Exercises the real InstallSeam and Settings Container with a persisted HTTP
// projection fixture. Production router, bundle and two-host calibration receipts
// are separate; this browser test alone is not a C-MCH-04 qualification receipt.
test("C-MCH-04: Owner capacity persists below the detected maximum", async ({ page }) => {
  await owner(page)
  const model = installFixture()
  model.this_mac = { memory_gb: 32, perf_cores: 10, disk_free_gb: 400, capacity: 3 }
  model.capacity = 3
  const writes: number[] = []
  await page.route("**/api/install", async route => {
    if (route.request().method() === "PUT") {
      const { capacity } = route.request().postDataJSON() as { capacity: number }
      expect(capacity).toBeGreaterThanOrEqual(1)
      expect(capacity).toBeLessThanOrEqual(3)
      writes.push(capacity)
      model.capacity = capacity
    }
    await route.fulfill({ json: model })
  })
  await page.goto("/")
  await say(page, "/settings")
  const settings = page.getByRole("region", { name: "Settings", exact: true }).last()
  const machines = settings.locator('[data-flow="settings.capacity"] output')
  await expect(settings).toContainText("32 GB · 400 GB free")
  await expect(machines).toHaveText("3")
  await expect(settings.getByRole("button", { name: "More Machines", exact: true })).toBeDisabled()
  await settings.getByRole("button", { name: "Fewer Machines", exact: true }).press("Enter")
  await expect(machines).toHaveText("2")
  await settings.getByRole("button", { name: "Fewer Machines", exact: true }).press("Enter")
  await expect(machines).toHaveText("1")
  await expect(settings.getByRole("button", { name: "Fewer Machines", exact: true })).toBeDisabled()
  await page.reload()
  await say(page, "/settings")
  await expect(machines).toHaveText("1")
  await settings.getByRole("button", { name: "More Machines", exact: true }).press("Enter")
  await expect(machines).toHaveText("2")
  await settings.getByRole("button", { name: "More Machines", exact: true }).press("Enter")
  await expect(machines).toHaveText("3")
  await expect(settings.getByRole("button", { name: "More Machines", exact: true })).toBeDisabled()
  expect(writes).toEqual([2, 1, 2, 3])
})
