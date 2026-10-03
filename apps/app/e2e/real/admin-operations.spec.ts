import { scenario } from "./coverage/types"
import { authenticatedTest } from "./auth-permissions/profile"
import { command, expect, closeComposer } from "./support"

import { bootProductionRepository } from "./repositories-github/production"

authenticatedTest("admin reset asks for confirmation and cancel preserves the live transcript", scenario("admin.reset-confirm-cancel", {
  capabilities: ["identity"],
  coverage: [
    "action:admin.reset.ask", "action:admin.reset.cancel", "action:admin.devtools", "host:production",
    "path:permission", "path:persistence", "path:keyboard", "door:slash", "door:button", "door:user-only",
    "dimension:keyboard", "dimension:destructive-confirmation", "dimension:reset-cancel", "evidence:transcript-and-session-readback"
  ],
  description: "An authenticated admin reaches the real destructive reset dialog, verifies its exact warning, cancels by keyboard, and proves the current transcript and session remain present."
}), async ({ page }) => {
  await bootProductionRepository(page)
  if (!await page.locator(".devtools-panel").isVisible()) await command(page, "/admin.devtools")
  await closeComposer(page)
  await expect(page.locator(".devtools-panel")).toBeVisible()
  const transcript = await page.locator(".smithers-card").count()
  await command(page, "/admin.reset.ask")
  const dialog = page.getByRole("dialog", { name: "Start a fresh conversation?" })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText("everything on screen will be discarded")
  await expect(dialog).toContainText("Nothing is kept")
  const cancel = dialog.getByRole("button", { name: "Cancel", exact: true })
  await cancel.focus()
  await expect(cancel).toBeFocused()
  await cancel.press("Enter")
  await expect(dialog).toBeHidden()
  await expect(page.locator(".smithers-card")).toHaveCount(transcript)
  await expect(page.locator(".devtools-panel")).toBeVisible()
})





