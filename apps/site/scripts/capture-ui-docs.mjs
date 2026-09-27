#!/usr/bin/env node
/**
 * Capture the public app through its UI. No login, test data, or write actions.
 *
 *   node scripts/capture-ui-docs.mjs [screen ...]
 *
 * Each screen opens one surface and saves that card or palette, so the shot
 * does not depend on whatever else the home shows. `home` saves the whole
 * page and requires the app home: the question, the composer, and the four
 * app tiles the repository's `.smithers/home.json` declares.
 */
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("playwright")
const output = fileURLToPath(new URL("../public/images/app/", import.meta.url))
const origin = process.env.DOCS_APP_ORIGIN ?? "https://smithers.sh"
const repo = "smithersai/smithers"
const url = `${origin.replace(/\/$/, "")}/${repo}`
const selected = new Set(process.argv.slice(2))
const browser = await chromium.launch({ headless: true })
mkdirSync(output, { recursive: true })
const records = []

const openChat = async (page) => {
  const input = page.getByTestId("composer-input")
  if (!(await input.isVisible())) await page.getByRole("button", { name: "Chat", exact: true }).click()
  await input.waitFor()
  return input
}
const send = async (page, command) => {
  const input = await openChat(page)
  await input.fill(command)
  await input.press("Enter")
}
/** The newest card of a kind, once it is on screen. */
const card = async (page, kind) => {
  const found = page.locator(`.smithers-card[data-kind="${kind}"]`).last()
  await found.waitFor()
  await found.scrollIntoViewIfNeeded()
  return found
}
/** The card a sidebar door opens. */
const door = async (page, name, kind) => {
  await page.getByRole("button", { name, exact: true }).click()
  return card(page, kind)
}
const palette = async (page, text) => {
  const input = await openChat(page)
  await input.fill(text)
  const list = page.getByRole("listbox", { name: "Search palette" })
  await list.waitFor()
  return list
}

const screens = {
  home: async (page) => {
    await page.getByRole("heading", { name: "What should we work on?" }).waitFor()
    for (const title of ["Fix an issue", "Review a PR", "Ask the codebase", "Run it every night"]) {
      await page.getByTestId("app-tile").filter({ hasText: title }).waitFor()
    }
    await page.getByTestId("composer-input").waitFor()
    return undefined
  },
  file: async (page) => {
    await send(page, "/files.read CONTRIBUTING.md")
    return card(page, "file")
  },
  wiki: (page) => door(page, "Wiki", "world"),
  dispatcher: (page) => door(page, "Dispatcher", "trigger-list"),
  account: async (page) => {
    // Signed out, Account answers in the conversation with the sign-in step.
    await page.getByRole("button", { name: "Account", exact: true }).click()
    const reply = page.locator('.smithers-chat-message[data-role="assistant"]', { hasText: "Sign in with GitHub" }).last()
    await reply.waitFor()
    return reply
  },
  search: (page) => palette(page, "?"),
  slash: (page) => palette(page, "/review")
}

try {
  for (const [name, action] of Object.entries(screens)) {
    if (selected.size && !selected.has(name)) continue
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: "light" })
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    try {
      await page.goto(url)
      await page.getByRole("button", { name: "Chat", exact: true }).waitFor()
      // Opening and closing Chat once retires the first-run keyboard hint.
      await (await openChat(page)).press("Escape")
      const target = await action(page)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(500)
      const path = `${output}${name}.png`
      let size = { width: 1440, height: 1000 }
      if (target === undefined) await page.screenshot({ path, animations: "disabled" })
      else {
        await target.screenshot({ path, animations: "disabled" })
        const box = await target.boundingBox()
        size = { width: Math.round(box.width), height: Math.round(box.height) }
      }
      records.push({ file: `${name}.png`, source: url, capturedAt: new Date().toISOString(), ...size, data: "Live public app, signed out" })
      console.log(`captured ${name}`)
    } catch (error) {
      console.error(`${name}: ${error.message}\n${(await page.locator("body").innerText()).slice(-2200)}`)
      process.exitCode = 1
    } finally {
      await context.close()
    }
  }
  const existing = existsSync(`${output}captures.json`) ? JSON.parse(readFileSync(`${output}captures.json`, "utf8")) : []
  const files = new Map(existing.map((entry) => [entry.file, entry]))
  for (const record of records) files.set(record.file, record)
  writeFileSync(`${output}captures.json`, JSON.stringify([...files.values()].sort((a, b) => a.file.localeCompare(b.file)), null, 2) + "\n")
} finally {
  await browser.close()
}
