import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-SPK-02.md; not a qualification receipt.
// Live two-machine decision evidence is unavailable; shared homes were rejected, not deferred.
// Written before implementation: mvp.md M-18, J6.1, J6.5; lands with T-MCH-02
test("C-SPK-02: Rejected shared homes retain a NO decision", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md M-18, J6.1, J6.5; lands with T-MCH-02")
  await owner(page)
  await page.goto("/")
  // The implementing ticket supplies a disposable qualification checkout;
  // this terminal only projects its output, never qualifies the host by itself.
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("region", { name: / output$/ }).last()
  await expect(terminal).toBeVisible()
  await terminal.click()
  await page.keyboard.type("scripts/spikes/mch-02-virtiofs-homes/run.sh --decision-evidence .artifacts/checks/C-SPK-02")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("NO")
  // Retain output beside the composer so qualification failures remain readable.
  await expect(page.getByTestId("composer-input")).toBeAttached()
})
