import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection of .specs/engineering/checks/C-REL-06.md; not a qualification receipt.
// Requires two reference Macs, concurrent load, quiesce fault points and independently verified manifest hashes.
// Written before implementation: mvp.md M-26, §12.6, §6.1 Restart; lands with T-INS-07
test("C-REL-06: Restored backup retains stack, files and interrupted work", async ({ page }) => {
  test.fixme(true, "Written before implementation: mvp.md M-26, §12.6, §6.1 Restart; lands with T-INS-07")
  await owner(page)
  await page.goto("/")
  await say(page, "/branch retry-webhooks")
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const output = page.getByRole("region", { name: / output$/ }).last()
  await output.click()
  await page.keyboard.type("printf cycle23-backup > backup-marker.txt; cat backup-marker.txt")
  await page.keyboard.press("Enter")
  await expect(output).toContainText("cycle23-backup")
  // The reference-host driver now backs up A under load, stops A and restores
  // on B. It verifies manifest hashes, quiesce refusals and all six kill points;
  // a browser reload alone cannot exercise that boundary.
  await page.reload()
  await say(page, "/stack")
  await expect(page.getByText("T9", { exact: true }).first()).toBeVisible()
  await say(page, "/branch retry-webhooks")
  await expect(page.getByText("Asleep", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const restored = page.getByRole("region", { name: / output$/ }).last()
  await restored.click()
  await page.keyboard.type("cat backup-marker.txt")
  await page.keyboard.press("Enter")
  await expect(restored).toContainText("cycle23-backup")
  await say(page, "/run interrupted")
  await expect(page.getByText("Interrupted", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Retry", exact: true }).last()).toBeVisible()
})
