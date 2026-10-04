import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-SPK-06.md; not a qualification receipt.
// Requires fresh macOS user, both Homebrew variants and real GUI LaunchAgent execution.
// Written before implementation: mvp.md §6.1, §12.5, M-10; lands with T-INS-03
test("C-SPK-06: Installed hypervisor qualification retains signing and boot results", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.1, §12.5, M-10; lands with T-INS-03")
  await owner(page)
  await page.goto("/")
  // The implementing ticket supplies a disposable qualification checkout;
  // this terminal only projects its output, never qualifies the host by itself.
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("region", { name: / output$/ }).last()
  await expect(terminal).toBeVisible()
  await terminal.click()
  await page.keyboard.type("scripts/spikes/homebrew-hypervisor/run.sh")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("doctor")
  // Retain output beside the composer so qualification failures remain readable.
  await expect(page.getByTestId("composer-input")).toBeAttached()
})
