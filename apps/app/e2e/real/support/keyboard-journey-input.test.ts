import { test, expect } from "bun:test"
import { chromium } from "@playwright/test"
import { keyboardJourneyInput } from "./keyboard-journey-input"
import { installReleasedHost } from "./release-install"

test("keyboard journey traversal refuses a page outside the declared install", async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    // Supplemental DOM proof only. No mocked install or passing journey receipt.
    await page.goto("data:text/html,keyboard")
    await page.setContent(`<style>:root{--ring-border:rgb(12,34,56)}:focus-visible{outline:2px solid var(--ring-border)}</style>
      <input aria-label="Title"><select aria-label="Place"><option>Insert</option><option>Append</option></select>
      <button type="button">Commit</button>`)
    // Guard refuses data URLs: tests may not manufacture an app origin for qualification.
    const keys = keyboardJourneyInput(page, "http://127.0.0.1:47400")
    await expect(keys.enter(page.getByLabel("Title"), "First TODO")).rejects.toThrow("keyboard guard refused")
    expect(() => keys.finish()).toThrow("refused input")
  } finally { await browser.close() }
}, 30_000)

test("released installation refuses this Linux host before Homebrew or launcher execution", async () => {
  if (process.platform === "darwin") return
  await expect(installReleasedHost({} as Parameters<typeof installReleasedHost>[0])).rejects.toThrow("release_host_required")
})
