import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-CUT-01.md; not a qualification receipt.
// Deferred discovery regression for T-CUT-03; real install proof lives in e2e/real.
test("C-CUT-01: Cut and deferred surfaces stay out of the member doors", async ({ page }) => {
  await owner(page)
  await page.goto("/")

  // Without a served catalog, discovery must fail closed while /help remains usable.
  // Registry, CLI, agent-tool and retained-build assertions belong to T-CUT-01.
  await say(page, "/help")
  const commands = page.getByRole("article", { name: "Commands", exact: true }).last()
  await expect(commands).toContainText("/help")
  for (const text of ["Five jobs", "Practice repository", "Admin console", "Subagent grid", "Billing", "Marketplace", "Repository switching"]) {
    await expect(commands).not.toContainText(text)
    await expect(page.getByRole("button", { name: text, exact: true })).toHaveCount(0)
  }
  await page.getByRole("button", { name: "Chat", exact: true }).click()
  await page.getByTestId("composer-input").fill("/")
  await expect(page.getByTestId("palette")).toBeVisible()
  await expect(page.getByTestId("palette")).toContainText("help")
  for (const text of ["Five jobs", "Admin console", "Subagent grid", "Billing", "Marketplace"]) {
    await expect(page.getByRole("option", { name: text, exact: true })).toHaveCount(0)
  }
  await page.keyboard.press("Escape")
  await page.reload()
  await expect(page.getByRole("button", { name: "Practice repository", exact: true })).toHaveCount(0)
})
