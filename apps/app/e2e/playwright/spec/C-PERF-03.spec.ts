import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { editorText, fileCoeditFixture } from "./file-coedit-fixture"

// 200-marker browser contract. This fake-host run is not LAN or disk qualification.
test("C-PERF-03: 200 markers converge through mounted File cards", async ({ page }) => {
  test.setTimeout(180_000)
  const host = fileCoeditFixture()
  const context = await page.context().browser()!.newContext()
  const viewer = await context.newPage()
  try {
    await host.install(page, "Alice"); await host.install(viewer, "Bob")
    for (const tab of [page, viewer]) {
      await tab.goto("/")
      await say(tab, '/file {"path":"retry.ts","branch":"T12"}')
      await expect(tab.locator('[data-kind="file"][data-mode="live"]').last()).toBeVisible()
    }
    const editor = page.locator('[data-kind="file"] .cm-content').last()
    const remote = viewer.locator('[data-kind="file"] .cm-content').last()
    await page.bringToFront(); await editor.click()
    let expected = ""
    for (let i = 0; i < 200; i++) {
      const marker = `m${String(i).padStart(5, "0")}`
      expected += marker
      await page.keyboard.insertText(marker)
      await expect.poll(() => editorText(remote)).toBe(expected)
    }
    await expect(page.getByText("Saved to the machine", { exact: true }).last()).toBeVisible()
    await expect.poll(() => editorText(editor)).toBe(expected)
    expect(host.text()).toBe(expected)
  } finally { await context.close(); host.dispose() }
})
