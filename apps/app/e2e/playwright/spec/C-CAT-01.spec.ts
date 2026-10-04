import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of C-CAT-01; its unit/CLI acceptance evidence remains separate.
// Written before implementation: mvp.md Appendix A, Appendix B; lands with T-CAT-01
test("C-CAT-01: Commands show MVP doors and hide retired commands", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, Appendix B; lands with T-CAT-01")
  // Required seed: complete member catalog plus repository release-notes flow;
  // unit tests separately prove CLI, tool, actor and runtime tag equality.
  await owner(page)
  await page.goto("/")
  await say(page, "/help")
  const commands = page.getByRole("article", { name: "Commands", exact: true }).last()
  await expect(commands).toBeVisible()
  for (const copy of ["Ask", "TODOs and the stack", "Branches and machines", "Files and code", "Review", "Issues", "Wiki", "Flows", "Runs", "GitHub", "Account and settings"]) {
    await expect(commands.getByRole("heading", { name: copy, exact: true })).toBeVisible()
  }
  await expect(commands.getByText("/monitor", { exact: true })).not.toBeVisible()
  await commands.getByText("Advanced", { exact: true }).press("Enter")
  await expect(commands.getByText("/monitor", { exact: true })).toBeVisible()
  await expect(commands.getByText("/release-notes", { exact: true })).toBeVisible()
  for (const retired of ["/chat.clear", "/billing", "/debug", "/issue-sweep"]) {
    await expect(commands.getByText(retired, { exact: true })).toHaveCount(0)
  }
  await say(page, "/todo T8")
  await expect(page.locator(".smithers-card").last()).toContainText("Upgrade Stripe to v15")
})
