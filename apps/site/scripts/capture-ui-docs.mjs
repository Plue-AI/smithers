#!/usr/bin/env node
/** Capture the public app through its UI. No login, test data, or write actions. */
import { createRequire } from "node:module"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const { chromium } = createRequire(new URL("../../app/package.json", import.meta.url))("playwright")
const output = fileURLToPath(new URL("../public/images/app/", import.meta.url))
const origin = process.env.DOCS_APP_ORIGIN ?? "https://smithers.sh"
const url = `${origin.replace(/\/$/, "")}/smithersai/smithers`
const selected = new Set(process.argv.slice(2))
const browser = await chromium.launch({ headless: true })
mkdirSync(output, { recursive: true })
const records = []
const send = async (page, command) => {
  await page.getByTestId("composer-input").fill(command)
  await page.getByTestId("composer-send").click()
}
const explore = async (page) => {
  await page.getByRole("button", { name: "just exploring", exact: true }).click()
  await page.getByRole("button", { name: "CONTRIBUTING.md", exact: true }).waitFor()
}
const screens = {
  home: async () => {},
  explore,
  file: async (page) => {
    await explore(page)
    await page.getByRole("button", { name: "CONTRIBUTING.md", exact: true }).click()
    const card = page.locator('[data-kind="file"]').last()
    await card.waitFor()
    await card.getByRole("button", { name: "Maximize card", exact: true }).click()
  },
  wiki: async (page) => {
    await page.getByRole("button", { name: "Wiki", exact: true }).click()
    await page.getByRole("button", { name: "New note", exact: true }).waitFor()
    await page.getByText("Loading editor…", { exact: true }).waitFor({ state: "hidden" })
  },
  dispatcher: async (page) => {
    await page.getByRole("button", { name: "Dispatcher", exact: true }).click()
    await page.getByRole("button", { name: "Register a rule", exact: true }).waitFor()
  },
  account: async (page) => {
    await page.getByRole("button", { name: "Account", exact: true }).click()
    await page.getByText(/One step connects GitHub/).waitFor()
  },
  search: async (page) => {
    await page.getByTestId("composer-input").focus()
    await page.keyboard.press("Meta+k")
    await page.getByTestId("composer-input").fill("?")
    await page.getByRole("listbox", { name: "Search palette" }).waitFor()
  },
  slash: async (page) => {
    await page.getByTestId("composer-input").fill("/review")
    await page.getByRole("listbox", { name: "Search palette" }).waitFor()
  }
}
try {
  for (const [name, action] of Object.entries(screens)) {
    if (selected.size && !selected.has(name)) continue
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, colorScheme: "light" })
    const page = await context.newPage()
    page.setDefaultTimeout(20_000)
    try {
      await page.goto(url)
      await page.getByRole("button", { name: "/review", exact: true }).waitFor()
      await page.getByRole("button", { name: "just exploring", exact: true }).waitFor()
      await action(page)
      await page.evaluate(() => document.fonts.ready)
      await page.waitForTimeout(500)
      await page.screenshot({ path: `${output}${name}.png`, animations: "disabled" })
      records.push({ file: `${name}.png`, source: url, capturedAt: new Date().toISOString(), width: 1440, height: 1000, data: "Live public app, signed out" })
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
