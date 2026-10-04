import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-SPK-07.md; not a qualification receipt.
// Requires second-Mac LAN pages, real document host, sequence tags and disk convergence receipts.
// Written before implementation: mvp.md §9 Live updates, J3.5, M-02; lands with T-COL-01, T-COL-11
test("C-SPK-07: Co-editing qualification retains convergence and latency samples", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §9 Live updates, J3.5, M-02; lands with T-COL-01, T-COL-11")
  await owner(page)
  await page.goto("/")
  // The implementing ticket supplies a disposable qualification checkout;
  // this terminal only projects its output, never qualifies the host by itself.
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("region", { name: / output$/ }).last()
  await expect(terminal).toBeVisible()
  await terminal.click()
  await page.keyboard.type("scripts/spikes/col-01/run.sh keystrokes")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("p95")
  // Retain output beside the composer so qualification failures remain readable.
  await expect(page.getByTestId("composer-input")).toBeAttached()
})
