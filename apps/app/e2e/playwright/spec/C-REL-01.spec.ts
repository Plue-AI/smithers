import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-REL-01.md; not a qualification receipt.
// The /docs surface and release-complete page sources are unavailable.
// Written before implementation: mvp.md §12.4, M-35; lands with T-DOC-01
test("C-REL-01: Docs expose only Quickstart and Flows reference", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §12.4, M-35; lands with T-DOC-01")
  await owner(page)
  await page.goto("/")
  await say(page, "/docs")
  await expect(page.getByRole("button", { name: "Quickstart", exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Flows reference", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Quickstart", exact: true }).press("Enter")
  await expect(page.getByRole("heading", { name: "Put HTTPS in front", exact: true })).toBeVisible()
  await expect(page.getByText("brew install smithersai/tap/smithers", { exact: false })).toBeVisible()
  await expect(page.getByRole("link", { name: /API reference/ })).toBeVisible()
  await say(page, "/docs")
  await page.getByRole("button", { name: "Flows reference", exact: true }).press("Enter")
  await expect(page.getByText("flows/<name>/flow.ts", { exact: false })).toBeVisible()
  await expect(page.getByText("/flow.edit", { exact: false })).toBeVisible()
})
