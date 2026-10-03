#!/usr/bin/env node
/*
 * Copy lint for the mock's product UI (engineering's copy rules, 2026-10-02):
 * no banned internal words in visible strings, and card body lines of 12 words
 * or fewer. It visits every step of every journey and reads the rendered app
 * screens, skipping what people or GitHub wrote (code, terminals, prompts,
 * issue and chat text) and the review harness. Prints each distinct offender
 * once, with the first step it appears at.
 * node .specs/design/mock/copy.mjs [journey-id ...] [--dist=dist]
 */
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const { chromium } = createRequire(join(resolve(HERE, "../../../apps/app"), "package.json"))("@playwright/test")
const args = process.argv.slice(2)
const dist = resolve(HERE, args.find(arg => arg.startsWith("--dist="))?.slice(7) ?? "dist")
const only = args.filter(arg => !arg.startsWith("--"))
const base = pathToFileURL(join(dist, "index.html")).href

/*
 * C-UI-02 R1, exactly spec §14.6b's terms: each one, its plural with s or es, or microVM, as a whole word in any
 * case; a boundary is any character that isn't a letter or a digit. Jev and forge joined §14.6b (product, 2026-10-02).
 */
const BANNED = /(?<![A-Za-z0-9])(workflow|thread|task|lane|box|workspace|mythical|sandbox|microVM|VM|seat|profile|jev|forge)(e?s)?(?![A-Za-z0-9])/i
const MAX_WORDS = 12

/* Runs in the page: visible product text per block, minus what people, agents' files or GitHub wrote. */
const collect = () => {
  const SKIP = [
    "code", "pre", "textarea", "input", "kbd", "svg",
    ".mvp-term", ".mvp-code", ".cm-editor", ".mvp-diff", ".mvp-comment p", ".mvp-prompt", ".mvp-quote",
    ".sui-chat-message", ".smithers-chat-message", ".mock-outside", "[data-frame=\"github\"]", "[data-copy=\"data\"]"
  ].join(",")
  const BLOCKS = "p, li, dd, dt, h1, h2, h3, h4, button, a, label, [role=\"option\"], .mvp-receipt-line, .mvp-failure-line, .mvp-indicator, .mvp-run-phase-title span"
  const out = []
  for (const screen of document.querySelectorAll("[data-frame]:not([data-frame=\"github\"])")) {
    for (const node of screen.querySelectorAll(BLOCKS)) {
      if (node.closest(SKIP) !== null) continue
      if (node.querySelector(BLOCKS) !== null && node.tagName !== "BUTTON") continue
      const style = getComputedStyle(node)
      if (style.visibility === "hidden" || style.display === "none" || node.getClientRects().length === 0) continue
      /* Quoted words inside a product line (a steer, a question, a file name) are data: drop them before counting. */
      const copy = node.cloneNode(true)
      for (const data of copy.querySelectorAll(SKIP)) data.remove()
      const text = (copy.textContent ?? "").replace(/\s+/g, " ").trim()
      if (text !== "") out.push({ text, inCard: node.closest(".smithers-card-body") !== null })
    }
    /* R1 also reads the words assistive technology speaks: aria-label, title and placeholder. */
    for (const node of screen.querySelectorAll("[aria-label], [title], [placeholder]")) {
      if (node.closest(SKIP) !== null && node.tagName !== "INPUT" && node.tagName !== "TEXTAREA") continue
      for (const name of ["aria-label", "title", "placeholder"]) {
        const value = node.getAttribute(name)
        if (value !== null && value.trim() !== "") out.push({ text: value.trim(), inCard: false, attribute: name })
      }
    }
  }
  return out
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(`${base}?still=1`)
const journeys = await page.evaluate(() => window.__MOCK__)
const banned = new Map()
const long = new Map()
for (const journey of journeys) {
  if (only.length > 0 && !only.includes(journey.id)) continue
  for (let i = 0; i <= journey.steps.length; i += 1) {
    await page.goto(`${base}?j=${journey.id}&s=${i}&still=1`)
    await page.waitForTimeout(80)
    for (const { text, inCard } of await page.evaluate(collect)) {
      const where = `${journey.id} s=${i}`
      const word = BANNED.exec(text)?.[0]
      if (word !== undefined && !banned.has(text)) banned.set(text, `${where} · "${word}"`)
      if (inCard && text.split(" ").length > MAX_WORDS && !long.has(text)) long.set(text, where)
    }
  }
}
await browser.close()
for (const [text, where] of banned) console.log(`banned  ${where}: ${text}`)
for (const [text, where] of long) console.log(`long    ${where} (${text.split(" ").length} words): ${text}`)
console.log(`${banned.size} banned, ${long.size} over ${MAX_WORDS} words`)
process.exit(banned.size === 0 ? 0 : 1)
