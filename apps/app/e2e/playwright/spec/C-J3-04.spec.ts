import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { editorText, fileCoeditFixture } from "./file-coedit-fixture"

// Browser composition against a test-only host. Second-Mac/disk/restart proof is separate.
test("C-J3-04: two mounted File cards co-edit through the production browser channel", async ({ page }) => {
  const host = fileCoeditFixture()
  const viewerContext = await page.context().browser()!.newContext()
  const viewer = await viewerContext.newPage()
  try {
    await host.install(page, "Alice"); await host.install(viewer, "Bob")
    for (const tab of [page, viewer]) {
      await tab.goto("/")
      await say(tab, '/file {"path":"retry.ts","branch":"T12"}')
      await expect(tab.locator('[data-kind="file"][data-mode="live"]').last()).toBeVisible()
    }
    const a = page.locator('[data-kind="file"] .cm-content').last()
    const b = viewer.locator('[data-kind="file"] .cm-content').last()
    await page.bringToFront(); await a.click(); await page.keyboard.type("Alice keeps retries bounded")
    await expect.poll(() => editorText(b)).toBe("Alice keeps retries bounded")
    await viewer.bringToFront(); await b.click(); await viewer.keyboard.press("Control+End"); await viewer.keyboard.type("; Bob keeps delivery idempotent")
    await expect.poll(() => editorText(a)).toBe("Alice keeps retries bounded; Bob keeps delivery idempotent")
    await expect(page.locator('.cm-ySelectionCaret').last()).toBeVisible()
    await expect(page.locator('.code-author').first()).toBeVisible()
    await expect(viewer.getByText("Saved to the machine", { exact: true }).last()).toBeVisible()
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
    expect(host.text()).toBe("Alice keeps retries bounded; Bob keeps delivery idempotent")
    await expect(page.getByTestId("composer-input")).toBeEditable()
  } finally { await viewerContext.close(); host.dispose() }
})
