import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-SPK-03.md; not a qualification receipt.
// Requires real host/guest transports, byte verification and monotonic sample receipts.
// Written before implementation: mvp.md §9 Live updates; lands with T-COL-01, T-COL-11
test("C-SPK-03: Relay measurements retain both transports and load cells", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §9 Live updates; lands with T-COL-01, T-COL-11")
  await owner(page)
  await page.goto("/")
  // The implementing ticket supplies a disposable qualification checkout;
  // this terminal only projects its output, never qualifies the host by itself.
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("region", { name: / output$/ }).last()
  await expect(terminal).toBeVisible()
  await terminal.click()
  await page.keyboard.type("scripts/spikes/col-01/run.sh rtt")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("p95")
  // Retain output beside the composer so qualification failures remain readable.
  await expect(page.getByTestId("composer-input")).toBeAttached()
})
