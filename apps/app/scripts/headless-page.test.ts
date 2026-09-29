import { fixtureProtocolId } from "../e2e/real/support/values"
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test"
import { createHeadlessBrowser, type HeadlessBrowser } from "./headless-page.ts"
import { runChecklist } from "./launch-checklist/Runner.ts"

type Command = { id: number; method: string; params: any; sessionId?: string }
class FakeSocket extends EventTarget {
  static sockets: FakeSocket[] = []
  static commands: Command[] = []
  static respond: (command: Command) => any = () => ({})
  static open = true
  constructor(_url: string | URL) {
    super()
    FakeSocket.sockets.push(this)
    if (FakeSocket.open) queueMicrotask(() => this.dispatchEvent(new Event("open")))
  }
  send(raw: string) {
    const command = JSON.parse(raw) as Command
    FakeSocket.commands.push(command)
    const reply = FakeSocket.respond(command)
    if (reply !== undefined) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: command.id, ...reply }) }))
  }
  close() { this.dispatchEvent(new Event("close")) }
}

let browser: HeadlessBrowser
let restore: Array<() => void> = []
beforeEach(() => {
  FakeSocket.sockets = []
  FakeSocket.commands = []
  FakeSocket.open = true
  FakeSocket.respond = (command) => ({ result:
    command.method === "Target.createBrowserContext" ? { browserContextId: `context-${command.id}` } :
    command.method === "Target.createTarget" ? { targetId: `target${command.id}` } :
    command.method === "Target.attachToTarget" ? { sessionId: fixtureProtocolId(`session-${command.id}`) } :
    command.method === "Runtime.evaluate" ? { result: { type: "boolean", value: true } } : {}
  })
  const socket = spyOn(globalThis as unknown as { WebSocket: (...args: any[]) => any }, "WebSocket").mockImplementation(((url: string | URL) => new FakeSocket(url)) as any)
  const spawn = spyOn(Bun, "spawn").mockImplementation((() => ({ kill() {} })) as any)
  const http = spyOn(globalThis, "fetch").mockImplementation((async () => Response.json({ webSocketDebuggerUrl: "ws://fake" })) as unknown as typeof fetch)
  restore = [() => socket.mockRestore(), () => spawn.mockRestore(), () => http.mockRestore()]
  browser = createHeadlessBrowser({ target: "https://smithers.test/repo", explicitBinary: "/fake/chrome", env: {}, requestTimeoutMs: 25 })
})
afterEach(async () => {
  await browser.close()
  for (const reset of restore) reset()
})
const settled = (promise: Promise<unknown>) => Promise.race([
  promise.then((value) => ({ value }), (error: Error) => ({ error: error.message })),
  new Promise<{ error: string }>((resolve) => setTimeout(() => resolve({ error: "still pending" }), 80))
])

test("cookies never accompany cross-host subresources or redirects and identities are isolated", async () => {
  await browser.page("session=one==; other=two")
  await browser.page("session=second")
  await browser.page(undefined)
  const cookies = FakeSocket.commands.filter((c) => c.method === "Network.setCookies")
  // Model browser host matching; page-wide headers bypass it on both request kinds.
  const headersFor = (url: string) => {
    const global = FakeSocket.commands.find((c) => c.method === "Network.setExtraHTTPHeaders")?.params.headers.cookie
    return global ?? cookies[0]?.params.cookies.filter((c: any) =>
      new URL(c.url).hostname === new URL(url).hostname && (!c.secure || new URL(url).protocol === "https:")
    ).map((c: any) => `${c.name}=${c.value}`).join("; ") ?? ""
  }
  expect(headersFor("https://cdn.external.test/image.png")).toBe("")
  expect(headersFor("https://oauth.external.test/authorize")).toBe("")
  expect(headersFor("https://sub.smithers.test/")).toBe("")
  expect(headersFor("http://smithers.test/")).toBe("")
  expect(headersFor("https://smithers.test/api")).toBe("session=one==; other=two")
  expect(FakeSocket.commands.filter((c) => c.method === "Network.setExtraHTTPHeaders")).toEqual([])
  const contexts = FakeSocket.commands.filter((c) => c.method === "Target.createBrowserContext")
  expect(contexts).toHaveLength(3)
  expect(contexts.every((c) => c.params.disposeOnDetach === true)).toBe(true)
  const targets = FakeSocket.commands.filter((c) => c.method === "Target.createTarget")
  expect(new Set(targets.map((c) => c.params.browserContextId)).size).toBe(3)
  expect(cookies).toHaveLength(2)
  expect(cookies[0]?.params.cookies).toEqual([
    { name: "session", value: "one==", url: "https://smithers.test/repo", path: "/", secure: true, httpOnly: true },
    { name: "other", value: "two", url: "https://smithers.test/repo", path: "/", secure: true, httpOnly: true }
  ])
  expect(cookies[0]?.sessionId).not.toBe(cookies[1]?.sessionId)
})

