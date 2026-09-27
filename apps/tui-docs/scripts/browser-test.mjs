import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { once } from "node:events"
import { chromium } from "playwright"
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROME_BIN
    ? { executablePath: process.env.CHROME_BIN }
    : process.platform === "darwin"
    ? { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }
    : {})
})
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } })
const page = await context.newPage()
const errors = []
page.on("pageerror", (error) => errors.push(error.message))
let origin = process.env.DOCS_TEST_URL, server
let calls = 0, release, releaseInterrupted
const held = new Promise((resolve) => {
  release = resolve
})
const answer =
  "```cell\nconst before = await ctx.call(\"read\", {path:\"math.js\"});\nawait ctx.call(\"write\", {path:\"math.js\", content:\"export const add = (a, b) => a + b\\n\"});\nconst result = await ctx.call(\"check\", {});\nconsole.log(result);\nctx.done(\"Fixed math.js. Both checks pass.\");\n```"
try {
  if (!origin) {
    server = fork(new URL("../server/serve.mjs", import.meta.url), [], {
      env: { PATH: process.env.PATH, PORT: "0", HOST: "127.0.0.1" },
      stdio: ["ignore", "ignore", "inherit", "ipc"]
    })
    origin = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Docs server did not start")), 20_000)
      server.once("message", ({ origin }) => {
        clearTimeout(timeout)
        resolve(origin)
      })
      server.once("error", (error) => {
        clearTimeout(timeout)
        reject(error)
      })
      server.once("exit", (code) => {
        clearTimeout(timeout)
        reject(new Error(`Docs server exited: ${code}`))
      })
    })
  }
  await page.route("**/api/playground/model", async (route) => {
    calls++
    await held
    await route.fulfill({
      json: { choices: [{ finish_reason: "stop", message: { role: "assistant", content: answer } }] }
    })
  })
  await page.goto(origin)
  await page.locator("#run").waitFor()
  await page.locator("#run").click()
  await page.waitForFunction(() => document.querySelector("#run-status")?.textContent === "running")
  // An unresolved launch must leave the editor, settings, and navigation usable.
  await page.locator("#prompt").fill("A follow-up while the agent runs")
  await page.locator("#settings-open").click()
  assert(await page.locator("#settings").evaluate((el) => el.open))
  await page.locator("#settings-close").click()
  assert.equal(await page.locator("#prompt").inputValue(), "A follow-up while the agent runs")
  await page.locator("#prompt-form").evaluate((form) => form.requestSubmit())
  const other = await page.context().newPage()
  await other.goto(origin)
  await other.locator("#resume").click()
  await other.waitForFunction(() => document.querySelector("#run-status")?.textContent?.includes("another tab"))
  await other.close()
  release()
  await page.waitForFunction(() => document.querySelector("#run-status")?.textContent === "done", {}, {
    timeout: 90_000
  })
  assert.match(await page.locator("#file-content").innerText(), /a \+ b/)
  assert.equal(calls, 1)
  const head = Number(await page.locator("#checkpoint").getAttribute("max"))
  await page.locator("#checkpoint").fill("0")
  assert.match(await page.locator("#file-content").innerText(), /a - b/)
  assert.doesNotMatch(await page.locator("#transcript").innerText(), /Both checks pass/)
  await page.locator("#checkpoint").fill(String(head))
  await page.reload()
  assert.match(await page.locator("#file-content").innerText(), /a \+ b/)
  assert.equal(calls, 1)
  await page.locator("#checkpoint").fill("0")
  await page.locator("#branch").click()
  await page.waitForFunction(() => document.querySelector("#branch-select")?.value !== "main")
  assert.match(await page.locator("#file-content").innerText(), /a - b/)
  await page.locator("#branch-select").selectOption("main")
  await page.waitForFunction(() => document.querySelector("#file-content")?.textContent?.includes("a + b"))
  assert.match(await page.locator("#file-content").innerText(), /a \+ b/)
  await page.screenshot({ path: "/tmp/smithers-tui-docs-desktop.png", fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: "/tmp/smithers-tui-docs-mobile.png", fullPage: true })
  const moved = await page.request.get(origin + "/guides/chat/", { maxRedirects: 0 })
  assert([301, 302, 200].includes(moved.status()), "former guide pages redirect to smithers.sh")
  await page.goto(origin)
  await page.locator("#checkpoint").fill("0")
  const priorBranch = await page.locator("#branch-select").inputValue()
  await page.locator("#branch").click()
  await page.waitForFunction((prior) => document.querySelector("#branch-select")?.value !== prior, priorBranch)
  let personalCalls = 0
  await page.route("https://provider.test/v1/chat/completions", async (route) => {
    personalCalls++
    assert.equal(route.request().headers().authorization, "Bearer test-browser-secret")
    await route.fulfill({ json: { choices: [{ finish_reason: "stop", message: { content: answer } }] } })
  })
  await page.locator("#settings-open").click()
  await page.locator("#base-url").fill("https://provider.test/v1")
  await page.locator("#model").fill("test-model")
  await page.locator("#api-key").fill("test-browser-secret")
  await page.locator("#settings-form button[type=submit]").click()
  await page.locator("#run").click()
  await page.waitForFunction(() => document.querySelector("#run-status")?.textContent === "done")
  assert.equal(personalCalls, 1)
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes("test-browser-secret")), false)
  const failed = await browser.newPage()
  await failed.route(
    "**/api/playground/model",
    (route) => route.fulfill({ status: 503, json: { error: "not configured" } })
  )
  await failed.goto(origin)
  await failed.locator("#run").click()
  await failed.waitForFunction(() => document.querySelector("#run-status")?.textContent?.includes("Settings"))
  assert(await failed.locator("#resume").isVisible())
  await failed.close()
  // Reload while the second model request is unresolved. The first cell's
  // model response and file changes must survive without another first call.
  const recovering = await browser.newPage()
  let attempts = 0
  const interrupted = new Promise((resolve) => {
    releaseInterrupted = resolve
  })
  await recovering.route("**/api/playground/model", async (route) => {
    attempts++
    if (attempts === 2) {
      await interrupted
      await route.abort().catch(() => {})
      return
    }
    const content = attempts === 1
      ? "```cell\nawait ctx.call(\"write\", {path:\"math.js\",content:\"export const add = (a, b) => a + b\\n\"});\nconsole.log(await ctx.call(\"check\", {}));\n```"
      : "```cell\nctx.done(\"Recovered.\");\n```"
    await route.fulfill({ json: { choices: [{ finish_reason: "stop", message: { content } }] } })
  })
  await recovering.goto(origin)
  await recovering.locator("#run").click()
  await recovering.waitForFunction(() => document.querySelector("#file-content")?.textContent?.includes("a + b"))
  for (let wait = 0; attempts < 2 && wait < 100; wait++) await recovering.waitForTimeout(50)
  assert.equal(attempts, 2)
  await recovering.reload()
  releaseInterrupted()
  await recovering.locator("#resume").click()
  await recovering.waitForFunction(() => document.querySelector("#run-status")?.textContent === "done")
  assert.equal(attempts, 3)
  assert.equal(await recovering.locator("#transcript details").count(), 2)
  await recovering.close()
  assert.deepEqual(errors, [])
  console.log(
    "Browser: live production agent, unresolved provider, checkpoints, reload, branching, mobile, and the former guide redirects passed."
  )
} finally {
  release()
  releaseInterrupted?.()
  await browser.close()
  if (server && server.exitCode === null) {
    const stopped = once(server, "exit")
    server.kill()
    await stopped
  }
}
