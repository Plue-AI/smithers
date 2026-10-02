/** Browser boundary regression for all flows' authored result presentation. */
import { expect, test } from "bun:test"
import { chromium } from "playwright"
import { renderToStaticMarkup } from "react-dom/server"
import { RunResult } from "../../src/mainview/cards/RunResult.tsx"
test("authored result scripts run inside an isolated, network-denied frame", async () => {
 const browser = await chromium.launch({ headless: true })
 try {
  const page = await browser.newPage()
  const outgoing: string[] = []
  page.on("request", (request) => { if (request.url().startsWith("https://")) outgoing.push(request.url()) })
  const html = `<h1>Walkthrough</h1><script>
   try { parent.document.body.innerHTML = 'changed'; document.body.dataset.parent = 'accessible'; }
   catch { document.body.dataset.parent = 'blocked'; }
   fetch('https://example.invalid/forbidden').then(() => { document.body.dataset.network = 'accessible'; }, () => { document.body.dataset.network = 'blocked'; });
  </script>`
  await page.setContent(`<main id="app">${renderToStaticMarkup(<RunResult result={JSON.stringify({ ui: { kind: "html", title: "Custom flow", html } })} />)}</main>`)
  const frame = page.frames().find((candidate) => candidate.parentFrame() !== null)!
  await frame.waitForFunction(() => document.body.dataset.network !== undefined)
  expect(await frame.locator("h1").textContent()).toBe("Walkthrough")
  expect(await frame.locator("body").getAttribute("data-parent")).toBe("blocked")
  expect(await frame.locator("body").getAttribute("data-network")).toBe("blocked")
  expect(await page.locator("#app iframe").count()).toBe(1)
  expect(outgoing).toEqual([])
 } finally { await browser.close() }
}, 15000)
