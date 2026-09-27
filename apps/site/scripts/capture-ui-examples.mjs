#!/usr/bin/env node
/** Local app screenshots using the existing browser-test server fixtures.
 * These images illustrate controls with example data, not production activity.
 * Every API request is intercepted, and external requests are blocked.
 */
import { createRequire } from "node:module"
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
const require = createRequire(new URL("../../app/package.json", import.meta.url))
const { chromium } = require("playwright")
const ts = require("typescript")
const origin = process.env.DOCS_EXAMPLE_ORIGIN ?? "http://127.0.0.1:4325"
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) throw new Error("Example captures require a local server")
const output = fileURLToPath(new URL("../public/images/app/", import.meta.url))
const selected = new Set(process.argv.slice(2))
const json = (body) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) })
const event = (sequence, kind, payload, offset) => {
  const at = Date.parse("2026-09-01T17:00:00Z") + offset
  return { sequence, kind, occurredAt: at, payload: { ...payload, at } }
}
const journal = [
  event(1, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, 1000),
  event(2, "control.agent.cell-produced", { language: "ts", text: 'const guide = await ctx.call("files.read", { path: "CONTRIBUTING.md" })' }, 1200),
  event(3, "control.agent.cell-call-started", { flowName: "files.read", input: { path: "CONTRIBUTING.md" } }, 1400),
  event(4, "control.agent.cell-call-settled", { flowName: "files.read", outcome: "success", value: "# Contributing" }, 2200),
  event(5, "control.agent.cell-call-started", { flowName: "target.run", input: { label: "//apps/site:docsCheck" } }, 2300),
  event(6, "control.agent.cell-call-settled", { flowName: "target.run", outcome: "failure", message: "Broken link: /docs/start" }, 4300),
  event(7, "control.agent.cell-settled", { outcome: "success" }, 4400),
  event(8, "control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }, 5000),
  event(9, "control.agent.cell-produced", { language: "ts", text: 'await ctx.call("files.read", { path: "docs/start.mdx" })' }, 5100),
  event(10, "control.agent.cell-call-started", { flowName: "files.read", input: { path: "docs/start.mdx" } }, 5200)
]

async function fixture(name) {
  const path = new URL(`../../app/e2e/playwright/${name}.spec.ts`, import.meta.url)
  const source = readFileSync(path, "utf8").split("test.beforeEach")[0]
    .replace(/^import .*\n/gm, "")
    .replaceAll('"will"', '"docs-example"')
    .replaceAll("will@example.com", "docs@example.com")
    .replaceAll("turns: 1", "turns: 2")
    .replaceAll("calls: 2", "calls: 3")
    .replaceAll("Add the split flow", "Clarify the contribution guide")
    .replaceAll("src/app.ts", "docs/contributing.md")
    .replaceAll('@@ -1 +1 @@\\n-old\\n+new', '@@ -1 +1 @@\\n-Run the tests.\\n+Run the tests from the repository root.')
  const js = ts.transpileModule(source + "\nexport { serve }", { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
  return (await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)).serve
}
const send = async (page, text) => {
  await page.getByTestId("composer-input").fill(text)
  await page.getByTestId("composer-send").click()
}
const screenshot = async (page, locator, file) => {
  await locator.waitFor()
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(300)
  await locator.screenshot({ path: `${output}${file}`, animations: "disabled" })
  const bounds = await locator.boundingBox()
  const manifest = JSON.parse(readFileSync(`${output}captures.json`, "utf8"))
  const record = { file, source: "Local application with browser-test fixtures", capturedAt: new Date().toISOString(), width: Math.ceil(bounds.width), height: Math.ceil(bounds.height), data: "Illustrative example data; not a production account, run, or result" }
  writeFileSync(`${output}captures.json`, JSON.stringify([...manifest.filter((r) => r.file !== file), record].sort((a,b) => a.file.localeCompare(b.file)), null, 2) + "\n")
  console.log(JSON.stringify(record))
}
const browser = await chromium.launch({ headless: true })
try {
  for (const [name, suite, command, selector] of [
    ["run", "runs", "/flow.run review-pr", '[data-kind="run-trace"]'],
    ["change", "change", "/change.view qupxosqw", '[data-kind="change"]'],
    ["box", "citc", "/box.open main smithersai/smithers", '[data-kind="workspace"]']
  ]) {
    if (selected.size && !selected.has(name)) continue
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 })
    const page = await context.newPage()
    page.setDefaultTimeout(15_000)
    await page.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort())
    await (await fixture(suite))(page)
    await page.route("**/api/user", (route) => route.fulfill(json({ id: 1, username: "docs-example", is_admin: false })))
    if (name === "run") {
      await page.route("**/api/workflow/rpc", (route) => {
        const call = route.request().postDataJSON()
        if (call.procedure !== "Projection.Snapshot" || call.payload.selector?._tag !== "run-events") return route.fallback()
        return route.fulfill(json({ ok: true, payload: { cursor: { projection: "run-events", runId: "run-e2e", value: journal.length }, rows: journal } }))
      })
    }
    if (name === "box") {
      const repo = "smithersai/smithers"
      const box = { id: "ws-1", repo_full_name: repo, name: "docs-review", target_bookmark: "main", status: "running", provisioning_stage: null, suspended_at: null, created_at: "2026-09-01T00:00:00Z" }
      await page.route(new RegExp(`/api/repos/${repo}/workspaces(\\?.*)?$`), (r) => r.fulfill(json(r.request().method() === "POST" ? box : [box])))
      await page.route(`**/api/repos/${repo}/workspaces/ws-1`, (r) => r.fulfill(json(box)))
      await page.route(`**/api/repos/${repo}/workspace-snapshots`, (r) => r.fulfill(json([{ id: "snapshot-example", name: "before-docs-edit", workspace_id: "ws-1", created_at: "2026-09-01T00:00:00Z" }])))
      await page.route(`**/api/repos/${repo}/workspace/sessions`, (r) => r.fulfill(json([])))
    }
    try {
      await page.goto(`${origin}/smithersai/smithers`)
      await page.getByTestId("composer-input").waitFor()
      await send(page, command)
      const card = page.locator(selector).last()
      await card.waitFor()
      if (name === "run") await card.getByText("files.read", { exact: true }).first().waitFor()
      if (name === "box") await card.getByRole("tab", { name: "Snapshots", exact: true }).click()
      await screenshot(page, card, `${name}-example.png`)
      if (name === "change") {
        await card.getByRole("tab", { name: "Checks", exact: true }).click()
        await screenshot(page, card, "checks-example.png")
      }
    } catch (error) {
      console.error(`${name}: ${error.message}\n${(await page.locator("body").innerText()).slice(-3200)}`)
      process.exitCode = 1
    } finally { await context.close() }
  }
} finally { await browser.close() }
