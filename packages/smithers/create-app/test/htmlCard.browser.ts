import assert from "node:assert/strict"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer as createHttpServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright"
import { createServer as createViteServer } from "vite"
import type { TurnFrame } from "../src/ui.ts"

const template = fileURLToPath(new URL("../template/default/", import.meta.url))
const pagePath = join(template, "app/page.tsx")
const pageSource = readFileSync(pagePath, "utf8")

test(
  "default chat renders pane and HTML cards from the turn stream",
  { timeout: 120_000 },
  async (t) => {
    const cacheDir = mkdtempSync(join(tmpdir(), "smithers-2672-vite-"))
    const vite = await createViteServer({
      root: template,
      cacheDir,
      configFile: false,
      resolve: {
        alias: {
          "@smthrs/create-app/app": fileURLToPath(new URL("../src/app.ts", import.meta.url)),
          "@smthrs/create-app/ui": fileURLToPath(new URL("../src/ui.ts", import.meta.url))
        }
      },
      plugins: [{
        name: "test-template-virtuals",
        resolveId: (id) => id.startsWith("virtual:smthrs-app/") ? `\0${id}` : undefined,
        load: (id) =>
          id.split("?")[0] === pagePath ? pageSource : id === "\0virtual:smthrs-app/brand.css" ?
            "" :
            id === "\0virtual:smthrs-app/manifest"
            ? "export default { brand: { name: 'app' }, nav: [] }"
            : undefined
      }],
      server: { middlewareMode: true, hmr: false, ws: false }
    })
    const frames: ReadonlyArray<TurnFrame> = [
      {
        type: "card",
        card: { kind: "pane", id: "pane", name: "message", props: { heading: "Pane", body: "Pane" }, fullscreen: false }
      },
      {
        type: "card",
        card: {
          kind: "html",
          id: "html",
          title: "Report",
          html: "<p id='review-html'>VISIBLE HTML CARD</p><script>parent.document.title = 'escaped'</script>"
        }
      },
      { type: "done", output: { answer: "Ready", cards: ["pane", "html"] } }
    ]
    const server = createHttpServer((request, response) => {
      if (request.url !== "/api/turn") return vite.middlewares(request, response)
      response.writeHead(200, { "content-type": "application/x-ndjson" })
      response.end(frames.map((frame) => JSON.stringify(frame)).join("\n") + "\n")
    })
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
    t.after(async () => {
      await browser?.close()
      server.closeAllConnections()
      await vite.close()
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(cacheDir, { recursive: true, force: true })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("HTTP server has no port")
    const executablePath = process.env.SMITHERS_CHROME_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${address.port}/`)
    await page.locator(".composer-input").fill("Show panes")
    await page.locator(".composer-send").click()
    await page.locator(".answer-text").waitFor()
    assert.deepEqual(await page.locator(".pane-heading").allTextContents(), ["Pane", "Report"])
    const frame = page.locator("iframe.html-card")
    assert.equal(await frame.count(), 1)
    assert.equal(await frame.getAttribute("sandbox"), "")
    assert.match((await frame.getAttribute("srcdoc")) ?? "", /default-src 'none'/)
    assert.equal(await page.frameLocator("iframe.html-card").locator("#review-html").textContent(), "VISIBLE HTML CARD")
    assert.notEqual(await page.title(), "escaped")
  }
)
