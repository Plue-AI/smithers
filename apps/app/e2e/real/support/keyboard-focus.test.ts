import { expect, test } from "bun:test"
import { chromium, webkit } from "@playwright/test"
import { assertKeyboardFocus, recordKeyboardFocus, type KeyboardFocus } from "./keyboardOnly"

// Actual browser observations; supplemental coverage, not a release journey.
for (const engine of [chromium, webkit]) test(`${engine.name()} focus evidence rejects body, invisible/wrong rings and focus loss after a live replacement`, async () => {
  const browser = await engine.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.setContent(`<style>
      :root { --ring-border: rgb(12, 34, 56); }
      button:focus-visible { outline: 2px solid var(--ring-border); }
      input:focus-visible { outline: none; }
      textarea:focus-visible { outline: 2px solid red; }
    </style><button>Secret label</button><input value="secret value"><textarea></textarea>`)
    const log: KeyboardFocus[] = []
    expect(() => assertKeyboardFocus(log)).toThrow("no focus observations")
    await expect(recordKeyboardFocus(page, log)).rejects.toThrow("focus is missing")
    await page.keyboard.press(engine.name() === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab")
    await recordKeyboardFocus(page, log)
    expect(log.at(-1)).toMatchObject({ element: "button", focusVisible: true, outlineWidth: 2, ringMatches: true })
    await page.keyboard.press(engine.name() === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab")
    await expect(recordKeyboardFocus(page, log)).rejects.toThrow("focus is missing")
    await page.keyboard.press(engine.name() === "webkit" && process.platform === "darwin" ? "Alt+Tab" : "Tab")
    await expect(recordKeyboardFocus(page, log)).rejects.toThrow("focus is missing")
    expect(log.at(-1)?.ringMatches).toBe(false)
    await page.keyboard.press(engine.name() === "webkit" && process.platform === "darwin" ? "Alt+Shift+Tab" : "Shift+Tab")
    await page.keyboard.press(engine.name() === "webkit" && process.platform === "darwin" ? "Alt+Shift+Tab" : "Shift+Tab")
    await recordKeyboardFocus(page, log)
    await page.evaluate(() => document.querySelector("button")!.replaceWith(document.createElement("button")))
    await expect(recordKeyboardFocus(page, log)).rejects.toThrow("focus is missing")
    expect(log.at(-1)?.element).toBe("body")
    expect(() => assertKeyboardFocus(log)).toThrow("focus is missing")
    expect(JSON.stringify(log)).not.toContain("secret")
    expect(JSON.stringify(log)).not.toContain("Secret")
    await page.close()
  } finally { await browser.close() }
}, 30_000)
