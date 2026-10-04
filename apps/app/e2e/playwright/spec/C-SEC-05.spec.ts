import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-SEC-05.md; not a qualification receipt.
// Requires authenticated production terminal sessions, private Confirm consumer, session rotation and revocation.
// Written before implementation: mvp.md M-18, J6.1; lands with T-TRM-02
test("C-SEC-05: Terminal delegation confirms append in the app and denies merge", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md M-18, J6.1; lands with T-TRM-02")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const output = page.getByRole("region", { name: / output$/ }).last()
  await output.click()
  // Guest CLI always uses delegated authority; the live fixture runs as Ben.
  await page.keyboard.type('smthrs todo new "Add terminal scope coverage"')
  await page.keyboard.press("Enter")
  await expect(page.getByRole("button", { name: "Confirm", exact: true }).last()).toBeVisible()
  await expect(page.getByText("Working", { exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Confirm", exact: true }).last().press("Enter")
  await say(page, "/stack")
  await expect(page.getByText("Add terminal scope coverage", { exact: true }).last()).toBeVisible()
  await say(page, "/branch retry-webhooks")
  await output.click()
  await page.keyboard.type("smthrs merge T9")
  await page.keyboard.press("Enter")
  await expect(output).toContainText("permission")
  await expect(page.getByRole("button", { name: "Review & merge", exact: true })).toHaveCount(0)
  await page.getByRole("button", { name: "Close", exact: true }).last().press("Enter")
  // The integration driver reuses the closed token and suspends/removes Ben;
  // both refuse immediately. Simultaneous A/B terminals prove closing A does
  // not evict B. It also covers forged headers and missing Confirm consumer.
})
