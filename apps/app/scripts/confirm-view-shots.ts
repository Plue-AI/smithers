import { chromium } from "playwright"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { confirmStories } from "../src/mainview/cards/views/ConfirmView.stories"

// Isolated T-UI-05 harness; no product server, Container, or backend.
const output = process.env.CONFIRM_SHOTS ?? join(process.env.HOME!, "design-lanes/shots/T-UI-05")
await mkdir(output, { recursive: true })
const build = await Bun.build({ entrypoints: ["src/mainview/cards/views/ConfirmView.preview.tsx"], target: "browser" })
if (!build.success) throw new Error(build.logs.join("\n"))
const js = build.outputs.find(file => file.path.endsWith(".js"))!
const css = build.outputs.find(file => file.path.endsWith(".css"))!
const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch(request) {
  const path = new URL(request.url).pathname
  if (path === "/preview.js") return new Response(js, { headers: { "Content-Type": "text/javascript" } })
  if (path === "/preview.css") return new Response(css, { headers: { "Content-Type": "text/css" } })
  return new Response('<!doctype html><html lang="en"><head><title>Confirm stories</title><link rel="stylesheet" href="/preview.css"><style>body{margin:0;padding:24px;background:var(--bg);font-family:var(--font-ui)}main{max-width:760px;margin:64px auto}*{box-sizing:border-box}@media(max-width:500px){body{padding:12px}main{margin:24px auto}}</style></head><body><main id="root"></main><script type="module" src="/preview.js"></script></body></html>', { headers: { "Content-Type": "text/html" } })
} })
// Pin the audit version; kept outside the product dependency graph.
const axeResponse = await fetch("https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.3/axe.min.js")
if (!axeResponse.ok) throw new Error(`axe download: ${axeResponse.status}`)
const axe = await axeResponse.text()
const browser = await chromium.launch({ headless: true })
const results: unknown[] = []
try {
  for (const theme of ["light", "dark"]) for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 } })
    const errors: string[] = []
    page.on("pageerror", error => errors.push(error.message))
    for (const name of Object.keys(confirmStories)) {
      await page.goto(`http://127.0.0.1:${server.port}/?story=${name}`)
      await page.locator(".confirm-view").waitFor()
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
      await page.addScriptTag({ content: axe })
      const audit = await page.evaluate(async () => {
        const axeWindow = window as typeof window & { axe: { run: () => Promise<{ violations: Array<{ id: string; impact: string }> }> } }
        return (await axeWindow.axe.run()).violations.filter(v => v.impact === "serious" || v.impact === "critical")
      })
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
      const path = join(output, `${name}-${theme}-${width}.png`)
      await page.screenshot({ path, fullPage: true })
      results.push({ name, theme, width, path, violations: audit, overflow })
      if (overflow || audit.length || errors.length) throw new Error(JSON.stringify({ name, theme, width, audit, overflow, errors }))
    }
    await page.close()
  }
  await Bun.write(join(output, "audit.json"), JSON.stringify(results, null, 2))
  console.log(`${results.length} screenshots; no overflow or serious/critical axe violations`)
} finally {
  await browser.close()
  server.stop(true)
}
