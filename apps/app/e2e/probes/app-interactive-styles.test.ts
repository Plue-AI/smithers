import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { chromium, type Browser, type Page } from "playwright"
import { smithersUiCss } from "@smthrs/ui"
import { PALETTES } from "../../src/mainview/state/AppState"

const read = (path: string) => readFileSync(new URL(`../../src/mainview/${path}`, import.meta.url), "utf8")
const css = ["tokens", "base", "chat", "cards", "github-cards", "surfaces", "chrome"]
  .map(name => read(`styles/${name}.css`)).join("\n") + read("SessionShell.css") + smithersUiCss
let browser: Browser
let page: Page

beforeAll(async () => {
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ reducedMotion: "reduce" })
  await context.route("**/*", route => route.abort())
  page = await context.newPage()
})
afterAll(async () => { await browser?.close() })

// Source-backed fixtures exercise the composed cascade in a layout engine.
// They never boot a host, contact a service or read a saved browser profile.
const content = (body: string) => page.setContent(`<style>${css}</style>${body}`)
const contrast = (selector: string, outline = false) => page.locator(selector).evaluate((element, outline) => {
  const style = getComputedStyle(element)
  const canvas = document.createElement("canvas")
  canvas.width = canvas.height = 1
  const context = canvas.getContext("2d")!
  const luminance = (color: string) => {
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = color
    context.fillRect(0, 0, 1, 1)
    return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3)
      .map(value => value / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
      .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index]!, 0)
  }
  const foreground = outline ? style.outlineColor : style.color
  const background = style.backgroundColor
  const values = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
  return { foreground, background, ratio: (values[1]! + 0.05) / (values[0]! + 0.05),
    focusVisible: element.matches(":focus-visible"), outlineWidth: parseFloat(style.outlineWidth) }
}, outline)

test("primary actions and Send remain legible in every palette, including hover and press", async () => {
  await content(`<div class="app-shell"><section style="display:flex;flex-direction:column;gap:16px;align-items:flex-start;padding:32px">
    <button id="primary" class="sui-button sui-button-default">Approve</button>
    <button id="solid" class="sui-button sui-button-solid">Start</button>
    <button id="signin" class="chrome-action" data-flow="auth.sign-in">Sign in with GitHub</button>
    <div class="smithers-composer"><button id="send" class="sui-button sui-button-solid sui-button-icon-size sui-chat-composer-send" aria-label="Send">↑</button></div>
    <button id="release" class="control-focus-release" data-control-focus-release style="position:static">Release control</button>
  </section></div>`)
  const failures: string[] = []
  for (const palette of PALETTES) for (const theme of ["light", "dark"]) {
    await page.evaluate(({ palette, theme }) => { document.documentElement.dataset.palette = palette; document.documentElement.dataset.theme = theme }, { palette, theme })
    for (const id of ["primary", "solid", "signin", "send"]) {
      const selector = `#${id}`
      await page.mouse.move(0, 0)
      for (const state of ["rest", "hover", "active"]) {
        if (state === "hover") await page.locator(selector).hover()
        if (state === "active") await page.mouse.down()
        try {
          const measured = await contrast(selector)
          if (measured.ratio < 4.5) failures.push(`${palette}/${theme} ${id}/${state}: ${JSON.stringify(measured)}`)
        } finally { if (state === "active") await page.mouse.up() }
      }
    }
    await page.keyboard.press("Tab")
    await page.locator("#release").focus()
    const focus = await contrast("#release", true)
    expect(focus.focusVisible).toBe(true)
    expect(focus.outlineWidth).toBeGreaterThanOrEqual(2)
    if (focus.ratio < 3) failures.push(`${palette}/${theme} release/focus: ${JSON.stringify(focus)}`)
  }
  expect(failures).toEqual([])
}, 30_000)
