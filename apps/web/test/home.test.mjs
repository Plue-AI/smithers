import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createRequire } from "node:module"
import { test } from "node:test"
import { dirname, join } from "node:path"
import { chromium } from "playwright"

const require = createRequire(import.meta.url)

test("home renders its wordmark, tagline and controls without navigating", async (t) => {
  const server = spawn(process.execPath, [join(dirname(require.resolve("vite/package.json")), "bin/vite.js"), "preview", "--host", "127.0.0.1", "--port", "4174", "--strictPort"], {
    cwd: new URL("..", import.meta.url),
    stdio: ["ignore", "pipe", "pipe"]
  })
  t.after(() => server.kill("SIGTERM"))
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Preview did not start")), 15_000)
    server.once("error", reject)
    server.once("exit", (code) => reject(new Error(`Preview exited: ${code}`)))
    server.stdout.on("data", (chunk) => {
      if (chunk.toString().includes("http://127.0.0.1:4174")) {
        clearTimeout(timeout)
        resolve()
      }
    })
  })
  const browser = await chromium.launch({
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
      : {})
  })
  t.after(() => browser.close())
  const page = await browser.newPage()
  await page.goto("http://127.0.0.1:4174")
  assert.equal(await page.getByRole("heading", { name: "Smithers" }).count(), 1)
  assert.deepEqual(await page.locator(".wordmark-row").allTextContents(), [
    "███████╗███╗   ███╗██╗████████╗██╗  ██╗███████╗██████╗ ███████╗",
    "██╔════╝████╗ ████║██║╚══██╔══╝██║  ██║██╔════╝██╔══██╗██╔════╝",
    "███████╗██╔████╔██║██║   ██║   ███████║█████╗  ██████╔╝███████╗",
    "╚════██║██║╚██╔╝██║██║   ██║   ██╔══██║██╔══╝  ██╔══██╗╚════██║",
    "███████║██║ ╚═╝ ██║██║   ██║   ██║  ██║███████╗██║  ██║███████║",
    "╚══════╝╚═╝     ╚═╝╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚══════╝"
  ])
  assert.equal(await page.locator(".sub").textContent(), "Automate maintaining your codebase")
  assert.deepEqual(await page.getByRole("button").allTextContents(), ["Get started for free", "Docs", "Terms", "Privacy"])
  const github = page.getByRole("link", { name: "GitHub", exact: true })
  assert.equal(await github.getAttribute("href"), "https://github.com/smithersai/smithers")
  assert.equal(await github.getAttribute("target"), "_blank")
  const location = page.url()
  for (const name of ["Get started for free", "Docs", "Terms", "Privacy"]) {
    await page.getByRole("button", { name, exact: true }).click()
    assert.equal(page.url(), location)
    assert.equal(await page.locator(".home").count(), 1)
  }
})
