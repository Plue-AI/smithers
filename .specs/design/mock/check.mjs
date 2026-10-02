#!/usr/bin/env node
/*
 * Verify every journey step: the page renders the state before the step
 * without errors, and the step's pointer target exists on its viewer's
 * screen. node .specs/design/mock/check.mjs [journey-id ...] [--dist=dist]
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

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on("pageerror", error => errors.push(error.message))
page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
await page.goto(`${base}?still=1`)
const journeys = await page.evaluate(() => window.__MOCK__)
let failures = 0
for (const journey of journeys) {
  if (only.length > 0 && !only.includes(journey.id)) continue
  for (let i = 0; i <= journey.steps.length; i += 1) {
    errors.length = 0
    await page.goto(`${base}?j=${journey.id}&s=${i}&still=1`)
    await page.waitForTimeout(120)
    const step = journey.steps[i]
    if (step?.target) {
      const found = await page.evaluate(({ viewer, target }) => document.querySelector(`[data-frame="${viewer}"]`)?.querySelector(target) !== null && document.querySelector(`[data-frame="${viewer}"]`)?.querySelector(target) !== undefined, step)
      if (!found) { failures += 1; console.log(`✗ ${journey.id} step ${i + 1}: no ${step.target} on ${step.viewer}'s screen`) }
    }
    for (const error of errors) { failures += 1; console.log(`✗ ${journey.id} before step ${i + 1}: ${error}`) }
  }
  console.log(`${journey.id}: ${journey.steps.length} steps checked`)
}
await browser.close()
console.log(failures === 0 ? "all steps ok" : `${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
