import { expect, test } from "../browserTest"
import { owner } from "./j1-fixtures"

// UI projection of C-UI-08; acceptance now lives in T-APP-22.
// Reference-host and integration evidence remains required separately.
// Written before implementation: mvp.md §8, old sessions remain readable; lands with T-APP-22
test("C-UI-08: Earlier records render inert titled tombstones", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §8, old sessions remain readable; lands with T-APP-22")
  // Required seed: private browser and journal archives containing retained
  // historical card bytes, titled/empty tombstones and a hostile text title.
  await owner(page)
  await page.goto("/")
  await page.getByRole("button", { name: "Earlier", exact: true }).press("Enter")
  await page.getByText("Browser archive", { exact: true }).press("Enter")
  const archive = page.getByRole("region", { name: "Earlier", exact: true })
  await expect(archive).toContainText("Old prompt")
  await expect(archive).toContainText("Old answer")
  await expect(archive.getByText("Saved historical card", { exact: true })).toBeVisible()
  await expect(archive.getByText("<script>archiveCanary()</script>", { exact: true })).toBeVisible()
  await expect(archive).not.toContainText("private-payload-canary")
  await expect(archive.getByRole("button")).toHaveCount(0)
  await expect(archive.getByRole("textbox")).toHaveCount(0)
  await page.keyboard.press("Control+k")
  await expect(archive.getByRole("button", { name: "Restore", exact: true })).toHaveCount(0)
  await page.keyboard.press("Escape")
  await page.getByRole("button", { name: "Earlier", exact: true }).press("Enter")
  await page.getByText("Journal archive", { exact: true }).press("Enter")
  await expect(archive.getByText("Saved historical card", { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByText("Saved historical card", { exact: true })).toBeVisible()
})
