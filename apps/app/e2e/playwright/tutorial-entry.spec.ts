import { expect, test } from "./browserTest"

test.use({ contextOptions: { reducedMotion: "reduce" } })

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const host = window as any
    host.SpeechRecognition = class {
      onresult: any; onerror: any; onend: any
      start() { host.dictation = this }
      stop() { this.onend?.() }
      abort() { host.dictationAborted = true }
    }
  })
  await page.goto("/")
  await expect(page.getByRole("button", { name: "Mode: Normal", exact: true })).toBeVisible()
  await page.keyboard.press("m")
  await page.getByRole("menuitemradio", { name: "Dictation", exact: true }).click()
  await expect(page.getByRole("button", { name: "Mode: Dictation", exact: true })).toBeVisible()
  await expect(page.getByTestId("composer-input")).toBeHidden()
  await page.keyboard.press("Meta+k")
  await expect.poll(() => page.evaluate(() => !!(window as any).dictation)).toBe(true)
})

test("dictation opens chat, appends recognized speech, and Escape releases the microphone", async ({ page }) => {
  const input = page.getByTestId("composer-input")
  await input.fill("Please check")
  await page.evaluate(() => (window as any).dictation.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: "the issue" } }] }))
  await expect(input).toHaveValue("Please check the issue")
  await input.press("Escape")
  // Capture owns the first Escape; the next closes Chat and its root palette.
  await expect.poll(() => page.evaluate(() => (window as any).dictationAborted)).toBe(true)
  await expect(input).toBeFocused()
  await expect(input).toHaveValue("Please check the issue")
  await expect(input).toHaveAttribute("aria-expanded", "true")
  await input.press("Escape")
  await expect(input).toBeHidden()
  await expect(page.getByRole("button", { name: "Mode: Dictation", exact: true })).toBeVisible()
})

test("the keyboard reaches Mode to stop dictation without closing Chat", async ({ page }) => {
  const input = page.getByTestId("composer-input")
  await input.fill("Keep this draft")
  await input.press("Tab")
  await expect(page.getByRole("button", { name: "Queue", exact: true })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByTestId("composer-send")).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("button", { name: "Chat", exact: true })).toBeFocused()
  await page.keyboard.press("Tab")
  await expect(page.getByRole("button", { name: "Mode: Dictation", exact: true })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect(page.getByRole("menuitemradio", { name: "Dictation", exact: true })).toBeFocused()
  await page.keyboard.press("Home")
  await expect(page.getByRole("menuitemradio", { name: "Normal", exact: true })).toBeFocused()
  await page.keyboard.press("Enter")
  await expect.poll(() => page.evaluate(() => (window as any).dictationAborted)).toBe(true)
  await expect(page.getByRole("button", { name: "Mode: Normal", exact: true })).toBeFocused()
  await expect(input).toBeVisible()
  await expect(input).toHaveValue("Keep this draft")
})
