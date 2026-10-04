import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MNT-05.md; not a qualification receipt.
// Written before implementation: mvp.md §14, M-26; lands with T-MNT-05
test("C-MNT-05: Upgraded install retains work and exposes the maintainer journey", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §14, M-26; lands with T-MNT-05")
  await owner(page)
  await page.goto("/")
  // Future fixture: populated launch install upgraded through the real owner CLI;
  // browser starts with a retained TODO and newly synced outsider issue/PR.
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme })
    await page.reload()
    await say(page, "/todo T8")
    await expect(page.getByText("In review", { exact: true }).last()).toBeVisible()
    await say(page, "/stack")
    await page.getByRole("button", { name: "Incoming", exact: true }).last().press("Enter")
    await say(page, "/issue 42")
    await page.getByRole("button", { name: "Triage", exact: true }).last().press("Enter")
    await page.getByRole("button", { name: "Approve", exact: true }).last().press("Enter")
    await expect(page.getByText("Reproduced", { exact: true }).last()).toBeVisible()
    await page.getByRole("textbox", { name: "Draft reply", exact: true }).last().fill("Verified the failing reproduction.")
    await page.getByRole("button", { name: "Approve", exact: true }).last().press("Enter")
    await page.getByRole("button", { name: "Confirm", exact: true }).last().press("Enter")
    await expect(page.getByText("Posted", { exact: true }).last()).toBeVisible()
    await say(page, "/pr 73")
    await say(page, "/review 73")
    await page.getByRole("button", { name: "Confirm", exact: true }).last().press("Enter")
    await expect(page.getByText("Blocker", { exact: true }).last()).toBeVisible()
    await expect(page.getByRole("button", { name: "Merge", exact: true }).last()).not.toBeVisible()
  }
  // Upgrade/restore identities, actual GitHub bytes and launch+7 publication
  // are reference-host prerequisites, never inferred from a mounted card.
})
