import { expect, test } from "./browserTest"
import { owner, say } from "./spec/j1-fixtures"

test("/branches mounts the served tree inline and preserves its view on reload", async ({ page }) => {
  await owner(page)
  await page.route("**/api/branches?*", route => route.fulfill({ json: [
    { name: "retry", kind: "scratch", state: "awake", machine: { id: "b1" }, forked_from: { ref: "main" } },
    { name: "nested", kind: "scratch", state: "asleep", machine: { id: "b2" }, forked_from: { ref: "retry" } }
  ] }))
  await page.goto("/")
  await say(page, "/branches")
  const tree = page.getByRole("navigation", { name: "Branches", exact: true })
  await expect(tree).toBeVisible()
  await expect(tree.getByRole("button", { name: "Open retry", exact: true })).toBeVisible()
  await expect(tree.locator('[data-node="nested"]').locator("..")).toHaveAttribute("data-depth", "2")
  await expect(page.locator('.smithers-card[data-kind="branches"]')).toHaveCount(0)
  await tree.locator('[data-node="earlier"]').press("Enter")
  await expect(page.getByRole("region", { name: "Earlier", exact: true })).toContainText("Read-only")
  await expect(page.locator("[data-branch-navigation]")).toHaveAttribute("aria-busy", "false")
  await page.reload()
  await expect(tree).toBeVisible()
  await expect(page.getByRole("region", { name: "Earlier", exact: true })).toBeVisible()
})
