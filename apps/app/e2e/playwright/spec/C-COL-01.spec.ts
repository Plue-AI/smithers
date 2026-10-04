import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-COL-01.md; not a qualification receipt.
// Written before implementation: mvp.md J3.5, §6.8, M-02; lands with T-COL-10, T-COL-03r, T-COL-08a, T-COL-08b, T-APP-14a
test("C-COL-01: Stale restoration keeps the newer file and offers comparison", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md J3.5, §6.8, M-02; lands with T-COL-10, T-COL-03r, T-COL-08a, T-COL-08b, T-APP-14a")
  await owner(page)
  await page.goto("/")
  // Seed: an outside burst with a before version; after the Diff opens a
  // second writer changes the same path. Restore must use the burst digest.
  // Missing-base and codec assertions remain component/HTTP evidence.
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "Changed outside Smithers · 3 files", exact: true }).last().press("Enter")
  await page.getByRole("button", { name: "Restore this file", exact: true }).last().press("Enter")
  await expect(page.getByRole("group", { name: "Live and outside versions", exact: true }).last()).toBeVisible()
  await say(page, "/file src/webhooks/retry.ts")
  const editor = page.getByRole("textbox", { name: "src/webhooks/retry.ts", exact: true }).last()
  await expect(editor).toHaveValue(/Alice keeps delivery idempotent/)
  await expect(editor).not.toHaveValue(/await sleep\(30_000\)/)
  await page.reload()
  await say(page, "/file src/webhooks/retry.ts")
  await expect(editor).toHaveValue(/Alice keeps delivery idempotent/)
})
