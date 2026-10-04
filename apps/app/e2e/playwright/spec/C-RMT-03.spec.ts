import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection; does not replace the check's integration/reference-host receipts.
// Written before implementation: engineering spec.md §8.13, C-RMT-03; lands with T-RMT-03
test("C-RMT-03: remote branch keeps terminal and file behavior through recovery", async ({ page }) => {
  test.fixme(true, "Written before implementation: engineering spec.md §8.13, C-RMT-03; lands with T-RMT-03")
  await owner(page)
  await page.goto("/")
  // Requires remote-backed T9 with src/retry.ts and an owned terminal;
  // rig drops transport mid-step then reconnects. Contract receipts also
  // check create/delete, install-only model keys/journal and isolation.
  // Forward probes in the old ticket are superseded by §8.13.0.
  await say(page, "/branch T9")
  await expect(page.getByText("Machine awake · beaver", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("region", { name: /output/ }).last()
  await terminal.click()
  await page.keyboard.type("printf remote-contract > /tmp/remote-contract; cat /tmp/remote-contract")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("remote-contract")
  await say(page, "/file src/retry.ts")
  await expect(page.getByText("src/retry.ts", { exact: true }).last()).toBeVisible()
  await expect(page.getByRole("button", { name: "Restore this file", exact: true })).toHaveCount(0)
  await say(page, "/todo T9")
  // Rig's boot-failure phase exposes failure in-place, never host execution.
  await expect(page.getByText("Failed", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "Retry", exact: true }).last().press("Enter")
  await expect(page.getByText("In review", { exact: true }).last()).toBeVisible()
  await page.reload()
  await say(page, "/branch T9")
  await expect(page.getByText("Machine awake · beaver", { exact: true })).toBeVisible()
  await page.getByRole("tab", { name: /Terminals/ }).last().press("Enter")
  await expect(page.getByRole("button", { name: "terminal 1", exact: true }).last()).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
