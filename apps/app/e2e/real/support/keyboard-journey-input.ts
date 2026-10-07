import type { Locator, Page } from "@playwright/test"
import { assertKeyboardFocus, assertKeyboardOnly, installKeyboardOnly, recordKeyboardFocus, type KeyboardFocus, type KeyboardInput } from "./keyboardOnly"

/** Reach controls through actual Tab input; locator evaluation only observes focus. */
export function keyboardJourneyInput(page: Page, origin: string) {
  const inputs: KeyboardInput[] = []
  const focus: KeyboardFocus[] = []
  installKeyboardOnly(page.context(), origin, inputs)
  const observe = () => recordKeyboardFocus(page, focus)
  const reach = async (target: Locator) => {
    await target.waitFor({ state: "visible" })
    for (let count = 0; count < 200; count++) {
      if (await target.evaluate(element => element === document.activeElement)) return
      await page.keyboard.press(process.platform === "darwin" && page.context().browser()?.browserType().name() === "webkit" ? "Alt+Tab" : "Tab")
    }
    throw new Error("C-UI-01 required control is unreachable by Tab")
  }
  const activate = async (target: Locator) => {
    await reach(target)
    await page.keyboard.press("Enter")
    await observe()
  }
  const enter = async (target: Locator, text: string) => {
    await reach(target)
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A")
    await page.keyboard.type(text)
    await observe()
  }
  const select = async (target: Locator, label: string) => {
    await reach(target)
    await page.keyboard.press("Home")
    const options = await target.locator("option").allTextContents()
    const index = options.findIndex(value => value.trim() === label)
    if (index < 0) throw new Error("C-UI-01 required option is absent")
    for (let count = 0; count < index; count++) await page.keyboard.press("ArrowDown")
    const selected = await target.locator("option:checked").textContent()
    if (selected?.trim() !== label) throw new Error("C-UI-01 keyboard option selection failed")
    await page.keyboard.press("Tab")
    await observe()
  }
  const command = async (text: string) => {
    const input = page.getByTestId("composer-input")
    if (!await input.isVisible()) await page.keyboard.press("Escape")
    await enter(input, text)
    await page.keyboard.press("Enter")
    await observe()
  }
  return { command, activate, enter, select, observe, snapshot: () => ({ inputs, focus }), finish: () => {
    assertKeyboardOnly(inputs)
    assertKeyboardFocus(focus)
    return { inputs, focus }
  } }
}
