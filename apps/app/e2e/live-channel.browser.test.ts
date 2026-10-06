import { expect, test } from "bun:test"
import { chromium, expect as browserExpect } from "@playwright/test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createChatStub } from "./support/ChatStub"
import { startLocalServer } from "../src/bun/server"

// A protocol peer supplies literal committed frames, not a replacement client.
// Chromium runs the shipped LiveChannel through the shipped app's socket proxy.
test("browser shares a socket and recovers gap and retention cursors through the app route", async () => {
  const dist = await mkdtemp(join(tmpdir(), "col02-browser-"))
  const entry = join(dist, "entry.ts")
  await writeFile(entry, `import { LiveChannel } from ${JSON.stringify(join(import.meta.dirname, "../src/mainview/runtime/LiveChannel.ts"))};
    const channel = new LiveChannel();
    const render = () => document.querySelector('output').textContent = JSON.stringify(channel.getSnapshot('home'));
    const release = channel.subscribe('home', render);
    const second = channel.subscribe('home', render);
    channel.subscribe('flows', () => {});
    Object.assign(window, { release, second });`)
  const bundle = await Bun.build({ entrypoints: [entry], target: "browser" })
  expect(bundle.success).toBe(true)
  await writeFile(join(dist, "index.html"), '<output></output><script src="/entry.js"></script>')
  await writeFile(join(dist, "entry.js"), await bundle.outputs[0]!.text())
  const requests: Record<string, unknown>[] = []
  let connections = 0
  let homeRequests = 0
  const backend = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) {
      if (server.upgrade(request, { headers: { "sec-websocket-protocol": "smithers.live.v1" } })) return
      return new Response("upgrade required", { status: 400 })
    },
    websocket: {
      open() { connections++ },
      message(socket, raw) {
        const frame = JSON.parse(String(raw))
        requests.push(frame)
        if (frame.t !== "sub" || frame.topic !== "home") return
        homeRequests++
        if (homeRequests === 1) {
          socket.send('{"t":"snap","id":1,"cursor":100,"data":"before"}')
          socket.send('{"t":"gap","id":1}')
          // A queued delta after gap must never replace committed state.
          socket.send('{"t":"delta","id":1,"cursor":101,"data":"unapplied"}')
        } else if (homeRequests === 2) {
          socket.send('{"t":"snap","id":1,"cursor":2,"data":"retained"}')
          socket.close()
        } else socket.send('{"t":"snap","id":1,"cursor":3,"data":"recovered"}')
      }
    }
  })
  const app = await startLocalServer({ port: 0, distDir: dist, agent: createChatStub, backendApi: backend.url.origin, log() {} })
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    await page.goto(app.origin)
    await page.waitForFunction(() => document.querySelector("output")?.textContent?.includes('"recovered"'))
    expect(JSON.parse(await page.locator("output").innerText())).toEqual({ topic: "home", cursor: 3, data: "recovered" })
    expect(connections).toBe(2)
    expect(requests.filter(f => f.topic === "home")).toEqual([
      { t: "sub", id: 1, topic: "home" },
      { t: "sub", id: 1, topic: "home" },
      { t: "sub", id: 1, topic: "home", cursor: 2 }
    ])
    await page.evaluate(() => (window as unknown as { release(): void }).release())
    expect(requests.filter(f => f.t === "unsub")).toEqual([])
    await page.evaluate(() => (window as unknown as { second(): void }).second())
    await browserExpect.poll(() => requests.filter(f => f.t === "unsub")).toEqual([{ t: "unsub", id: 1 }])
  } finally {
    await browser.close(); await app.stop(); backend.stop(true)
    await rm(dist, { recursive: true, force: true })
  }
}, 20000)
