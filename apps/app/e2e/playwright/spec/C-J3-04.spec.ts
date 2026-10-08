import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { editorText, fileCoeditFixture } from "./file-coedit-fixture"

test("C-J3-04: 1,000 interleaved member edits converge in both mounted editors", async ({ page }) => {
  test.setTimeout(180_000)
  const host = fileCoeditFixture()
  const context = await page.context().browser()!.newContext()
  const viewer = await context.newPage()
  try {
    await host.install(page, "Alice")
    await host.install(viewer, "Bob")
    for (const tab of [page, viewer]) {
      await tab.goto("/")
      await say(tab, '/file {"path":"retry.ts","branch":"T12"}')
      await expect(tab.locator('[data-kind="file"][data-mode="live"]').last()).toBeVisible()
    }
    const editors = [page, viewer].map(tab => tab.locator('[data-kind="file"] .cm-content').last())
    let expected = ""
    for (let turn = 0; turn < 100; turn++) {
      const index = turn % 2
      const tab = [page, viewer][index]!
      await tab.bringToFront()
      await editors[index]!.click()
      await tab.keyboard.press("Control+End")
      for (let edit = 0; edit < 10; edit++) {
        // Keep the line within CodeMirror's rendered viewport. Long lines
        // elide off-screen text, so DOM text is not a full-document oracle.
        const marker = String.fromCharCode((index === 0 ? 65 : 97) + edit)
        expected += marker
        await tab.keyboard.insertText(marker)
      }
      await expect.poll(() => editorText(editors[1 - index]!), { timeout: 1_000 }).toBe(expected)
    }
    for (const editor of editors) expect(await editorText(editor)).toBe(expected)
    expect(host.text()).toBe(expected)
    for (const tab of [page, viewer]) {
      await expect(tab.getByText("Saved to the machine", { exact: true }).last()).toBeVisible()
      await expect(tab.locator('.code-author').first()).toBeVisible()
      await expect(tab.getByTestId("composer-input")).toBeEditable()
    }
  } finally { await context.close(); host.dispose() }
})

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
    // Remote carets ship off until the two-Mac C-UI-14 receipt; line flags stay live.
    if (process.env.VITE_SMITHERS_REMOTE_CARETS === "1") await expect(page.locator('.cm-ySelectionCaret').last()).toBeVisible()
    else await expect(page.locator('.cm-ySelectionCaret')).toHaveCount(0)
    await expect(page.locator('.code-name-flag').filter({ hasText: "Bob" })).toBeVisible()
    await expect(page.locator('.code-author').first()).toBeVisible()
    await expect(viewer.getByText("Saved to the machine", { exact: true }).last()).toBeVisible()
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0)
    expect(host.text()).toBe("Alice keeps retries bounded; Bob keeps delivery idempotent")
    await expect(page.getByTestId("composer-input")).toBeEditable()
  } finally { await viewerContext.close(); host.dispose() }
})

test("C-J3-04: reload retains pending text and Reapply waits for a save receipt", async ({ page }) => {
  const host = fileCoeditFixture()
  try {
    host.acknowledge(false)
    await host.install(page, "Alice")
    await page.goto("/")
    await say(page, '/file {"path":"retry.ts","branch":"T12"}')
    await expect(page.locator('[data-kind="file"][data-mode="live"]').last()).toBeVisible()
    const editor = page.locator('[data-kind="file"] .cm-content').last()
    await editor.click(); await page.keyboard.insertText("retained after reload")
    await expect.poll(() => host.text()).toBe("retained after reload")
    await expect(page.getByText("Saving…", { exact: true }).last()).toBeVisible()
    await page.reload()
    await expect(page.getByRole("button", { name: "Reapply", exact: true }).last()).toBeVisible()
    await expect(page.locator('[data-tone="attention"]').last()).toContainText("retained after reload")
    host.acknowledge(true)
    await page.getByRole("button", { name: "Reapply", exact: true }).last().press("Enter")
    await expect(page.getByText("Saved to the machine", { exact: true }).last()).toBeVisible()
    await expect.poll(() => editorText(editor)).toBe("retained after reload")
    expect(host.text()).toBe("retained after reload")
    await expect(page.getByRole("button", { name: "Reapply", exact: true })).toHaveCount(0)
  } finally { host.dispose() }
})

test("C-J3-04: an overlapping recovery compares current and retained bytes", async ({ page }) => {
  const host = fileCoeditFixture("hello world")
  try {
    host.acknowledge(false)
    await host.install(page, "Alice")
    await page.goto("/")
    await say(page, '/file {"path":"retry.ts","branch":"T12"}')
    await expect(page.locator('[data-kind="file"][data-mode="live"]').last()).toBeVisible()
    const editor = page.locator('[data-kind="file"] .cm-content').last()
    await editor.click(); await page.keyboard.press("Control+End")
    for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace")
    await page.keyboard.insertText("friend")
    await expect.poll(() => host.text()).toBe("hello friend")
    host.replace("hello changed")
    await page.reload()
    await page.getByRole("button", { name: "Reapply", exact: true }).last().press("Enter")
    const comparison = page.getByRole("group", { name: "Live and outside versions", exact: true }).last()
    await expect(comparison.locator('.code-file-current')).toContainText("hello changed")
    await expect(comparison.locator('.code-file-outside')).toContainText("hello friend")
    expect(host.text()).toBe("hello changed")
    await expect(page.getByRole("button", { name: "Copy", exact: true }).last()).toBeVisible()
  } finally { host.dispose() }
})
