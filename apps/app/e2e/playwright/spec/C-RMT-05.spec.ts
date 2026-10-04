import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection; does not replace the check's integration/reference-host receipts.
// Written before implementation: engineering spec.md §8.13, C-RMT-05; lands with T-RMT-05
test("C-RMT-05: Cloud computer revocation offers sign-in without billing", async ({ page }) => {
  test.fixme(true, "Written before implementation: engineering spec.md §8.13, C-RMT-05; lands with T-RMT-05")
  await owner(page)
  await page.goto("/")
  // Stage 2 only. Requires disposable Cloud grant, remote-runtime contract
  // receipts and revoked-grant fixture. Cloud transport is under reconciliation;
  // this projection does not authorize building Cloud before stage 2.
  await say(page, "/settings")
  const settings = page.getByRole("region", { name: "Settings", exact: true }).last()
  await settings.getByRole("button", { name: "Add computer", exact: true }).press("Enter")
  await settings.getByRole("button", { name: "Smithers Cloud", exact: true }).press("Enter")
  await settings.getByRole("button", { name: "Sign in", exact: true }).press("Enter")
  // Fixture completes the authorized Cloud handoff, with image ready.
  await settings.getByRole("button", { name: "Add Smithers Cloud", exact: true }).press("Enter")
  await expect(settings).toContainText("Smithers Cloud")
  await expect(settings).not.toContainText("Billing")
  await expect(settings).not.toContainText("Upgrade plan")
  await say(page, "/todo.new")
  await page.getByLabel("Title", { exact: true }).fill("Cloud retry")
  await page.getByLabel("Prompt", { exact: true }).fill("Verify the retry on Smithers Cloud")
  await page.getByRole("button", { name: "Smithers Cloud", exact: true }).last().press("Enter")
  await page.getByRole("button", { name: "Commit", exact: true }).last().press("Enter")
  await expect(page.getByText(/awake · Smithers Cloud/).last()).toBeVisible()
  // Rig revokes the grant mid-step; no silent fallback to this Mac.
  await expect(page.getByText("Failed", { exact: true }).last()).toBeVisible()
  await say(page, "/settings")
  await expect(settings).toContainText("Signed out · Sign in")
  await expect(settings.getByRole("button", { name: "Sign in", exact: true }).last()).toBeEnabled()
  await page.reload()
  await say(page, "/settings")
  await expect(settings).toContainText("Signed out · Sign in")
  await expect(page.getByTestId("composer-input")).toBeEditable()
})
