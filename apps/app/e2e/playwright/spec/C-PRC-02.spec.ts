import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-PRC-02.md; not a qualification receipt.
// Check is folded into its implementing ticket; real terminal transport and isolated failure fixtures are unavailable.
// Written before implementation: mvp.md §12.1; lands with T-PRC-02
test("C-PRC-02: DB-free migration failures remain visible in terminal output", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §12.1; lands with T-PRC-02")
  await owner(page)
  await page.goto("/")
  // Ticket owns isolated valid/invalid fixtures and the refusal of publication.
  // No product card or button exists for these engineering-only gates.
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("region", { name: / output$/ }).last()
  await terminal.click()
  await page.keyboard.type("env -u DATABASE_URL -u TEST_DATABASE_URL go test -run 'TestMigrationGate|TestMigrationRegistry' ./packages/backend/db/product/")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("FAIL")
})
