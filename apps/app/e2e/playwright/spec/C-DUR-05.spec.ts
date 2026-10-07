import { expect, test } from "../browserTest"
import { owner, say } from "./j1-fixtures"

// UI projection only. Literal outbox fixtures, event order/identity, pending
// refs, untouched refused bytes and migration crashes belong to T-COL-13.
// The browser host needs an upgraded/refused machine seed before activation.
// Written before implementation: spec.md §9.1.4a, mvp.md §12; lands with T-COL-13
test("C-DUR-05: previous-release edits survive an interrupted upgrade", async ({ page }) => {
  test.fixme(true, "Written before implementation: spec.md §9.1.4a, mvp.md §12; lands with T-COL-13")
  await owner(page)
  await page.goto("/")
  // Seed the previous-release outbox and restart after a mid-migration crash.
  await say(page, "/branch retry-webhooks")
  const burst = page.getByRole("button", { name: "Maya via SSH changed 3 files", exact: true })
  await expect(burst).toHaveCount(1)
  await burst.press("Enter")
  await say(page, "/file src/webhooks/retry.ts")
  const editor = page.getByRole("textbox", { name: "src/webhooks/retry.ts", exact: true }).last()
  await expect(editor).toHaveValue(/Alice keeps delivery idempotent/)
  await expect(page.getByText("Saved to the machine", { exact: true }).last()).toBeVisible()
  await page.reload()
  await expect(editor).toHaveValue(/Alice keeps delivery idempotent/)
  await expect(burst).toHaveCount(1)
})

for (const refusal of ["newer format", "corrupt header"]) {
  // Written before implementation: spec.md §9.1.4a, mvp.md §12; lands with T-COL-13
  test(`C-DUR-05: ${refusal} keeps unacknowledged edits unsaved`, async ({ page }) => {
    test.fixme(true, "Written before implementation: spec.md §9.1.4a, mvp.md §12; lands with T-COL-13")
    await owner(page)
    await page.goto("/")
    // Seed this refusal with two retained local edits and no daemon receipt.
    await say(page, "/file src/webhooks/retry.ts")
    const editor = page.getByRole("textbox", { name: "src/webhooks/retry.ts", exact: true }).last()
    await expect(editor).toHaveValue(/Ben keeps retries bounded/)
    await expect(page.getByText("2 edits weren't saved", { exact: true }).last()).toBeVisible()
    await expect(page.getByRole("button", { name: "Reapply", exact: true }).last()).toBeVisible()
    await expect(page.getByText("Saved to the machine", { exact: true })).toHaveCount(0)
    await page.reload()
    await expect(editor).toHaveValue(/Ben keeps retries bounded/)
    await expect(page.getByText("2 edits weren't saved", { exact: true }).last()).toBeVisible()
    await expect(page.getByText("Saved to the machine", { exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Maya via SSH changed 3 files", exact: true })).toHaveCount(0)
  })
}
