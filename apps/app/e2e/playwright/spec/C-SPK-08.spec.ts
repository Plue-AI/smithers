import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-SPK-08.md; not a qualification receipt.
// Requires second-Mac VS Code recording, real SSH transport, cgroup samples and cleanup-failure admission fixture.
// Written before implementation: mvp.md §6.15, §6.8, M-18, M-24; lands with T-TRM-06
test("C-SPK-08: Remote session qualification retains revocation and cleanup results", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md §6.15, §6.8, M-18, M-24; lands with T-TRM-06")
  await owner(page)
  await page.goto("/")
  // The implementing ticket supplies a disposable qualification checkout;
  // this terminal only projects its output, never qualifies the host by itself.
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("region", { name: / output$/ }).last()
  await expect(terminal).toBeVisible()
  await terminal.click()
  await page.keyboard.type("scripts/spikes/trm-06/run.sh")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("populated 0")
  // Retain output beside the composer so qualification failures remain readable.
  await expect(page.getByTestId("composer-input")).toBeAttached()
})