test("protocol errors reject evaluate with method, request id and CDP code", async () => {
  const page = await browser.page(undefined)
  FakeSocket.respond = () => ({ error: { code: -32000, message: "Execution context was destroyed." } })
  expect(await settled(page.evaluate<boolean>("true"))).toEqual({ error: expect.stringMatching(/Runtime.evaluate.*\d+.*-32000.*Execution context was destroyed/) })
})

test.each(["close", "error"])("socket %s rejects every pending request and future sends", async (event) => {
  const page = await browser.page(undefined)
  FakeSocket.respond = () => undefined
  const first = settled(page.evaluate("1"))
  const second = settled(page.text())
  FakeSocket.sockets.forEach((socket) => socket.dispatchEvent(new Event(event)))
  expect(await first).toEqual({ error: expect.stringContaining(`CDP socket ${event}`) })
  expect(await second).toEqual({ error: expect.stringContaining(`CDP socket ${event}`) })
  expect(await settled(page.evaluate("2"))).toEqual({ error: expect.stringContaining(`CDP socket ${event}`) })
})

test("a silent request times out and the next request still works", async () => {
  const page = await browser.page(undefined)
  const respond = FakeSocket.respond
  FakeSocket.respond = () => undefined
  expect(await settled(page.evaluate("1"))).toEqual({ error: expect.stringContaining("timed out") })
  FakeSocket.respond = respond
  expect(await page.evaluate<boolean>("true")).toBe(true)
})

test.each([{}, { result: {} }, { result: { type: "string" } }, { result: { type: "object", objectId: "remote" } }] as Array<Record<string, unknown>>)(
  "malformed evaluate result rejects: %j", async (result) => {
    const page = await browser.page(undefined)
    FakeSocket.respond = () => ({ result })
    expect(await settled(page.evaluate("void 0"))).toEqual({ error: expect.stringContaining("invalid Runtime.evaluate response") })
  }
)

test("evaluate preserves legitimate undefined, null, false and zero", async () => {
  const page = await browser.page(undefined)
  for (const [remote, expected] of [
    [{ type: "undefined" }, undefined], [{ type: "object", subtype: "null", value: null }, null],
    [{ type: "boolean", value: false }, false], [{ type: "number", value: 0 }, 0]
  ] as Array<[Record<string, unknown>, unknown]>) {
    FakeSocket.respond = () => ({ result: { result: remote } })
    expect({ value: await page.evaluate("expression") }).toEqual({ value: expected })
  }
})

test("a mid-run CDP disconnect fails the row, preserves earlier results and continues", async () => {
  const page = await browser.page(undefined)
  const persisted: string[][] = []
  const results = await runChecklist({
    mode: "run", rowTimeoutMs: 100,
    onProgress: (rows) => { persisted.push(rows.map((row) => row.status)) },
    context: { target: "https://smithers.test", env: {}, page: async () => page, fetch, now: Date.now, sleep: async () => {} },
    rows: [
      { id: "A-1", section: "A", title: "pass", probe: async () => ({ status: "pass", detail: "ok" }) },
      { id: "A-2", section: "A", title: "disconnect", probe: async (ctx) => {
        FakeSocket.respond = () => undefined
        const pending = (await ctx.page(undefined)).text()
        FakeSocket.sockets.forEach((socket) => socket.close())
        return { status: "pass", detail: await pending }
      } },
      { id: "A-3", section: "A", title: "after", probe: async () => ({ status: "pass", detail: "ok" }) }
    ]
  })
  expect(results.map((row) => row.status)).toEqual(["pass", "fail", "pass"])
  expect(results[1]?.reasons[0]).toContain("CDP socket close")
  expect(persisted).toEqual([["pass"], ["pass", "fail"], ["pass", "fail", "pass"]])
})

