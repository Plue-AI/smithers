import type { Locator, Page } from "@playwright/test"
import { assertKeyboardFocus, assertKeyboardOnly, installKeyboardOnly, installNativeKeyboardOnly, recordKeyboardFocus, type KeyboardFocus, type KeyboardInput } from "./keyboardOnly"

/** Reach controls through actual Tab input; locator evaluation only observes focus. */
export function keyboardJourneyInput(page: Page, origin: string, capture?: () => Promise<void>) {
  const inputs: KeyboardInput[] = []
  const focus: KeyboardFocus[] = []
  installKeyboardOnly(page.context(), origin, inputs)
  let nativeReady: Promise<void> | undefined
  const ready = () => nativeReady ??= installNativeKeyboardOnly(page.context(), origin, inputs)
  const observe = async () => { await ready(); await recordKeyboardFocus(page, focus); await capture?.() }
  const reach = async (target: Locator) => {
    await ready()
    await target.waitFor({ state: "visible" })
    for (let count = 0; count < 200; count++) {
      if (await target.evaluate(element => element === document.activeElement)) { await capture?.(); return }
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
    const options = await target.locator("option").allTextContents()
    const index = options.findIndex(value => value.trim() === label)
    if (index < 0) throw new Error("C-UI-01 required option is absent")
    // Native select typeahead works on macOS, where Home does not select the first option.
    await page.keyboard.type(label)
    const selected = await target.locator("option:checked").textContent()
    if (selected?.trim() !== label) throw new Error("C-UI-01 keyboard option selection failed")
    await page.keyboard.press("Tab")
    await observe()
  }
  const command = async (text: string) => {
    const input = page.getByTestId("composer-input")
    if (!await input.isVisible() || await input.evaluate(element => element.closest('[inert], [aria-hidden="true"]') !== null)) await page.keyboard.press("ControlOrMeta+k")
    await enter(input, text)
    await page.keyboard.press("Enter")
    await observe()
  }
  return { command, activate, enter, select, reach, observe, ready, snapshot: () => ({ inputs, focus }), finish: () => {
    assertKeyboardOnly(inputs)
    assertKeyboardFocus(focus)
    return { inputs, focus }
  } }
}

const journeys = new WeakMap<Page, ReturnType<typeof keyboardJourneyInput>>()
export function registerKeyboardJourney(page: Page, origin: string, capture?: () => Promise<void>) {
  const input = keyboardJourneyInput(page, origin, capture)
  journeys.set(page, input)
  return input
}
export const keyboardInputFor = (page: Page) => journeys.get(page)

/** Explicit UI doors shared by pointer and keyboard runs; the guard still rejects
 * direct pointer/fill/focus calls in a keyboard run. */
export async function journeyActivate(target: Locator): Promise<void> {
  const input = keyboardInputFor(target.page())
  if (input) await input.activate(target)
  else await target.click()
}
export async function journeyReach(target: Locator): Promise<void> {
  const input = keyboardInputFor(target.page())
  if (input) await input.reach(target)
  else await target.focus()
}
export async function journeyEnter(target: Locator, text: string): Promise<void> {
  const input = keyboardInputFor(target.page())
  if (input) await input.enter(target, text)
  else await target.fill(text)
}
export async function journeyChecked(target: Locator, checked: boolean): Promise<void> {
  const input = keyboardInputFor(target.page())
  if (!input) { await target.setChecked(checked); return }
  await input.reach(target)
  if (await target.isChecked() !== checked) await target.page().keyboard.press("Space")
  if (await target.isChecked() !== checked) throw new Error("C-UI-01 checkbox activation failed")
  await input.observe()
}
export async function journeySelect(target: Locator, label: string): Promise<void> {
  const input = keyboardInputFor(target.page())
  if (input) await input.select(target, label)
  else await target.selectOption({ label })
}
