import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-INS-03.md; not a qualification receipt.
// Written before implementation: mvp.md §6.1 Reaching the install, M-28; lands with T-INS-04
test("C-INS-03: Owner address changes survive reload and update the SSH line", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.1 Reaching the install, M-28; lands with T-INS-04")
  // Folded check: T-INS-04 owns listener, origin, CSRF and OAuth qualification.
  await owner(page)
  await page.goto("/")
  await say(page, "/settings")
  await page.getByRole("button", { name: "Address", exact: true }).last().press("Enter")
  await page.getByRole("button", { name: "Network", exact: true }).last().press("Enter")
  await page.getByLabel("Address", { exact: true }).last().fill("http://lan-a:4000")
  await page.getByLabel("Address", { exact: true }).last().press("Enter")
  await expect(page.getByText("http://lan-a:4000", { exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "SSH", exact: true }).last().press("Enter")
  await expect(page.getByText("ssh -p 2222 retry-webhooks@lan-a", { exact: true }).last()).toBeVisible()
  await say(page, "/settings")
  await expect(page.getByText("Network · 0.0.0.0", { exact: true }).last()).toBeVisible()
})