test("a canceled browser startup does not poison the next checklist row", async () => {
  await browser.close()
  browser = createHeadlessBrowser({ target: "https://smithers.test/repo", explicitBinary: "/fake/chrome", env: {}, requestTimeoutMs: 100 })
  FakeSocket.open = false
  const results = await runChecklist({
    mode: "run", rowTimeoutMs: 25,
    context: { target: "https://smithers.test", env: {}, page: (cookie, signal) => browser.page(cookie, signal), fetch, now: Date.now, sleep: async () => {} },
    rows: [
      { id: "A-1", section: "A", title: "startup canceled", browser: true, probe: async (ctx) => {
        await ctx.page(undefined)
        return { status: "pass", detail: "unexpected" }
      } },
      { id: "A-2", section: "A", title: "recovered", browser: true, probe: async (ctx) => {
        FakeSocket.open = true
        const page = await ctx.page(undefined)
        return { status: "pass", detail: String(await page.evaluate<boolean>("true")) }
      } }
    ]
  })
  expect(results.map((row) => row.status)).toEqual(["fail", "pass"])
  expect(results[0]?.reasons).toEqual(["row A-1 timed out after 25ms"])
  expect(results[1]?.evidence).toEqual(["true"])
  expect(FakeSocket.sockets).toHaveLength(2)
})

test("persistent socket startup failure retries for later pages", async () => {
  FakeSocket.open = false
  expect(await settled(browser.page("session=first"))).toEqual({ error: expect.stringContaining("socket open timed out") })
  expect(await settled(browser.page("session=second"))).toEqual({ error: expect.stringContaining("socket open timed out") })
  expect(FakeSocket.sockets).toHaveLength(2)
})

test("a socket that never opens times out", async () => {
  FakeSocket.open = false
  expect(await settled(browser.page(undefined))).toEqual({ error: expect.stringContaining("socket open timed out") })
})

test("close before socket open rejects startup", async () => {
  FakeSocket.open = false
  const opening = settled(browser.page(undefined))
  await new Promise((resolve) => setTimeout(resolve, 0))
  FakeSocket.sockets.forEach((socket) => socket.close())
  expect(await opening).toEqual({ error: "CDP socket close" })
})

test("browser close aborts startup and prevents later page creation", async () => {
  FakeSocket.open = false
  const opening = settled(browser.page(undefined))
  await new Promise((resolve) => setTimeout(resolve, 0))
  await browser.close()
  expect(await opening).toEqual({ error: "headless browser closed" })
  expect(await settled(browser.page("session=another"))).toEqual({ error: "headless browser closed" })
})

test("cancellation rejects a CDP call, ignores its late response and leaves the cached page usable", async () => {
  const controller = new AbortController()
  const page = await browser.page(undefined, controller.signal)
  const respond = FakeSocket.respond
  FakeSocket.respond = () => undefined
  const pending = settled(page.evaluate("1", controller.signal))
  const command = FakeSocket.commands.at(-1)!
  controller.abort(new Error("row cancelled"))
  expect(await pending).toEqual({ error: "row cancelled" })
  FakeSocket.sockets[0]!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ id: command.id, result: {} }) }))
  FakeSocket.respond = respond
  expect(await (await browser.page(undefined)).evaluate<boolean>("true")).toBe(true)
  expect(await settled(page.evaluate("2", controller.signal))).toEqual({ error: "row cancelled" })
})

test("socket send exceptions reject all pending requests", async () => {
  const page = await browser.page(undefined)
  FakeSocket.respond = () => undefined
  const first = settled(page.text())
  FakeSocket.respond = () => { throw new Error("write failed") }
  expect(await settled(page.evaluate("1"))).toEqual({ error: expect.stringContaining("write failed") })
  expect(await first).toEqual({ error: expect.stringContaining("write failed") })
})

test("page exceptions reject evaluation", async () => {
  const page = await browser.page(undefined)
  FakeSocket.respond = () => ({ result: { exceptionDetails: { text: "Uncaught" } } })
  expect(await settled(page.evaluate("throw new Error()"))).toEqual({ error: expect.stringContaining("page evaluation failed") })
})
