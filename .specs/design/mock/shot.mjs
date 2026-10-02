#!/usr/bin/env node
/*
 * Screenshot the built mock: node .specs/design/mock/shot.mjs [name] [query] [--dark] [--width=1440] [--height=900]
 * Writes shots/<name>-<light|dark>.png. The query string selects a journey and step, e.g. "j=j3&s=4".
 */
import { createRequire } from "node:module"
import { mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, "../../../apps/app")
const { chromium } = createRequire(join(APP, "package.json"))("@playwright/test")

const args = process.argv.slice(2)
const flag = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.split("=")[1] ?? fallback
const [name = "mock", query = ""] = args.filter(arg => !arg.startsWith("--"))
const theme = args.includes("--dark") ? "dark" : "light"
const width = Number(flag("width", 1440))
const height = Number(flag("height", 900))
const full = args.includes("--full")

mkdirSync(join(HERE, flag("shots", "shots")), { recursive: true })
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme })
const errors = []
page.on("pageerror", error => errors.push(error.message))
page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
const play = args.includes("--play")
const dist = resolve(HERE, flag("dist", "dist"))
const url = `${pathToFileURL(join(dist, "index.html")).href}?${query}${query ? "&" : ""}theme=${theme}${play ? "" : "&still=1"}`
await page.goto(url)
await page.waitForTimeout(Number(flag("wait", 400)))
const file = join(HERE, flag("shots", "shots"), `${name}-${theme}.png`)
await page.screenshot({ path: file, fullPage: full })
await browser.close()
if (errors.length > 0) console.error(`page errors:\n${errors.join("\n")}`)
console.log(file)
