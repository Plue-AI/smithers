import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-MNT-02.md; not a qualification receipt.
// Written before implementation: mvp.md §14; lands with T-MNT-02
test("C-MNT-02: Reproduction shows measured evidence and retains failure", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §14; lands with T-MNT-02")
  await owner(page)
  await page.goto("/")
  // Stage-M fixture: approved failing reproduction, unrelated duplicate candidate.
  await say(page, "/issue 42")
  await page.getByRole("button", { name: "Triage", exact: true }).last().press("Enter")
  await expect(page.getByText("node reproduce.cjs", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Reproduced", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Approve", exact: true }).last().press("Enter")
  await expect(page.getByText("Reproduced", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Expected: 3 attempts", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Actual: 2 attempts", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Open", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByText("Actual: 2 attempts", { exact: true }).last()).toBeVisible()
  // Separate seeded executor-failure issue must never claim reproduction.
  await say(page, "/issue 43")
  await page.getByRole("button", { name: "Triage", exact: true }).last().press("Enter")
  await expect(page.getByText("Failed", { exact: true }).last()).toBeVisible()
})
