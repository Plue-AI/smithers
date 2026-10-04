import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of C-CAT-03; its unit/CLI acceptance evidence remains separate.
// Written before implementation: mvp.md §6.16, Appendix A; lands with T-CAT-01
test("C-CAT-03: External agent skill requests use the shared catalog", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.16, Appendix A; lands with T-CAT-01")
  // Required seed: installed generated Smithers skill used by an external
  // agent; its read and confirm requests appear as ordinary entries. Skill
  // generation, installed paths and flags remain CLI acceptance assertions.
  await owner(page)
  await page.goto("/")
  await say(page, "/branch retry-webhooks")
  await expect(page.getByText("Claude Code for Ben", { exact: true }).last()).toBeVisible()
  await expect(page.getByText("Show sync status and retry", { exact: true })).toBeVisible()
  await expect(page.getByText("Review and merge the next item", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Review & merge", exact: true }).last()).toBeVisible()
  await expect(page.getByText("Merged T8", { exact: true })).toHaveCount(0)
  await say(page, "/help")
  const commands = page.getByRole("article", { name: "Commands", exact: true }).last()
  await expect(commands).toContainText("Show sync status and retry")
  await expect(commands).toContainText("Review and merge the next item")
  await expect(commands).not.toContainText("smthrs-admin")
  await expect(commands).not.toContainText("smthrs-org")
})
