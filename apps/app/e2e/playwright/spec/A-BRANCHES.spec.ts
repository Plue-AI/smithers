import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Live branch, machine and durable provider receipts remain pending.
// Written before implementation: mvp.md Appendix A, J3, §6.8; lands with T-APP-10, T-COL-06
test("A-BRANCHES: lists branches with presence", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J3, §6.8; lands with T-APP-10, T-COL-06")
  await owner(page)
  await page.goto("/")
  await say(page, "/branches")
  const tree = page.getByRole("navigation", { name: "Branches", exact: true })
  await expect(tree).toContainText("retry-webhooks")
  await expect(tree).toContainText("Alice")
  await expect(tree).toContainText("Coding agent")
  await tree.getByRole("button", { name: /retry-webhooks/ }).press("Enter")
  await expect(page.locator(".branch-view").last()).toContainText("Needs you")
  await page.reload()
  await expect(page.locator(".session-navigation")).toContainText("retry-webhooks")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded UI projection; does not discharge the live-provider scenario above.
test("A-BRANCHES: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  const trigger = page.getByRole("navigation", { name: "Branch", exact: true }).getByRole("button", { name: "main", exact: true })
  await trigger.press("Enter")
  const tree = page.getByRole("navigation", { name: "Branches", exact: true })
  await expect(tree).toContainText("retry-webhooks")
  await expect(tree).toContainText("fix-checkout-race")
  await page.keyboard.press("Escape")
  await expect(tree).toHaveCount(0)
  await expect(trigger).toBeFocused()
})
