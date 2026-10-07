import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { editorText, fileCoeditFixture } from "./file-coedit-fixture"

// Browser projection through the production File flow, seam and document channel.
// The test host supplies receipts; it does not certify machine durability.
// Literal N/N+1 outboxes, both migration crashes, identity/order/pending refs and
// untouched N+2/corrupt refusal are executed in smithers-machined/tests/outbox.rs.
test("C-DUR-05: replayed edits remain visible after reload", async ({ page }) => {
  const host = fileCoeditFixture()
  try {
    await host.install(page, "Alice")
    await page.goto("/")
    await say(page, '/file {"path":"retry.ts","branch":"T12"}')
    const editor = page.locator('[data-kind="file"] .cm-content').last()
    await expect(editor).toBeVisible()
    await editor.click()
    await page.keyboard.insertText("Alice keeps delivery idempotent")
    await expect(page.getByText("Saved to the machine", { exact: true }).last()).toBeVisible()
    await page.reload()
    await expect.poll(() => editorText(editor)).toBe("Alice keeps delivery idempotent")
    expect(host.text()).toBe("Alice keeps delivery idempotent")
    await expect(page.getByRole("button", { name: "Reapply", exact: true })).toHaveCount(0)
    await expect(page.getByTestId("composer-input")).toBeEditable()
  } finally { host.dispose() }
})

for (const refusal of ["newer format", "corrupt header"]) {
  test(`C-DUR-05: ${refusal} without a receipt retains unsaved edits across reload`, async ({ page }) => {
    const host = fileCoeditFixture()
    try {
      host.acknowledge(false)
      await host.install(page, "Alice")
      await page.goto("/")
      await say(page, '/file {"path":"retry.ts","branch":"T12"}')
      const editor = page.locator('[data-kind="file"] .cm-content').last()
      await expect(editor).toBeVisible()
      await editor.click()
      await page.keyboard.insertText("Ben keeps retries bounded")
      await expect.poll(() => host.text()).toBe("Ben keeps retries bounded")
      await expect(page.getByText("Saving…", { exact: true }).last()).toBeVisible()
      for (let restart = 0; restart < 2; restart++) {
        await page.reload()
        await expect(page.getByRole("button", { name: "Reapply", exact: true }).last()).toBeVisible()
        await expect(page.locator('[data-tone="attention"]').last()).toContainText("Ben keeps retries bounded")
        await expect(page.getByText("Saved to the machine", { exact: true })).toHaveCount(0)
        await expect(page.getByTestId("composer-input")).toBeEditable()
      }
    } finally { host.dispose() }
  })
}
