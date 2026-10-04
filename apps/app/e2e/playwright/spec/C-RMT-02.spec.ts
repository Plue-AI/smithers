import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection; does not replace the check's integration/reference-host receipts.
// Written before implementation: engineering spec.md §8.13, C-RMT-02; lands with T-RMT-02
test("C-RMT-02: computer admission refuses an unavailable runtime", async ({ page }) => {
  test.fixme(true, "Written before implementation: engineering spec.md §8.13, C-RMT-02; lands with T-RMT-02")
  await owner(page)
  await page.goto("/")
  // Requires flag-on owner fixture. Separate config/permission tests must
  // prove default-off, distinct keys, member/maintainer refusal, pinned trust
  // and no private key in responses/logs. SSH admission is superseded by
  // controller/worker join (§8.13.0); do not invent an SSH-key form.
  await say(page, "/settings")
  const settings = page.getByRole("region", { name: "Settings", exact: true }).last()
  await settings.getByRole("button", { name: "Add computer", exact: true }).press("Enter")
  await settings.getByRole("button", { name: "Linux computer", exact: true }).press("Enter")
  await settings.getByLabel("Name", { exact: true }).fill("beaver")
  await expect(settings).toContainText("Run on beaver:")
  await expect(settings.getByRole("button", { name: "Copy", exact: true })).toBeVisible()
  await expect(settings).toContainText("Waiting for beaver…")
  const add = settings.getByRole("button", { name: "Add beaver", exact: true })
  await expect(add).toBeDisabled()
  // Worker fixture joins with VT-x off; no host process is a fallback.
  await expect(settings).toContainText("Joined")
  await expect(settings).toContainText("Linux x86_64")
  await expect(settings).toContainText("Virtualization is off · turn on VT-x in firmware")
  await expect(add).toBeDisabled()
  await settings.getByRole("button", { name: "Retry", exact: true }).press("Enter")
  // Fixture now enables KVM and completes the pinned machine image.
  await expect(settings).toContainText("Machine image")
  await expect(settings).toContainText("1 machine")
  await expect(add).toBeEnabled()
  await add.press("Enter")
  await page.reload()
  await say(page, "/settings")
  await expect(settings).toContainText("beaver")
  await expect(settings).toContainText("Linux")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
