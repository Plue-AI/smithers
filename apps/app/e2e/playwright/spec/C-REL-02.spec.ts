import { expect, test } from "../browserTest"
import { owner } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-REL-02.md; not a qualification receipt.
// Requires a released bottle, fresh reference host, connection log and one sudo prompt; browser fixtures cannot qualify installation.
// Written before implementation: mvp.md §12.5, §6.1, M-09; lands with T-INS-05, T-INS-08
test("C-REL-02: A fresh public install reaches setup without a Smithers account", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §12.5, §6.1, M-09; lands with T-INS-05, T-INS-08")
  await owner(page)
  await page.goto("/")
  // The host fixture has already run brew install and host start, and supplies
  // its printed one-time setup URL as the browser base URL. DNS/CLI receipts
  // prove the install contacted no Smithers-operated service.
  await page.goto("/setup")
  const card = page.getByRole("region", { name: "Set up Smithers", exact: true })
  await expect(card).toBeVisible()
  await expect(card).not.toContainText(/Smithers account|license|Smithers token/)
  await expect(card.getByRole("button", { name: "Address", exact: true })).toBeEnabled()
  await page.reload()
  await expect(page.getByRole("region", { name: "Set up Smithers", exact: true })).toBeVisible()
})
