import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection; does not replace the check's integration/reference-host receipts.
// Written before implementation: engineering spec.md §8.13, C-RMT-06; lands with T-RMT-04
test("C-RMT-06: TODO wakes on beaver and remains visible when placement is disabled", async ({ page }) => {
  test.fixme(true, "Written before implementation: engineering spec.md §8.13, C-RMT-06; lands with T-RMT-04")
  await owner(page)
  await page.goto("/")
  // Reference rig: coordinator Mac mini, beaver with VT-x enabled.
  // Rig config turns remoteSandboxes on before boot (there is no flag UI),
  // and turns it off after the guest command completes. Worker registration
  // supersedes the old SSH fingerprint form under §8.13.0.
  await say(page, "/settings")
  const settings = page.getByRole("region", { name: "Settings", exact: true }).last()
  await settings.getByRole("button", { name: "Add computer", exact: true }).press("Enter")
  await settings.getByRole("button", { name: "Linux computer", exact: true }).press("Enter")
  await settings.getByLabel("Name", { exact: true }).fill("beaver")
  await expect(settings).toContainText("Waiting for beaver…")
  // Owner runs the one-time join line on the rig, outside this UI scenario.
  await expect(settings).toContainText("Joined")
  await expect(settings).toContainText("Linux x86_64")
  await expect(settings).toContainText("Machine image")
  await expect(settings).toContainText("1 machine")
  await settings.getByRole("button", { name: "Add beaver", exact: true }).press("Enter")
  await say(page, "/todo.new")
  await page.getByLabel("Title", { exact: true }).fill("Remote sum")
  await page.getByLabel("Prompt", { exact: true }).fill("Add sum(a, b) with a passing test")
  await page.getByRole("button", { name: "beaver", exact: true }).last().press("Enter")
  await page.getByRole("button", { name: "Commit", exact: true }).last().press("Enter")
  await expect(page.getByText(/awake · beaver/).last()).toBeVisible()
  await expect(page.getByText("In review", { exact: true }).last()).toBeVisible()
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("region", { name: /output/ }).last()
  await terminal.click()
  await page.keyboard.type("uname -m && hostname")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("x86_64")
  await expect(terminal).toContainText("remote-sum")
  // Rig now disables the flag and reloads the config; guest keeps running.
  await page.reload()
  await say(page, "/settings")
  await expect(settings.getByRole("button", { name: "Add computer", exact: true })).toHaveCount(0)
  await expect(settings).toContainText("beaver · 1 branch · remove to finish")
  await say(page, "/todo.new")
  await expect(page.getByText("Runs on", { exact: true })).toHaveCount(0)
  await expect(terminal).toContainText("remote-sum")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
