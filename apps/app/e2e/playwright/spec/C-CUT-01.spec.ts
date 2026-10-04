import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-CUT-01.md; not a qualification receipt.
// Written before implementation: mvp.md §8, Appendix B; lands with T-CUT-01
test("C-CUT-01: Cut and deferred surfaces stay out of the member doors", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §8, Appendix B; lands with T-CUT-01")
  await owner(page)
  await page.goto("/")

  // Seed a member with the complete MVP catalog and historical cut cards.
  // Registry, CLI, agent-tool and retained-build assertions belong to T-CUT-01.
  await say(page, "/help")
  const commands = page.getByRole("region", { name: "Commands", exact: true }).last()
  await expect(commands).toContainText("/todo.new")
  await expect(commands).toContainText("/terminal")
  for (const text of ["Five jobs", "Practice repository", "Admin console", "Subagent grid", "Billing", "Marketplace", "Repository switching"]) {
    await expect(commands).not.toContainText(text)
    await expect(page.getByRole("button", { name: text, exact: true })).toHaveCount(0)
  }
  await page.keyboard.press("Control+k")
  for (const text of ["Five jobs", "Admin console", "Subagent grid", "Billing", "Marketplace"]) {
    await expect(page.getByRole("option", { name: text, exact: true })).toHaveCount(0)
  }
  await page.keyboard.press("Escape")
  await say(page, "/stack")
  await expect(page.getByText("Retry failed webhooks with backoff", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(page.getByRole("button", { name: "Practice repository", exact: true })).toHaveCount(0)
})
