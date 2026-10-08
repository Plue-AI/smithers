// Invoked by the composed-install harness. One runner monotonic clock for both pages.
import assert from "node:assert/strict"
import { chromium } from "@playwright/test"
import { mkdir, writeFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { hostname, platform, arch } from "node:os"
const origin = process.env.SMITHERS_CODE_DOCUMENT_ORIGIN!
const topic = process.env.SMITHERS_CODE_DOCUMENT_TOPIC!
const guest = process.env.SMITHERS_CODE_DOCUMENT_GUEST ?? "external-install"
const disk = process.env.SMITHERS_CODE_DOCUMENT_DISK
assert.ok(origin && topic)
const duration = 300_000, interval = 250, budget = 1000
const memberCookies = process.env.SMITHERS_CODE_DOCUMENT_COOKIES ? JSON.parse(process.env.SMITHERS_CODE_DOCUMENT_COOKIES) as Record<string,string> : { ben: "ben-cookie", alice: "alice-cookie" }
assert.ok(memberCookies.ben && memberCookies.alice, "two member cookies are required")
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" })
const out = new URL(`../../../../.artifacts/checks/C-UI-14/${new Date().toISOString().replaceAll(":", "-")}/`, import.meta.url).pathname
await mkdir(out, { recursive: true })
const patch = execFileSync("git", ["diff", "HEAD"], { encoding: "utf8" })
await writeFile(`${out}/source.patch`, patch)
const bundle = await Bun.build({ entrypoints: [new URL("./code-document-latency.browser.tsx", import.meta.url).pathname], target: "browser", define: { "process.env.NODE_ENV": '"production"' } })
assert.ok(bundle.success, JSON.stringify(bundle.logs))
await writeFile(`${out}/campaign.js`, await bundle.outputs.find(output => output.path.endsWith(".js"))!.text())
await writeFile(`${out}/campaign.css`, await bundle.outputs.find(output => output.path.endsWith(".css"))!.text())
await writeFile(`${out}/runner.ts`, await Bun.file(import.meta.path).text())
const sourceDigest = createHash("sha256").update(await bundle.outputs.find(output => output.path.endsWith(".js"))!.text()).digest("hex")
const javascript = await bundle.outputs.find(output => output.path.endsWith(".js"))!.text()
const css = await bundle.outputs.find(output => output.path.endsWith(".css"))!.text()
const browser = await chromium.launch({ headless: true })
const now = () => Number(process.hrtime.bigint()) / 1e6
const summaries: Array<{ flag: string; member: string; samples: number; p95: number; elapsed: number }> = []
let failure: unknown
try {
 for (const flag of ["on", "off"]) {
  const samples: Array<{ member: string; seq: number; send: number; receive: number; latency: number; key: string }> = []
  const pending = new Map<string, { member: string; seq: number; send: number; resolve(): void }>()
  const contexts = await Promise.all(["ben", "alice"].map(async member => {
   const context = await browser.newContext({ permissions: ["local-network-access"] })
   await context.addCookies([{ name: "smithers_session", value: memberCookies[member]!, url: origin }])
   // Only the campaign mount is served here. /api/live goes to the real install.
   await context.route(`${origin}/campaign**`, route => route.fulfill({ contentType: "text/html", body: '<link rel="stylesheet" href="/campaign.css"><div id="root"></div><script type="module" src="/campaign.js"></script>' }))
   await context.route(`${origin}/campaign.js`, route => route.fulfill({ contentType: "text/javascript", body: javascript }))
   await context.route(`${origin}/campaign.css`, route => route.fulfill({ contentType: "text/css", body: css }))
   const page = await context.newPage()
   page.on("websocket", socket => socket.on("framereceived", ({ payload }) => {
    if (typeof payload === "string") {
     try { const frame = JSON.parse(payload); if (frame.t === "err" || frame.t === "gap") console.error(member, "document transport", payload) } catch {}
    }
   }))
   await page.exposeBinding("campaignReceipt", (_source, key: string) => {
    const sent = pending.get(key)
    if (!sent || sent.member === member) return
    const receive = now()
    samples.push({ member: sent.member, seq: sent.seq, send: sent.send, receive, latency: receive-sent.send, key })
    pending.delete(key)
    sent.resolve()
   })
   page.on("pageerror", error => console.error(member, error.message))
   page.on("console", message => { if (message.type() === "error") console.error(member, message.text()) })
   page.on("requestfailed", request => console.error(member, request.url(), request.failure()))
   await page.goto(`${origin}/campaign?topic=${encodeURIComponent(topic)}&carets=${flag}`)
   await page.waitForFunction(() => (window as any).campaign?.ready()).catch(async error => { console.error(await page.evaluate(() => ({ html: document.documentElement.outerHTML.slice(0,500), campaign: typeof (window as any).campaign }))); throw error })
   return { context, page, member }
  }))
  const started = now()
  try {
   await Promise.all(contexts.map(async ({ page, member }, index) => {
    const observer = contexts[1-index]!.page
    const receipts: Promise<void>[] = []
    await page.locator(".cm-content").click()
    for (let seq = 0; now() - started < duration && !failure; seq++) {
     await page.keyboard.press("Control+End")
     // One printable Unicode character uniquely identifies each keystroke.
     const key = String.fromCodePoint(0xe000 + (flag === "off" ? 3200 : 0) + index * 1600 + seq)
     assert.ok(seq < 1600, "sequence range exhausted")
     const send = now()
     const receipt = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Missing receipt: ${member}/${seq}`)) }, 10000)
      pending.set(key, { member, seq, send, resolve: () => { clearTimeout(timer); resolve() } })
     })
     receipts.push(receipt.catch(error => { failure = error }))
     await page.keyboard.insertText(key)
     await page.keyboard.press("Shift+ArrowLeft")
     // Receipt observation must not serialize typing: a slow remote member
     // still receives the continuously typed workload rather than less input.
     if (flag === "on" && seq === 10) await observer.waitForFunction(() => !!document.querySelector(".cm-ySelectionCaret") && !!document.querySelector(".code-name-flag"))
     await new Promise(resolve => setTimeout(resolve, Math.max(0, started + (seq+1)*interval-now())))
    }
    await Promise.all(receipts)
    if (failure) throw failure
   }))
   for (const { page, member } of contexts) {
    await page.screenshot({ path: `${out}/${flag}-${member}.png` })
    await page.waitForFunction(flag => flag === "on" ? !!document.querySelector(".cm-ySelectionCaret") && !!document.querySelector(".cm-ySelection") : !document.querySelector(".cm-ySelectionCaret, .cm-ySelection"), flag)
    if (flag === "on") {
     const colours = await page.evaluate(() => ({ caret: getComputedStyle(document.querySelector(".cm-ySelectionCaret")!).borderLeftColor, flag: getComputedStyle(document.querySelector(".code-name-flag")!).borderLeftColor }))
     assert.equal(colours.caret, colours.flag)
    }
   }
   const texts = await Promise.all(contexts.map(({page}) => page.evaluate(() => (window as any).campaign.text())))
   assert.equal(texts[0], texts[1])
   for (const sample of samples) assert.equal([...texts[0]].filter(c => c === sample.key).length, 1)
   await writeFile(`${out}/${flag}-text.txt`, texts[0])
   if (disk) {
    // The installed daemon debounces saves. Verify real disk bytes after the
    // flush window, rather than treating browser convergence as durability.
    await new Promise(resolve => setTimeout(resolve, 1500))
    const diskText = await Bun.file(disk).text()
    await writeFile(`${out}/${flag}-disk.txt`, diskText)
    assert.equal(diskText, texts[0], "installed daemon disk and both members converge")
   }
  } catch (error) {
   failure = error
   for (const { page, member } of contexts) {
    await writeFile(`${out}/${flag}-${member}-failure.json`, JSON.stringify(await page.evaluate(() => ({ text: (window as any).campaign.text(), ready: (window as any).campaign.ready(), html: document.querySelector(".cm-editor")?.outerHTML })), null, 2))
   }
  }
  finally {
   await writeFile(`${out}/${flag}-keystrokes.json`, JSON.stringify({ sha, dirty: !!dirty, flag, samples }, null, 2))
   for (const { member } of contexts) {
    const latencies = samples.filter(s => s.member === member).map(s => s.latency).sort((a,b)=>a-b)
    summaries.push({ flag, member, samples: latencies.length, p95: latencies[Math.ceil(latencies.length*.95)-1] ?? Infinity, elapsed: now()-started })
   }
   await Promise.all(contexts.map(({ context }) => context.close()))
  }
  if (failure) break
 }
 if (!failure) {
  assert.equal(summaries.length, 4)
  for (const result of summaries) { assert.ok(result.elapsed >= duration); assert.ok(result.samples >= 1000); assert.ok(result.p95 < budget, JSON.stringify(result)) }
 }
} catch (error) { failure = error } finally {
 await writeFile(`${out}/summary.json`, JSON.stringify({ sha, dirty: !!dirty, sourceDigest, patchDigest: createHash("sha256").update(patch).digest("hex"), comparison: ["ben", "alice"].map(member => { const on = summaries.find(s => s.member === member && s.flag === "on"), off = summaries.find(s => s.member === member && s.flag === "off"); return { member, onP95: on?.p95, offP95: off?.p95, delta: on && off ? on.p95-off.p95 : null } }), passed: !failure, qualification: "development-only", guest, diskVerified: !!disk && !failure, limitation: "Development mount; reference Mac, second Mac and LAN pending", host: hostname(), platform: platform(), arch: arch(), browser: browser.version(), duration, interval, budget, summaries, failure: failure ? String(failure) : null }, null, 2))
 await browser.close()
 console.log(`C-UI-14 artifacts: ${out}`)
}
if (failure) throw failure
console.log(JSON.stringify(summaries))
