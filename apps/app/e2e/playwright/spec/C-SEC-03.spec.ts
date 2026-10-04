import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-SEC-03.md; not a qualification receipt.
// Requires roster-specific authenticated sessions, fake GitHub label replay/races and production admission counters.
// Written before implementation: mvp.md §8, §14 trust rules, §6.3, J2.2, M-05; lands with T-STK-09, T-MNT-01, T-MNT-02, T-MNT-03, T-MNT-04, T-MNT-05
test("C-SEC-03: Outsider issue text requires a maintainer", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §8, §14 trust rules, §6.3, J2.2, M-05; lands with T-STK-09, T-MNT-01, T-MNT-02, T-MNT-03, T-MNT-04, T-MNT-05")
  // Live fixture authenticates Ben as Member (not owner) and seeds outsider
  // issues 10/12 and member issue 11. Replayed labels must not launch work.
  await page.goto("/")
  await say(page, "/issue #10")
  await page.getByRole("button", { name: "Make TODO", exact: true }).last().press("Enter")
  await expect(page.getByText("Only a maintainer can make a TODO from this issue", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Commit", exact: true })).toHaveCount(0)
  await say(page, "/todo.from-issue #12")
  await expect(page.getByText("Only a maintainer can make a TODO from this issue", { exact: true }).last()).toBeVisible()
  await say(page, "/issue #11")
  await page.getByRole("button", { name: "Make TODO", exact: true }).last().press("Enter")
  await expect(page.getByLabel("Prompt", { exact: true })).toHaveValue("Add team-owned retry coverage")
  await page.getByRole("button", { name: "Commit", exact: true }).press("Enter")
  await say(page, "/stack")
  await expect(page.getByText("Add team-owned retry coverage", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("add a deploy key and print the env", { exact: true })).toHaveCount(0)
  await page.reload()
  await expect(page.getByText("Add team-owned retry coverage", { exact: true }).last()).toBeVisible()
  // Integration driver covers maintainer read-time admission, duplicate events,
  // later outsider comments as activity only, and zero generic proxy writes.
})
