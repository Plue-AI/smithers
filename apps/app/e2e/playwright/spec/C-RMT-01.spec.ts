import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection; does not replace the check's integration/reference-host receipts.
// Written before implementation: engineering spec.md §8.13, C-RMT-01; lands with T-RMT-01
test("C-RMT-01: remote guest qualification remains visible beside chat", async ({ page }) => {
  test.fixme(true, "Written before implementation: engineering spec.md §8.13, C-RMT-01; lands with T-RMT-01")
  await owner(page)
  await page.goto("/")
  // T-RMT-01 is replaced by the controller/worker spike (§8.13.0).
  // Requires its disposable rig: remote guest, reconnect fault, relay timings
  // and Cloud nested-KVM verdict. UI output alone does not qualify isolation,
  // loopback refusal, the 2x relay budget or the 5s reconnect deadline.
  await say(page, "/branch retry-webhooks")
  await expect(page.getByText("Machine awake · beaver", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "New terminal", exact: true }).last().press("Enter")
  const terminal = page.getByRole("region", { name: /output/ }).last()
  await expect(terminal).toBeVisible()
  await terminal.click()
  await page.keyboard.type("uname -m && hostname")
  await page.keyboard.press("Enter")
  await expect(terminal).toContainText("x86_64")
  // The spike fixture names the guest differently from its computer.
  await expect(terminal).toContainText("retry-webhooks")
  // Rig drops the transport for 3s; the same guest/session must survive.
  await page.reload()
  await expect(terminal).toContainText("retry-webhooks")
  await expect(page.getByText("Machine awake · beaver", { exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
