import { test, expect, type Page, type WebSocket } from "@playwright/test"
import { SOCKET_TICKET_PATH } from "@smthrs/rpc/ApplicationAuth"
import { scenario } from "./coverage/types"
import { command } from "./support/test"

// Reference-host contract test. The operator supplies two real member sessions and
// an awake canary branch, Ben's guest uid, and a registered coding terminal title.
// Alice must be a disposable canary member: this scenario removes her from the roster.
// No HTTP, terminal bytes, or machine execution is mocked.
const required = (name: string): string => {
  const value = process.env[name]
  if (!value) throw new Error(`Reference-host precondition missing: ${name}`)
  return value
}
const bytes = (payload: string | Buffer) => typeof payload === "string" ? payload : payload.toString("utf8")
function transcript(page: Page) {
  let output = ""
  const sent: (string | Buffer)[] = []
  const sockets: WebSocket[] = []
  const closed = new Set<WebSocket>()
  page.on("websocket", socket => {
    if (!socket.url().includes("/terminal")) return
    sockets.push(socket)
    socket.on("close", () => closed.add(socket))
    socket.on("framereceived", frame => { output += bytes(frame.payload) })
    socket.on("framesent", frame => { sent.push(frame.payload) })
  })
  return { sockets, sent, closed, output: () => output }
}

