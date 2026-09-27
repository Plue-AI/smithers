import { controlTabKey, expect, test } from "./browserTest"

test("native control traversal visits links and editors in both directions and skips disabled controls", async ({ page }) => {
  await page.setContent(`
    <button id="first">First</button>
    <button id="disabled" disabled>Disabled</button>
    <a id="link" href="#">Link</a>
    <input id="input" aria-label="Input">
    <textarea id="area" aria-label="Text"></textarea>
    <div id="editable" contenteditable="true">Edit</div>
    <button id="last">Last</button>
  `)
  for (const id of ["first", "link", "input", "area", "editable", "last"]) {
    await page.keyboard.press(controlTabKey(page))
    await expect(page.locator(`#${id}`)).toBeFocused()
  }
  for (const id of ["editable", "area", "input", "link", "first"]) {
    await page.keyboard.press(controlTabKey(page, true))
    await expect(page.locator(`#${id}`)).toBeFocused()
  }
})
