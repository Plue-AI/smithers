import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-REL-04.md; not a qualification receipt.
// Owner-only scorecard has no product card; requires real PostgreSQL fixtures and separately annotated alpha effort.
// Written before implementation: mvp.md §12.2, §9; lands with T-REL-03
test("C-REL-04: Scorecard fixtures report missing sources without inventing passing counts", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §12.2, §9; lands with T-REL-03")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("region", { name: / output$/ }).last()
  await terminal.click()
  // Production-router fixtures assert literal counts, source_missing, owner
  // authorization, UTC boundaries and no writes. Manual effort is separate.
  await page.keyboard.type("go test -v -run Scorecard ./packages/backend/internal/services/ ./packages/backend/internal/routes/")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("PASS")
  await expect(terminal).not.toContainText("FAIL")
})
