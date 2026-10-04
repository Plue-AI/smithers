import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-PRC-03.md; not a qualification receipt.
// Receipt validation is engineering-only; isolated CI transport and terminal execution are required.
// Written before implementation: mvp.md §12.1, M-29; lands with T-PRC-03
test("C-PRC-03: Receipt refusal cases remain observable without publishing an issue", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §12.1, M-29; lands with T-PRC-03")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("region", { name: / output$/ }).last()
  await terminal.click()
  // This fixture suite intercepts publication; the lane never closes a live issue.
  await page.keyboard.type("node --test scripts/check-receipts.test.mjs")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("# fail 0")
  await expect(terminal).toContainText("# pass")
})
