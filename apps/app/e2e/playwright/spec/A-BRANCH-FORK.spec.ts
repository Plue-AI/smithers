import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// Live branch, machine and durable provider receipts remain pending.
// Written before implementation: mvp.md Appendix A, J7.2, §6.7; lands with T-MCH-08
test("A-BRANCH-FORK: forks without interrupting the source TODO", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md Appendix A, J7.2, §6.7; lands with T-MCH-08")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch.fork T10")
  const scratch = page.locator(".branch-view").last()
  await expect(scratch).toContainText("Scratch")
  await expect(scratch).toContainText("Forked from T10")
  await scratch.getByRole("tab", { name: /Files/ }).press("Enter")
  await expect(scratch.getByRole("tabpanel")).toContainText("src/checkout/checkout.test.ts")
  await say(page, "/todo T10")
  await expect(page.locator(".smithers-card").last()).toContainText("Working")
  await page.reload()
  await say(page, "/branches")
  await expect(page.getByRole("navigation", { name: "Branches", exact: true })).toContainText("fix-checkout-race")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})

// Seeded UI projection; does not discharge the live-provider scenario above.
test("A-BRANCH-FORK: mounted controls", async ({ page }) => {
  await owner(page)
  await page.goto("/")
  await say(page, "/branch.fork T10")
  const scratch = page.locator(".branch-view").last()
  await expect(scratch).toContainText("Scratch")
  await expect(scratch).toContainText("Forked from T10")
  await expect(scratch.getByRole("button", { name: "Add to stack", exact: true })).toBeVisible()
  await say(page, "/todo T10")
  await expect(page.locator(".smithers-card").last()).toContainText("Working")
})
