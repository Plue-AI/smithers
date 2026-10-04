import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-SPK-05.md; not a qualification receipt.
// Requires two Apple Silicon hosts, concurrent loads, prepare-machine load and retained pressure samples.
// Written before implementation: mvp.md M-06, §9 Branch wake; lands with T-MCH-01
test("C-SPK-05: Memory calibration retains both host profiles", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md M-06, §9 Branch wake; lands with T-MCH-01")
  await owner(page)
  await page.goto("/")
  // The implementing ticket supplies a disposable qualification checkout;
  // this terminal only projects its output, never qualifies the host by itself.
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("region", { name: / output$/ }).last()
  await expect(terminal).toBeVisible()
  await terminal.click()
  await page.keyboard.type("scripts/spikes/mch-01-memory/run.sh")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("reserve")
  // Retain output beside the composer so qualification failures remain readable.
  await expect(page.getByTestId("composer-input")).toBeAttached()
})
