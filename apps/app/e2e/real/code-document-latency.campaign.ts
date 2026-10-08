// Invoked by the composed-install harness. One runner monotonic clock for both pages.
import assert from "node:assert/strict"
import { chromium } from "@playwright/test"
import { mkdir, writeFile, readdir, statfs } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { hostname, platform, arch } from "node:os"
const origin = process.env.SMITHERS_CODE_DOCUMENT_ORIGIN!
const topic = process.env.SMITHERS_CODE_DOCUMENT_TOPIC!
const guest = process.env.SMITHERS_CODE_DOCUMENT_GUEST ?? "external-install"
const disk = process.env.SMITHERS_CODE_DOCUMENT_DISK
const storage = disk ? await statfs(disk) : undefined
const storageType = storage?.type === 0x01021994 ? "tmpfs" : storage ? `0x${storage.type.toString(16)}` : null
const fileDigest = async (path: string | undefined) => path ? createHash("sha256").update(new Uint8Array(await Bun.file(path).arrayBuffer())).digest("hex") : null
const daemonDigest = await fileDigest(process.env.SMITHERS_REHEARSAL_MACHINED_FAULT_BINARY)
const nativeDigest = await fileDigest(process.env.SMITHERS_FFI_LIBRARY_PATH)
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
  const attempts: Array<{ member: string; seq: number; key: string; send: number; local?: number; receive?: number }> = []
  const attempted = new Map<string, typeof attempts[number]>()
  const seen = new Map<string, number>()
  const pending = new Map<string, { resolve(): void }>()
  const contexts = await Promise.all(["ben", "alice"].map(async member => {
   const context = await browser.newContext({ permissions: ["local-network-access"], viewport: { width: 1440, height: 900 } })
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
    const attempt = attempted.get(key)
    if (!attempt) return
    if (attempt.member === member) { attempt.local ??= now(); return }
    const receive = now()
    seen.set(key, (seen.get(key) ?? 0) + 1)
    if (attempt.receive === undefined) {
     attempt.receive = receive
     samples.push({ member: attempt.member, seq: attempt.seq, send: attempt.send, receive, latency: receive-attempt.send, key })
    }
    const sent = pending.get(key)
    pending.delete(key)
    sent?.resolve()
   })
   page.on("pageerror", error => console.error(member, error.message))
   page.on("console", message => { if (message.type() === "error") console.error(member, message.text()) })
   page.on("requestfailed", request => console.error(member, request.url(), request.failure()))
   await page.goto(`${origin}/campaign?topic=${encodeURIComponent(topic)}&carets=${flag}`)
   await page.waitForFunction(() => (window as any).campaign?.ready()).catch(async error => { console.error(await page.evaluate(() => ({ html: document.documentElement.outerHTML.slice(0,500), campaign: typeof (window as any).campaign }))); throw error })
   return { context, page, member }
  }))
  if (flag === "on") {
   // Adjacent edit lines keep both remote selections visible. Seed through
   // Chromium and the real document, before starting the measured workload.
   await contexts[0]!.page.locator(".cm-content").click()
   await contexts[0]!.page.keyboard.press("Control+End")
   await contexts[0]!.page.keyboard.press("Enter")
   await Promise.all(contexts.map(({ page }) => page.waitForFunction(() => (window as any).campaign.text().endsWith("\n"))))
  }
  const started = now()
  const summarize = (member: string) => {
   const latencies = samples.filter(sample => sample.member === member).map(sample => sample.latency).sort((a,b)=>a-b)
   return { flag, member, attempted: attempts.filter(attempt => attempt.member === member).length, samples: latencies.length, p95: latencies[Math.ceil(latencies.length*.95)-1] ?? null, elapsed: now()-started }
  }
  let progressWrite = Promise.resolve()
  const progress = setInterval(() => {
   const snapshot = JSON.stringify({ sha, summaries: contexts.map(({ member }) => summarize(member)) }, null, 2)
   progressWrite = progressWrite.then(() => writeFile(`${out}/${flag}-progress.json`, snapshot)).catch(error => { failure = error })
  }, 60_000)
  try {
   await Promise.all(contexts.map(async ({ page, member }, index) => {
    const observer = contexts[1-index]!.page
    const receipts: Promise<void>[] = []
    await page.locator(".cm-content").click()
    for (let seq = 0; now() - started < duration; seq++) {
     await page.keyboard.press("Control+End")
     if (index === 0) await page.keyboard.press("ArrowUp")
     await page.keyboard.press("End")
     // One printable Unicode character uniquely identifies each keystroke.
     const key = String.fromCodePoint(0xe000 + (flag === "off" ? 3200 : 0) + index * 1600 + seq)
     assert.ok(seq < 1600, "sequence range exhausted")
     const send = now()
     const attempt = { member, seq, key, send }
     attempts.push(attempt)
     attempted.set(key, attempt)
     const receipt = new Promise<void>(resolve => {
      pending.set(key, { resolve })
     })
     receipts.push(receipt)
     await page.keyboard.insertText(key)
     await page.keyboard.press("Shift+ArrowLeft")
     // Receipt observation must not serialize typing: a slow remote member
     // still receives the continuously typed workload rather than less input.
     if (flag === "on" && seq === 10) await observer.waitForFunction(() => !!document.querySelector(".cm-ySelectionCaret") && !!document.querySelector(".code-name-flag"))
     await new Promise(resolve => setTimeout(resolve, Math.max(0, started + (seq+1)*interval-now())))
    }
    // Measure the complete five-minute population. Individual outliers do not
    // truncate typing or disappear from p95; only missing arrivals after a
    // bounded final drain fail the run before the distribution assertion.
    await new Promise<void>((resolve, reject) => {
     const timer = setTimeout(() => reject(new Error(`Missing receipts after drain: ${[...pending.keys()].map(key => { const attempt = attempted.get(key)!; return `${attempt.member}/${attempt.seq}` }).join(",")}`)), 60_000)
     Promise.all(receipts).then(() => { clearTimeout(timer); resolve() }, error => { clearTimeout(timer); reject(error) })
    })
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
   for (const attempt of attempts) {
    assert.ok(attempt.local !== undefined, `Missing local input: ${attempt.member}/${attempt.seq}`)
    assert.ok(attempt.receive !== undefined, `Missing peer input: ${attempt.member}/${attempt.seq}`)
    assert.equal(seen.get(attempt.key), 1, `Duplicate peer input: ${attempt.member}/${attempt.seq}`)
    assert.equal([...texts[0]].filter(c => c === attempt.key).length, 1)
   }
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
   clearInterval(progress)
   await progressWrite
   await writeFile(`${out}/${flag}-keystrokes.json`, JSON.stringify({ sha, dirty: !!dirty, flag, samples, attempts, observations: Object.fromEntries(seen) }, null, 2))
   await writeFile(`${out}/${flag}-keystrokes.csv`, [
    "flag,member,seq,key_codepoint,send_ms,local_ms,receive_ms,latency_ms,peer_observations",
    ...attempts.map(attempt => [flag, attempt.member, attempt.seq, attempt.key.codePointAt(0), attempt.send, attempt.local ?? "", attempt.receive ?? "", attempt.receive === undefined ? "" : attempt.receive-attempt.send, seen.get(attempt.key) ?? 0].join(","))
   ].join("\n") + "\n")
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
 await writeFile(`${out}/summary.json`, JSON.stringify({ sha, dirty: !!dirty, sourceDigest, daemonDigest, nativeDigest, patchDigest: createHash("sha256").update(patch).digest("hex"), comparison: ["ben", "alice"].map(member => { const on = summaries.find(s => s.member === member && s.flag === "on"), off = summaries.find(s => s.member === member && s.flag === "off"); return { member, onP95: on?.p95, offP95: off?.p95, delta: on && off ? on.p95-off.p95 : null } }), passed: !failure, qualification: "development-only", mount: "production-file-container", clock: "runner process.hrtime.bigint", workload: "concurrent append on adjacent lines and last-character selection, four printable BMP keys/s/member; newline setup excluded", guest, diskVerified: !!disk && !failure, limitation: "Production File container development mount; reference Mac, second Mac and LAN pending", host: hostname(), platform: platform(), arch: arch(), storageType, browser: browser.version(), duration, interval, budget, summaries, failure: failure ? String(failure) : null }, null, 2))
 const artifacts = await Promise.all((await readdir(out)).sort().map(async name => {
  const bytes = new Uint8Array(await Bun.file(`${out}/${name}`).arrayBuffer())
  return { name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }
 }))
 await writeFile(`${out}/manifest.json`, JSON.stringify({ sha, artifacts }, null, 2))
 await browser.close()
 console.log(`C-UI-14 artifacts: ${out}`)
}
if (failure) throw failure
console.log(JSON.stringify(summaries))
