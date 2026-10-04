import { readFileSync } from "node:fs"
import { chromium } from "@playwright/test"
import { githubRoute } from "./github-route.ts"
const run = JSON.parse(readFileSync(process.argv[2], "utf8"))
const browser = await chromium.launch({ headless: false })
const context = await browser.newContext()
await githubRoute(context, run.fakeURL)
const stop = () => { void browser.close().then(() => process.exit(0)) }
process.on("SIGINT", stop); process.on("SIGTERM", stop)
browser.on("disconnected", () => process.exit(0))
await (await context.newPage()).goto(run.setupURL)
