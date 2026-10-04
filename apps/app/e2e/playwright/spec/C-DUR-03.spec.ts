import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-DUR-03.md; not a qualification receipt.
// Written before implementation: mvp.md §6.1 Restart, §9 Durability, §12.1; lands with T-GH-09, T-FLW-09, T-REL-04
test("C-DUR-03: GitHub recovery exposes conflict and preserves a late Drop obligation", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.1 Restart, §9 Durability, §12.1; lands with T-GH-09, T-FLW-09, T-REL-04")
  await owner(page)
  await page.goto("/")

  // Seed restart fixtures: uncertain push/open/body/merge/close, foreign head,
  // delayed PR creation after Drop, and a person's later reopen.
  // pending_op fencing, App identity, authority and upstream exactly-once
  // writes remain PostgreSQL/githubfake qualification, not browser evidence.
  await say(page, "/todo T9")
  await expect(page.getByText(/pushed.*commit/).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Bring in Ben's commit", exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: "Bring in Ben's commit", exact: true }).last()).toBeVisible()
  await say(page, "/todo.drop T10")
  await page.getByRole("button", { name: "Drop", exact: true }).last().press("Enter")
  await expect(page.getByText("Dropped", { exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/todo T10")
  await expect(page.getByText("Dropped", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Merge", exact: true })).toHaveCount(0)
  await say(page, "/pr #214")
  await expect(page.getByText("Closed", { exact: true }).last()).toBeVisible()
})