test("C-J3-02 terminal dispatcher, registered ownership, raw watcher rejection and reload replay", scenario("journey.terminal-ownership", { capabilities: ["install"], coverage: ["host:production", "host:local", "action:terminal", "action:terminal.watch", "path:success", "path:permission", "path:persistence", "door:slash", "evidence:terminal-ownership"] }), async ({ browser }, info) => {
  const origin = required("SMITHERS_TERMINAL_ORIGIN")
  const branch = required("SMITHERS_TERMINAL_BRANCH")
  const codingTitle = required("SMITHERS_TERMINAL_CODING_TITLE")
  const benUID = required("SMITHERS_TERMINAL_BEN_UID")
  if (!/^\d+$/.test(benUID)) throw new Error("Ben uid must be numeric")
  const ben = await browser.newContext({ storageState: required("SMITHERS_TERMINAL_BEN_STATE") })
  const alice = await browser.newContext({ storageState: required("SMITHERS_TERMINAL_ALICE_STATE") })
  const metricsOwner = await browser.newContext({ storageState: required("SMITHERS_TERMINAL_OWNER_STATE") })
  const owner = await ben.newPage(), watcher = await alice.newPage()
  const own = transcript(owner), watched = transcript(watcher)
  try {
    await owner.goto(origin); await watcher.goto(origin)
    const opened = owner.waitForResponse(response => new URL(response.url()).pathname === "/api/terminals" && response.request().method() === "POST")
    await command(owner, `/terminal ${branch}`)
    const response = await opened
    expect(response.status()).toBe(201)
    const session = await response.json() as { id: string }
    expect(session.id).toEqual(expect.any(String))
    const card = owner.locator(".terminal-view").last()
    await expect(card.locator('[title="Ben\'s terminal"]')).toBeVisible()
    await expect(card.locator(".terminal-output > div")).not.toHaveAttribute("inert")
    const field = card.locator(".xterm-helper-textarea")
    await field.focus()
    await owner.keyboard.type("id -un; echo $HOME; pwd; umask")
    await owner.keyboard.press("Enter")
    await expect.poll(own.output).toMatch(/ben\r?\n[\s\S]*\/home\/ben\r?\n[\s\S]*\/workspace\r?\n[\s\S]*0002/)
    await command(watcher, `/branch ${branch}`)
    const terminalTitle = await card.locator("h2").innerText()
    await watcher.locator(".branch-view").last().getByRole("button", { name: terminalTitle, exact: true }).first().press("Enter")
    const watchCard = watcher.locator(".terminal-view").last()
    await expect(watchCard.getByText("Watching", { exact: true })).toBeVisible()
    await expect(watchCard.locator(".terminal-output > div")).toHaveAttribute("inert")
    await field.focus()
    await owner.keyboard.type("for i in $(seq 1 5); do echo tick $i; sleep 1; done")
    await owner.keyboard.press("Enter")
    await expect.poll(watched.output, { timeout: 15000 }).toMatch(/tick 1\r?\n[\s\S]*tick 2\r?\n[\s\S]*tick 3\r?\n[\s\S]*tick 4\r?\n[\s\S]*tick 5/)
    await expect(card.locator(".terminal-command")).toHaveCount(0, { timeout: 1000 })
    const before = watched.sent.length
    // Target the watched emulator, never Chat: this test must not launch a coding request.
    await watchCard.locator(".xterm-helper-textarea").evaluate(field => {
      for (const key of "touch /workspace/alice-was-here\r") field.dispatchEvent(new KeyboardEvent("keypress", {
        key: key === "\r" ? "Enter" : key, charCode: key.charCodeAt(0), keyCode: key.charCodeAt(0), bubbles: true
      }))
    })
    await watcher.setViewportSize({ width: 900, height: 700 })
    expect(watched.sent.slice(before)).toEqual([])
    const counter = async () => {
      const result = await metricsOwner.request.get(new URL("/api/install/metrics", origin).href)
      expect(result.status()).toBe(200)
      const metric = (await result.text()).match(/^smithers_terminal_input_dropped_total(?:\{[^\n]*\})?\s+(\d+)/m)
      expect(metric).not.toBeNull()
      return Number(metric![1])
    }
    const dropped = await counter()
    expect(watched.sockets.length).toBeGreaterThan(0)
    // Socket tickets are one-use: the UI's consumed ticket cannot authenticate this attack.
    const rawURL = new URL(watched.sockets.at(-1)!.url())
    const authorized = await alice.request.post(new URL(SOCKET_TICKET_PATH, origin).href, { headers: { Origin: new URL(origin).origin } })
    expect(authorized.ok()).toBe(true)
    const ticket = await authorized.json() as { ticket: string }
    expect(ticket.ticket).toEqual(expect.any(String))
    rawURL.searchParams.set("ticket", ticket.ticket)
    // Attack the terminal WebSocket itself, never /api/live.
    await watcher.evaluate(async url => {
      await new Promise<void>((resolve, reject) => {
        const socket = new globalThis.WebSocket(url)
        socket.onerror = () => reject(new Error("raw terminal attach refused"))
        socket.onopen = () => {
          for (let i = 0; i < 1000; i++) socket.send(new TextEncoder().encode("echo injected\n"))
          setTimeout(() => { socket.close(); resolve() }, 250)
        }
      })
    }, rawURL.href)
    await expect.poll(counter).toBeGreaterThanOrEqual(dropped + 1000)
    expect(own.output()).not.toContain("injected")
    await field.focus()
    await owner.keyboard.type("test ! -e /workspace/alice-was-here && echo OWNER_ONLY_OK")
    await owner.keyboard.press("Enter")
    await expect.poll(own.output).toContain("\r\nOWNER_ONLY_OK\r\n")
    const reloaded = transcript(watcher)
    await watcher.reload()
    await expect(watcher.locator(".terminal-view").last().getByText("Watching", { exact: true })).toBeVisible()
    await expect.poll(reloaded.output).toMatch(/tick 1\r?\n[\s\S]*tick 5\r?\n[\s\S]*OWNER_ONLY_OK/)
    for (const label of ["Ask to type", "Allow", "Let others type"]) await expect(watcher.getByRole("button", { name: label, exact: true })).toHaveCount(0)
    // A separately registered coding session must stay read-only for both members.
    for (const page of [owner, watcher]) {
      await command(page, `/branch ${branch}`)
      await page.locator(".branch-view").last().getByRole("button", { name: codingTitle, exact: true }).first().press("Enter")
      const coding = page.locator(".terminal-view").last()
      await expect(coding.locator(".terminal-person")).toHaveAttribute("title", /Coding agent/)
      await expect(coding.locator(".terminal-output > div")).toHaveAttribute("inert")
      const traffic = page === owner ? own : watched
      const sentBefore = traffic.sent.length
      await coding.locator(".xterm-helper-textarea").evaluate(field => field.dispatchEvent(
        new KeyboardEvent("keypress", { key: "a", charCode: 97, keyCode: 97, bubbles: true })))
      expect(traffic.sent.slice(sentBefore)).toEqual([])
    }
    const personal = transcript(watcher)
    const aliceOpened = watcher.waitForResponse(result => new URL(result.url()).pathname === "/api/terminals" && result.request().method() === "POST")
    await command(watcher, `/terminal ${branch}`)
    expect((await aliceOpened).status()).toBe(201)
    const aliceCard = watcher.locator(".terminal-view").last()
    await expect(aliceCard.locator('[title="Alice\'s terminal"]')).toBeVisible()
    const aliceField = aliceCard.locator(".xterm-helper-textarea")
    await aliceField.focus()
    await watcher.keyboard.type(`id -un; ls /home/ben; cat /run/smithers/${benUID}/token`)
    await watcher.keyboard.press("Enter")
    await expect.poll(personal.output).toMatch(/\r?\nalice\r?\n/)
    await expect.poll(() => personal.output().match(/Permission denied/gi)?.length ?? 0).toBeGreaterThanOrEqual(2)
    // This canary fixture is disposable: removal exercises the production roster door.
    const activeAliceSockets = [...new Set([...watched.sockets, ...reloaded.sockets, ...personal.sockets])].filter(socket =>
      !watched.closed.has(socket) && !reloaded.closed.has(socket) && !personal.closed.has(socket))
    expect(activeAliceSockets.length).toBeGreaterThanOrEqual(2)
    const removed = await metricsOwner.request.delete(new URL("/api/members/alice", origin).href)
    expect(removed.ok()).toBe(true)
    await expect.poll(() => activeAliceSockets.every(socket =>
      watched.closed.has(socket) || reloaded.closed.has(socket) || personal.closed.has(socket)), { timeout: 5000 }).toBe(true)
    await field.focus()
    await owner.keyboard.type("echo OWNER_SURVIVES_REVOCATION")
    await owner.keyboard.press("Enter")
    await expect.poll(own.output).toContain("\r\nOWNER_SURVIVES_REVOCATION\r\n")
    await info.attach("terminal-transcripts", { body: JSON.stringify({ owner: own.output(), watcher: watched.output(), replay: reloaded.output(), dropped: await counter() }), contentType: "application/json" })
  } finally { await ben.close(); await alice.close(); await metricsOwner.close() }
})
