import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-CUT-02.md; not a qualification receipt.
// Written before implementation: mvp.md §8, old conversations stay readable; lands with T-APP-22
test("C-CUT-02: Historical titles and conversation text survive card removal", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §8, old conversations stay readable; lands with T-APP-22")
  await owner(page)
  await page.goto("/")

  // Seed browser and journal archives with every removed card, a hostile title,
  // retained live File/Run cards and another member's private archive.
  for (const source of ["Browser archive", "Journal archive"]) {
    await page.getByRole("button", { name: "Earlier", exact: true }).press("Enter")
    await page.getByText(source, { exact: true }).press("Enter")
    const archive = page.getByRole("region", { name: "Earlier", exact: true })
    await expect(archive).toContainText("Old prompt")
    await expect(archive).toContainText("Old answer")
    await expect(archive.getByText("Saved historical card", { exact: true })).toBeVisible()
    await expect(archive.getByText("<script>archiveCanary()</script>", { exact: true })).toBeVisible()
    await expect(archive).not.toContainText("private-payload-canary")
    await expect(archive.getByRole("button")).toHaveCount(0)
    await expect(archive.getByRole("textbox")).toHaveCount(0)
    await expect(page.getByText("Alice's private archive", { exact: true })).toHaveCount(0)
  }
  await page.reload()
  await expect(page.getByText("Saved historical card", { exact: true })).toBeVisible()
  await say(page, "/file src/webhooks/retry.ts")
  await expect(page.getByRole("region", { name: "File content", exact: true }).last()).toContainText("await sleep(30_000)")
})
