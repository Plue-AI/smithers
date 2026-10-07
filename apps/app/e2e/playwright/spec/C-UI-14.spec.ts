import { expect, test } from "../browserTest"
import { say } from "./j1-fixtures"
import { editorText, fileCoeditFixture } from "./file-coedit-fixture"

// Browser composition proof. C-UI-14's five-minute reference-host/second-Mac
// latency campaign remains a separate receipt; this relay cannot qualify it.
const carets = process.env.VITE_SMITHERS_REMOTE_CARETS === "1"
test(`C-UI-14: mounted member carets and selections with the flag ${carets ? "on" : "off"}`, async ({ page }) => {
  const host = fileCoeditFixture("hello")
  const context = await page.context().browser()!.newContext()
  const other = await context.newPage()
  try {
    await host.install(page, "Alice")
    await host.install(other, "Bob")
    for (const member of [page, other]) {
      await member.goto("/")
      await say(member, '/file {"path":"retry.ts","branch":"T12"}')
      await expect(member.locator('[data-kind="file"][data-mode="live"]').last()).toBeVisible()
    }
    const editors = [page, other].map(member => member.locator('[data-kind="file"] .cm-content').last())
    for (const [index, member] of [page, other].entries()) {
      await member.bringToFront()
      await editors[index]!.click()
      await member.keyboard.press("Control+End")
      await member.keyboard.insertText(String(index))
      await member.keyboard.press("Shift+ArrowLeft")
      const observer = [other, page][index]!
      await expect.poll(() => editorText(editors[1 - index]!)).toBe(index === 0 ? "hello0" : "hello01")
      const file = observer.locator('[data-kind="file"]').last()
      await expect(file.locator('.code-name-flag')).toContainText(index === 0 ? "Alice" : "Bob")
      if (carets) {
        await expect(file.locator('.cm-ySelectionCaret')).toHaveCount(1)
        await expect(file.locator('.cm-ySelection')).toHaveCount(1)
        await expect(file.locator('.cm-ySelectionInfo')).toHaveText(index === 0 ? "Alice" : "Bob")
        const colours = await file.evaluate(node => ({
          caret: getComputedStyle(node.querySelector('.cm-ySelectionCaret')!).borderLeftColor,
          flag: getComputedStyle(node.querySelector('.code-name-flag')!).borderLeftColor,
          selection: getComputedStyle(node.querySelector('.cm-ySelection')!).backgroundColor
        }))
        expect(colours.caret).toBe(colours.flag)
        expect(colours.selection).not.toBe('rgba(0, 0, 0, 0)')
      } else await expect(file.locator('.cm-ySelectionCaret, .cm-ySelection')).toHaveCount(0)
      await expect(observer.getByTestId('composer-input')).toBeEditable()
    }
  } finally { await context.close(); host.dispose() }
})
