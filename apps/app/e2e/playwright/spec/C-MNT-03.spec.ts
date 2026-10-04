import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MNT-03.md; not a qualification receipt.
// Written before implementation: mvp.md §14; lands with T-MNT-03
test("C-MNT-03: Only the exact approved author reply publishes once", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §14; lands with T-MNT-03")
  await owner(page)
  await page.goto("/")
  // Future Stage-M fixture: admitted issue 42, draft evidence, lost publication response.
  await say(page, "/issue 42")
  const draft = page.getByRole("textbox", { name: "Draft reply", exact: true }).last()
  await draft.fill("Reproduced with two attempts. We are investigating.")
  await page.reload()
  await expect(draft).toHaveValue("Reproduced with two attempts. We are investigating.")
  await expect(page.getByText("Posted", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Approve", exact: true }).last().press("Enter")
  await expect(page.getByText("Reproduced with two attempts. We are investigating.", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Cancel", exact: true }).last().press("Enter")
  await expect(draft).toHaveValue("Reproduced with two attempts. We are investigating.")
  await expect(page.getByText("Posted", { exact: true })).toHaveCount(0)
  await draft.fill("Reproduced with two attempts. Fix verified.")
  await page.getByRole("button", { name: "Approve", exact: true }).last().press("Enter")
  await page.getByRole("button", { name: "Confirm", exact: true }).last().press("Enter")
  // Publication fixture commits then loses its response; reload must reconcile.
  await page.reload()
  await expect(page.getByText("Reproduced with two attempts. Fix verified.", { exact: true })).toHaveCount(1)
  await expect(page.getByText("Posted", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByText("Reproduced with two attempts. Fix verified.", { exact: true })).toHaveCount(1)
  // Live actor, subject/evidence invalidation and GitHub wire bytes need boundary receipts.
})
