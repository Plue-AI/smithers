import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-PERF-06.md; not a qualification receipt.
// Needs live main updates, daemon hold logs, local snapshot/outbox evidence and held-write recovery.
// Written before implementation: mvp.md §4.2; lands with T-STK-08, T-REL-01
test("C-PERF-06: A present member explicitly rebases after Retry", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §4.2; lands with T-STK-08, T-REL-01")
  await owner(page)
  await page.goto("/")
  // Live harness advances scratch main, then withholds host acknowledgements for 10 s.
  for (let i = 0; i < 100; i++) {
    await say(page, "/stack")
    await page.getByRole("button", { name: "Retry", exact: true }).first().press("Enter")
    await say(page, "/branch retry-webhooks")
    await expect(page.getByText("Rebase pending", { exact: true }).last()).toBeVisible()
    await page.getByRole("button", { name: "Rebase now", exact: true }).last().press("Enter")
    await expect(page.getByText("Rebase pending", { exact: true })).toHaveCount(0)
    await page.getByRole("tab", { name: /^Activity/ }).last().press("Enter")
    await expect(page.getByText(/^Rebased onto/).last()).toBeVisible()
  }
})
