import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { Browser, BrowserContext, Page, Response } from "@playwright/test"
import { awaitBoot, closeComposer, command, expect, openComposer, test } from "./support"
import { scenario } from "./coverage/types"
import { connect, exchange, listenerReport, listeners, loopbackOnly, processTree, type Connection, type Listener } from "./support/listeners"

/*
 * C-INS-01 (T-INS-04, mvp.md M-28, spec §16.3): members reach the install at
 * the address the owner sets. One install is used at its loopback origin and
 * at each origin the owner saves in Address, with no secure-context API on
 * the plain-HTTP ones; an origin the owner never set, or removed, is refused.
 *
 * The install is described by a JSON file:
 *   - the composed install: packages/backend TestInstallOriginsBrowser writes
 *     it (SMITHERS_JOURNEY_COMPOSED_HOST) and runs this spec against the
 *     production composition on its own listeners, with the GitHub fake, at
 *     localhost, the Mac's LAN address, its .local name and an HTTPS proxy;
 *   - the reference host: the operator writes it
 *     (SMITHERS_INSTALL_ORIGINS_HOST) for the Mac's install, its LAN origin
 *     and the HTTPS proxy origin. Run on the Mac it names the launcher's pid,
 *     so listeners are read with lsof; run on the second Mac it omits `pid`,
 *     and the same steps probe the Mac from the network.
 *
 * Every expectation is a literal of the check or is read off the wire, the
 * browser, lsof or the socket; nothing is mocked, and no browser API is
 * replaced. `document.execCommand` is observed through a pass-through.
 */

type Install = {
  readonly setupURL?: string
  readonly install: "composed" | "reference"
  readonly commit: string
  /** Root of the install's process tree, when this runner is on the install's Mac. */
  readonly pid?: number
  /** The origin on the Mac itself. */
  readonly loopback: string
  /** The origins the owner saves in Address, in order; the last is removed again at the end. */
  readonly ownerSet: readonly string[]
  /** An origin that reaches the same listener and that the owner never set. */
  readonly unset: string
  /** The bind host the owner saves, and the Mac's address on that network. */
  readonly bind: string
  readonly address: string
  /** Host names the browser resolves to a fixed address (Chromium host-resolver-rules). */
  readonly resolve?: Readonly<Record<string, string>>
  /** The HTTPS origin's certificate is outside this browser's trust store (the composed install's proxy). */
  readonly untrustedTLS?: boolean
  readonly ports: { readonly http: number; readonly network: number; readonly ssh: number; readonly postgres: number }
  readonly sessionCookie: string
  /** What the app agent answers, when the install's model is scripted. */
  readonly answer?: string
  readonly evidence: string
}

const descriptor = process.env.SMITHERS_JOURNEY_COMPOSED_HOST ?? process.env.SMITHERS_INSTALL_ORIGINS_HOST
const described: Install | undefined = descriptor ? JSON.parse(readFileSync(descriptor, "utf8")) : undefined

// Collection (`--list`) loads this file without an install; a run needs one.
test.use({ launchOptions: { args: described?.resolve && Object.keys(described.resolve).length > 0
  ? [`--host-resolver-rules=${Object.entries(described.resolve).map(([name, address]) => `MAP ${name} ${address}`).join(", ")}`] : [] } })

const QUESTION = "where do we retry webhooks?"
const UNKNOWN_ORIGIN = { class: "user", code: "unknown_origin", message: "unknown_origin" }
const ORIGIN_REFUSED = { class: "permission", code: "origin", message: "origin" }
const CSRF_REFUSED = { class: "permission", code: "csrf", message: "csrf" }
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** C-INS-01 step 3: a browser treats https and the loopback names as secure, and nothing else. */
const secureContext = (origin: string): boolean => {
  const url = new URL(origin)
  return url.protocol === "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
}
const https = (origin: string): boolean => new URL(origin).protocol === "https:"
const liveURL = (origin: string): string => `${https(origin) ? "wss" : "ws"}://${new URL(origin).host}/api/live`

/** The matches C-INS-01 step 6 lists: each is a third-party module's, and its form is what makes it safe on plain HTTP. */
const THIRD_PARTY_FORMS = [
  { needle: "randomUUID(", module: "@tanstack/db utils/uuid", safe: "guarded by typeof, then falls back to getRandomValues",
    form: /typeof (\w+)\.randomUUID==[`"']function[`"']\)return \1\.randomUUID\(\)/ },
  { needle: "crypto.subtle", module: "lib0 webcrypto", safe: "a bare read, undefined on plain HTTP, never called",
    form: /(?:^|[;{}])crypto\.subtle;/ }
] as const
const NEEDLES = ["randomUUID(", "crypto.subtle", "serviceWorker.register"] as const

type ConsoleLine = { readonly at: "signed-out" | "signed-in"; readonly kind: "console" | "pageerror" | "rejection"; readonly text: string; readonly url: string }
type LiveFrame = { readonly direction: "sent" | "received"; readonly t: string; readonly topic: string; readonly type: string; readonly data: unknown }
type Visitor = {
  readonly origin: string
  readonly context: BrowserContext
  readonly page: Page
  readonly lines: ConsoleLine[]
  readonly sockets: string[]
  readonly frames: LiveFrame[]
  readonly start: { redirectURI: string; cookies: string[] }
  readonly callback: { cookies: string[] }
}

/** `Set-Cookie` values of one response, one per cookie. */
const setCookies = async (response: Response): Promise<string[]> =>
  (await response.headersArray()).filter(header => header.name.toLowerCase() === "set-cookie").map(header => header.value)

/** The attributes of the cookie a response sets (not one it clears), lower-cased, with SameSite's value kept. */
const cookieAttributes = (lines: readonly string[], name: string): string[] | undefined =>
  lines.find(line => line.startsWith(`${name}=`) && !line.startsWith(`${name}=;`))?.split(";").slice(1).map(part => part.trim())
    .map(attribute => /^samesite=/i.test(attribute) ? attribute.toLowerCase() : attribute.split("=")[0]!.toLowerCase())

/**
 * Opens the install at `origin` in a fresh browser profile and signs in with
 * GitHub through the product's `/sign-in` door. Every console error, page
 * error and unhandled rejection is kept, marked by whether a session existed.
 */
const signIn = async (browser: Browser, install: Install, origin: string): Promise<Visitor> => {
  const context = await browser.newContext({ ignoreHTTPSErrors: install.untrustedTLS === true,
    recordVideo: { dir: join(install.evidence, "video", new URL(origin).hostname), size: { width: 960, height: 540 } } })
  const page = await context.newPage()
  const lines: ConsoleLine[] = []
  const sockets: string[] = []
  const frames: LiveFrame[] = []
  const anonymousRequests: string[] = []
  page.on("request", request => {
    const path = new URL(request.url()).pathname
    if (at === "signed-out" && path.startsWith("/api/")) anonymousRequests.push(path)
  })
  let at: ConsoleLine["at"] = "signed-out"
  await page.exposeFunction("__installOriginsRejection", (text: string) => { lines.push({ at, kind: "rejection", text, url: page.url() }) })
  await page.addInitScript(() => {
    window.addEventListener("unhandledrejection", event => {
      void (window as unknown as { __installOriginsRejection: (text: string) => void }).__installOriginsRejection(String((event.reason as Error | undefined)?.stack ?? event.reason))
    })
  })
  page.on("console", message => { if (message.type() === "error") lines.push({ at, kind: "console", text: message.text(), url: message.location().url }) })
  page.on("pageerror", error => { lines.push({ at, kind: "pageerror", text: error.stack ?? error.message, url: page.url() }) })
  page.on("websocket", socket => {
    if (new URL(socket.url()).pathname !== "/api/live") return
    sockets.push(socket.url())
    const topics = new Map<number, string>()
    const read = (direction: LiveFrame["direction"]) => ({ payload }: { payload: string | Buffer }) => {
      if (typeof payload !== "string") return
      const frame = JSON.parse(payload) as { t?: string; id?: number; topic?: string; data?: { Type?: string; Data?: unknown } }
      if (direction === "sent" && frame.t === "sub" && frame.id !== undefined && frame.topic) topics.set(frame.id, frame.topic)
      frames.push({ direction, t: frame.t ?? "", topic: frame.topic ?? topics.get(frame.id ?? -1) ?? "", type: frame.data?.Type ?? "", data: frame.data?.Data })
    }
    socket.on("framesent", read("sent"))
    socket.on("framereceived", read("received"))
  })

  await page.goto(`${origin}/`)
  await awaitBoot(page)
  const here = (path: string) => (response: Response) => { const url = new URL(response.url()); return url.origin === origin && url.pathname === path }
  await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true }).last()).toBeVisible()
  await expect(page.locator('[data-kind="setup"]')).toHaveCount(0)
  await page.waitForTimeout(1500)
  expect(anonymousRequests.filter(path => path === "/api/install"), `${origin}: exactly one quiet setup probe`).toHaveLength(1)
  expect(lines.filter(line => !line.url.endsWith("/api/install")), `${origin}: no other console errors before sign-in`).toEqual([])
  expect(lines.filter(line => line.url.endsWith("/api/install")).length).toBeLessThanOrEqual(1)
  expect(sockets, `${origin}: no authenticated live connection before sign-in`).toEqual([])
  expect(anonymousRequests.filter(path => !["/api/bootstrap", "/api/auth/session", "/api/install"].includes(path)), `${origin}: no protected requests before sign-in`).toEqual([])
  const started = page.waitForResponse(here("/api/auth/github"), { timeout: 60_000 })
  const returned = page.waitForResponse(here("/api/auth/github/callback"), { timeout: 180_000 })
  await page.getByRole("button", { name: "Sign in with GitHub", exact: true }).last().click()
  const start = await started
  expect(start.status(), `${origin}: sign-in starts with a redirect to GitHub`).toBe(302)
  const redirectURI = new URL((await start.headerValue("location"))!).searchParams.get("redirect_uri") ?? ""
  // GitHub's consent: the fake offers "Authorize"; github.com returns at once for an App the person already authorized.
  // The session exists from the callback's answer on: what the page logs after it belongs to the signed-in app.
  let callback: Response | undefined
  page.on("response", response => { if (here("/api/auth/github/callback")(response)) { callback = response; at = "signed-in" } })
  await expect.poll(async () => {
    if (callback) return "returned"
    const consent = page.getByRole("link", { name: "Authorize", exact: true }).or(page.getByRole("button", { name: "Authorize", exact: true })).first()
    if (await consent.isVisible().catch(() => false)) await consent.click().catch(() => undefined)
    return "at GitHub"
  }, { message: `${origin}: GitHub returns the browser to the origin that started the sign-in`, timeout: 180_000, intervals: [250] }).toBe("returned")
  const finished = await returned
  expect(finished.status(), `${origin}: the callback signs in and redirects into the app`).toBe(302)
  const visitor: Visitor = { origin, context, page, lines, sockets, frames,
    start: { redirectURI, cookies: await setCookies(start) }, callback: { cookies: await setCookies(finished) } }
  await page.waitForURL(url => url.origin === origin, { timeout: 60_000 })
  await awaitBoot(page)
  return visitor
}

/** A same-origin request the page itself makes: the browser's own cookies, `Origin` and resolver. */
const inPage = (page: Page, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> =>
  page.evaluate(async ({ method, path, body }) => {
    const csrf = document.cookie.split("; ").find(cookie => cookie.startsWith("__csrf="))?.slice("__csrf=".length)
    const response = await fetch(path, { method, headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(method === "GET" || !csrf ? {} : { "X-CSRF-Token": csrf }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const text = await response.text()
    let parsed: unknown = text
    try { parsed = JSON.parse(text) } catch { /* not JSON: the text is the answer */ }
    return { status: response.status, body: parsed }
  }, { method, path, body })

/**
 * Pastes the clipboard into the composer with the keyboard until it holds
 * `copied`. A Copy control answers before its clipboard write settles, so the
 * paste is repeated; a copy that never lands, or lands other text, never matches.
 */
const expectPasted = async (page: Page, copied: string): Promise<void> => {
  await openComposer(page)
  const input = page.getByTestId("composer-input")
  await expect.poll(async () => {
    await input.fill("")
    await page.keyboard.press("ControlOrMeta+v")
    return input.inputValue()
  }, { message: "the pasted text equals the copied text" }).toBe(copied)
  await input.fill("")
  await closeComposer(page)
}

/** Starts observing `document.execCommand` calls on this page; the call itself is untouched. */
const observeExecCommand = (page: Page) => page.evaluate(() => {
  const seen: Array<[string, boolean]> = []
  ;(window as unknown as { __installOriginsExec: typeof seen }).__installOriginsExec = seen
  const original = document.execCommand.bind(document)
  document.execCommand = (command: string, ...rest: [boolean?, string?]) => {
    const ok = original(command, ...rest)
    seen.push([command, ok])
    return ok
  }
})
const execCommands = (page: Page): Promise<Array<[string, boolean]>> =>
  page.evaluate(() => (window as unknown as { __installOriginsExec: Array<[string, boolean]> }).__installOriginsExec.splice(0))

/** HTTP answers the browser logged as failed resources: `status path`. */
const failedResources = (visitor: Visitor, at: ConsoleLine["at"]): string[] =>
  [...new Set(visitor.lines.filter(line => line.at === at && line.kind === "console" && /^Failed to load resource: the server responded with a status of \d+/.test(line.text))
    .map(line => `${/status of (\d+)/.exec(line.text)![1]} ${new URL(line.url).pathname}`))].sort()

test("setup token redirects to the unfinished Setup card at /", scenario("journey-install-origins", {
  capabilities: ["install"], coverage: ["host:local", "door:button", "path:success", "dimension:setup"]
}), async ({ browser }) => {
  test.skip(!described?.setupURL, "The reference host uses setup.spec.ts and its printed setup URL")
  const install = described!
  const context = await browser.newContext()
  try {
    const page = await context.newPage()
    const exchange = page.waitForResponse(response => new URL(response.url()).pathname === "/setup")
    await page.goto(install.setupURL!)
    const redirect = await exchange
    expect(redirect.status()).toBe(303)
    expect(await redirect.headerValue("location")).toBe("/")
    expect(new URL(page.url()).pathname).toBe("/")
    expect((await context.cookies()).find(cookie => cookie.name === "smithers_setup_session")?.httpOnly).toBe(true)
    await expect(page.locator('.setup-view[data-kind="setup"]')).toBeVisible()
    await expect(page.locator('[data-kind="setup"] [data-step]')).toHaveCount(7)
    expect(await page.locator('[data-kind="setup"] [data-step]:not([data-state="done"])').count()).toBeGreaterThan(0)
  } finally { await context.close() }
  const teammate = await browser.newContext()
  try {
    const page = await teammate.newPage()
    const probes: number[] = []
    const errors: string[] = []
    page.on("response", response => { if (new URL(response.url()).pathname === "/api/install") probes.push(response.status()) })
    page.on("console", message => { if (message.type() === "error" && /401/.test(message.text())) errors.push(message.text()) })
    await page.goto(install.loopback)
    await expect(page.getByRole("button", { name: "Sign in with GitHub", exact: true }).last()).toBeVisible()
    await page.waitForTimeout(1500)
    await expect(page.locator('[data-kind="setup"]')).toHaveCount(0)
    expect(probes).toHaveLength(1)
    expect([401, 403]).toContain(probes[0])
    expect(errors.length).toBeLessThanOrEqual(1)
  } finally { await teammate.close() }
})

test("C-INS-01 the install works at loopback and at each origin the owner sets, and refuses any other", scenario("journey-install-origins", {
  capabilities: ["install", "identity"],
  coverage: ["host:local", "host:production", "door:slash", "door:button", "surface:settings", "surface:todo", "surface:draft", "path:success", "path:permission",
    "evidence:listeners", "evidence:cookies", "evidence:bundle-grep", "evidence:live-delta"]
}), async ({ browser }, info) => {
  test.setTimeout(900_000)
  if (!described) throw new Error("C-INS-01 needs an install descriptor: run it from packages/backend TestInstallOriginsBrowser, or name the reference install's in SMITHERS_INSTALL_ORIGINS_HOST")
  const install = described
  expect(install.ownerSet.length, "the owner sets two origins beside loopback; the last is removed again").toBeGreaterThanOrEqual(2)
  mkdirSync(install.evidence, { recursive: true })
  const keep = (name: string, value: unknown) => writeFileSync(join(install.evidence, name), typeof value === "string" ? value : JSON.stringify(value, null, 2))
  const origins = [install.loopback, ...install.ownerSet]
  const kept = install.ownerSet.slice(0, -1)
  const removed = install.ownerSet.at(-1)!
  const savedBind = `${install.bind}:${install.ports.network}`
  const visitors = new Map<string, Visitor>()
  const connections: Array<{ when: string; target: string; connection: Connection }> = []
  const probe = async (when: string, address: string, port: number, banner?: number): Promise<Connection> => {
    const connection = await connect(address, port, banner === undefined ? {} : { banner })
    connections.push({ when, target: `${address}:${port}`, connection })
    return connection
  }
  const tree = (): Listener[] => install.pid === undefined ? [] : listeners(processTree(install.pid))
  const listening = (found: readonly Listener[], port: number): string[] => found.filter(listener => listener.port === port).map(listener => listener.address).sort()

  try {
    await test.step("default bind: every listener is loopback and the network is refused", async () => {
      if (install.pid !== undefined) {
        const before = tree()
        keep("lsof-before.txt", listenerReport(processTree(install.pid)))
        expect(before.length, "the install listens").toBeGreaterThanOrEqual(2)
        expect(before.filter(listener => !loopbackOnly(listener)), "no listener leaves loopback before the owner sets a bind").toEqual([])
        expect(listening(before, install.ports.http)).toEqual(["127.0.0.1"])
        expect(listening(before, install.ports.ssh)).toEqual(["127.0.0.1"])
        expect(listening(before, install.ports.network).filter(address => address !== "127.0.0.1")).toEqual([])
        expect(await probe("before", "127.0.0.1", install.ports.http)).toMatchObject({ outcome: "connected" })
        expect((await probe("before", "127.0.0.1", install.ports.ssh, 1500) as { banner?: string }).banner ?? "").toMatch(/^SSH-2\.0-/)
      }
      // From the network (on the composed install: this Mac's own interface address) nothing answers.
      for (const port of [install.ports.network, install.ports.ssh, install.ports.postgres])
        expect(await probe("before", install.address, port), `${install.address}:${port} before the bind`).toEqual({ outcome: "refused" })
    })

    const owner = await test.step("L: the owner signs in on the Mac", async () => {
      const visitor = await signIn(browser, install, install.loopback)
      visitors.set(install.loopback, visitor)
      return visitor
    })

    await test.step("the owner sets the bind and the origins in Address; no restart", async () => {
      const saved = await inPage(owner.page, "PUT", "/api/install", { bind: install.bind, origins: install.ownerSet })
      expect(saved.status, JSON.stringify(saved.body)).toBe(200)
      expect(saved.body.address).toEqual({ listen: "network", bind: savedBind, origins: install.ownerSet })
      await expect.poll(() => owner.frames.filter(frame => frame.direction === "received" && frame.t === "delta" && frame.type === "install.address").map(frame => frame.data),
        { message: "the owner's page learns the saved Address over the live channel" }).toEqual([{ bind: savedBind, origins: install.ownerSet }])
      if (install.pid !== undefined) {
        const after = tree()
        keep("lsof-after.txt", listenerReport(processTree(install.pid)))
        const network = install.bind === "0.0.0.0" ? "*" : install.bind
        // HTTP and SSH listen on loopback and on the bind; the same process serves both, so nothing restarted.
        expect(listening(after, install.ports.http)).toContain("127.0.0.1")
        expect(listening(after, install.ports.network)).toContain(network)
        expect(listening(after, install.ports.ssh)).toEqual(["127.0.0.1", network].sort())
        expect(after.filter(listener => !loopbackOnly(listener)).map(listener => `${listener.address}:${listener.port}`).sort(),
          "only HTTP and SSH follow the bind").toEqual([`${network}:${install.ports.network}`, `${network}:${install.ports.ssh}`].sort())
        expect([...new Set(after.filter(listener => listener.port === install.ports.http || listener.port === install.ports.network).map(listener => listener.pid))],
          "the loopback and network HTTP listeners belong to one process").toHaveLength(1)
        expect(await probe("after", "127.0.0.1", install.ports.http)).toMatchObject({ outcome: "connected" })
      }
      expect(await probe("after", install.address, install.ports.network)).toMatchObject({ outcome: "connected" })
      expect((await probe("after", install.address, install.ports.ssh, 1500) as { banner?: string }).banner ?? "").toMatch(/^SSH-2\.0-/)
      expect(await probe("after", install.address, install.ports.postgres), "PostgreSQL stays on loopback").toEqual({ outcome: "refused" })
    })

    for (const origin of install.ownerSet) await test.step(`${origin}: a teammate signs in at the origin the owner set`, async () => {
      visitors.set(origin, await signIn(browser, install, origin))
    })

    for (const origin of origins) await test.step(`${origin}: sign-in, cookies and the browser's context`, async () => {
      const visitor = visitors.get(origin)!
      const { page } = visitor
      // Step 5 of the ticket's C-INS-03 and C-INS-01: the OAuth callback and every cookie belong to the origin that started.
      expect(visitor.start.redirectURI).toBe(`${origin}/api/auth/github/callback`)
      const expected = (httpOnly: boolean) => [...(httpOnly ? ["httponly"] : []), "samesite=lax", ...(https(origin) ? ["secure"] : [])].sort()
      const sent = (lines: readonly string[], name: string) => cookieAttributes(lines, name)?.filter(attribute => ["httponly", "secure", "domain"].includes(attribute) || attribute.startsWith("samesite")).sort()
      expect(sent(visitor.callback.cookies, install.sessionCookie), "session Set-Cookie").toEqual(expected(true))
      expect(sent(visitor.callback.cookies, "__csrf"), "CSRF Set-Cookie").toEqual(expected(false))
      expect(sent(visitor.start.cookies, "smithers_oauth_state"), "OAuth state Set-Cookie").toEqual(expected(true))
      const stored = Object.fromEntries((await visitor.context.cookies(origin)).map(cookie => [cookie.name, { domain: cookie.domain, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite }]))
      const host = new URL(origin).hostname
      expect(stored[install.sessionCookie]).toEqual({ domain: host, httpOnly: true, secure: https(origin), sameSite: "Lax" })
      expect(stored.__csrf).toEqual({ domain: host, httpOnly: false, secure: https(origin), sameSite: "Lax" })

      // Step 3: the browser's own verdict. A plain-HTTP origin has none of the secure-context APIs.
      const context = await page.evaluate(() => ({ secure: window.isSecureContext, origin: location.origin, randomUUID: typeof crypto.randomUUID,
        subtle: typeof crypto.subtle, clipboard: typeof navigator.clipboard, serviceWorker: typeof navigator.serviceWorker, getRandomValues: typeof crypto.getRandomValues }))
      expect(context.origin).toBe(origin)
      expect(context.secure, `isSecureContext at ${origin}`).toBe(secureContext(origin))
      expect(context.getRandomValues).toBe("function")
      if (!secureContext(origin)) expect(context).toMatchObject({ randomUUID: "undefined", subtle: "undefined", clipboard: "undefined", serviceWorker: "undefined" })
      expect((await inPage(page, "GET", "/api/user")).status).toBe(200)
    })

    for (const origin of origins) await test.step(`${origin}: the journey slice`, async () => {
      const { page, frames, sockets } = visitors.get(origin)!
      // One person uses one tab: the clipboard belongs to the page in front.
      await page.bringToFront()
      // The live channel is ws:// on http and wss:// on https, at the page's host.
      expect(new Set(sockets), "live sockets").toEqual(new Set([liveURL(origin)]))
      await expect.poll(() => frames.filter(frame => frame.direction === "received" && frame.t === "snap").length, { message: "the live channel answers subscriptions" }).toBeGreaterThan(0)

      // Ask the app agent; its answer arrives over the live channel. The branch's conversation is shared, so this
      // origin's question is its own and its answer is one more than the transcript already held.
      const question = `${QUESTION} (${new URL(origin).host})`
      const said = (text: string) => page.getByTestId("transcript").evaluate((node, text) => (node.textContent ?? "").split(text).length - 1, text)
      const answered = install.answer ? await said(install.answer) : 0
      const before = frames.length
      await command(page, question)
      await closeComposer(page)
      await expect.poll(() => said(question), { message: "the question joins the conversation" }).toBeGreaterThan(0)
      if (install.answer) await expect.poll(() => said(install.answer!), { message: "the agent answers this question", timeout: 60_000 }).toBeGreaterThan(answered)
      await expect(page.locator('[data-testid="transcript"][aria-busy="false"]')).toBeAttached({ timeout: 120_000 })
      expect(frames.slice(before).filter(frame => frame.direction === "received" && frame.topic.startsWith("conversation:")).length, "the answer came over the live channel").toBeGreaterThan(0)

      // File a TODO through its Draft: the request key is the app's own UUID, with no crypto.randomUUID on plain HTTP.
      const title = `Greet from ${new URL(origin).host}`
      await command(page, `/todo.new ${title}`)
      await closeComposer(page)
      const draft = page.locator('.smithers-card[data-kind="draft"]').last()
      const filed = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/todos")
      await draft.getByRole("button", { name: "Commit", exact: true }).click()
      const accepted = await filed
      expect(accepted.status()).toBe(202)
      expect(accepted.request().headers()["idempotency-key"], "the Draft's request key").toMatch(UUID_V4)
      const todo = page.locator('.smithers-card[data-kind="todo"]').filter({ hasText: title }).last()
      await expect(todo).toBeVisible()
      await expect(todo.getByRole("button", { name: "Steer", exact: true })).toBeVisible()

      // The production chat Copy command and its gesture: pasted text equals the copied text.
      await observeExecCommand(page)
      const message = `copied at ${new URL(origin).host}`
      await command(page, `/chat.copy-message ${message}`)
      await closeComposer(page)
      await expectPasted(page, message)
      const fallback = await execCommands(page)
      // No clipboard API on plain HTTP: the shared helper's hidden-textarea copy runs exactly once and succeeds.
      if (secureContext(origin)) expect(fallback.length, "a secure origin writes natively, or falls back once when the browser refuses").toBeLessThanOrEqual(1)
      else expect(fallback).toEqual([["copy", true]])

      // A Copy button: the Laptop agent line of the first origin the owner set.
      const line = `smthrs login ${install.ownerSet[0]}`
      await command(page, "/settings")
      await closeComposer(page)
      await page.locator('.smithers-card[data-kind="settings"]').last().getByRole("button", { name: `Copy ${line}`, exact: true }).click()
      await expectPasted(page, line)
      const button = await execCommands(page)
      if (secureContext(origin)) expect(button.length).toBeLessThanOrEqual(1)
      else expect(button).toEqual([["copy", true]])
      await page.screenshot({ path: join(install.evidence, `slice-${new URL(origin).hostname}.png`) })

      // T-APP-24 (C-UI-09): on plain HTTP off loopback, Settings names the HTTPS fix and opens the bundled quickstart
      // at its heading; a secure origin shows neither the row nor the door. The first such origin is clicked, the rest use the keyboard.
      const settings = page.locator('.smithers-card[data-kind="settings"]').last()
      const hint = settings.getByRole("button", { name: "Notifications need HTTPS ↗", exact: true })
      const docs = page.getByRole("article", { name: "Docs", exact: true })
      await expect(docs, "no Docs card before the hint").toHaveCount(0)
      if (secureContext(origin)) {
        await expect(settings.getByText("Notifications need HTTPS ↗", { exact: true })).toHaveCount(0)
        await expect(settings.getByText("Notifications", { exact: true })).toHaveCount(0)
      } else {
        if (origin === install.ownerSet.find(each => !secureContext(each))) await hint.click()
        else await hint.press("Enter")
        await expect(docs.locator("#put-https-in-front")).toHaveText("Put HTTPS in front")
        await expect(docs.locator("#put-https-in-front")).toBeInViewport()
        await page.screenshot({ path: join(install.evidence, `https-hint-${new URL(origin).hostname}.png`) })
      }
    })

    await test.step("an Address change reaches every origin as a live delta", async () => {
      const marks = new Map(origins.map(origin => [origin, visitors.get(origin)!.frames.length]))
      const reordered = [...install.ownerSet].reverse()
      const saved = await inPage(owner.page, "PUT", "/api/install", { origins: reordered })
      expect(saved.status, JSON.stringify(saved.body)).toBe(200)
      expect(saved.body.address).toEqual({ listen: "network", bind: savedBind, origins: reordered })
      for (const origin of origins) await expect.poll(() => visitors.get(origin)!.frames.slice(marks.get(origin)).filter(frame => frame.direction === "received" && frame.t === "delta" && frame.type === "install.address").map(frame => frame.data),
        { message: `${origin} receives the change on ${liveURL(origin)}` }).toEqual([{ bind: savedBind, origins: reordered }])
      const restored = await inPage(owner.page, "PUT", "/api/install", { origins: install.ownerSet })
      expect(restored.status, JSON.stringify(restored.body)).toBe(200)
    })

    await test.step("origins the owner did not set are refused", async () => {
      const teammate = visitors.get(install.ownerSet[0]!)!
      const known = new URL(install.ownerSet[0]!).host
      const network = (options: Parameters<typeof exchange>[2]) => exchange(install.address, install.ports.network, options)
      const refusals: Array<{ name: string; status: number; body: string }> = []
      const refused = async (name: string, options: Parameters<typeof exchange>[2], status: number, body: object) => {
        const answer = await network(options)
        refusals.push({ name, status: answer.status, body: answer.body.trim() })
        expect(answer.status, name).toBe(status)
        expect(JSON.parse(answer.body), name).toEqual(body)
        for (const header of Object.keys(answer.headers)) expect(header.startsWith("access-control-"), `${name}: ${header}`).toBe(false)
      }
      // An unknown Host is 421 before authentication, whatever the route: the API, the app, its bundle, the bootstrap document.
      for (const host of [new URL(install.unset).host, "evil.example", `localhost:${install.ports.network}`, new URL(install.loopback).host, `127.0.0.1:${install.ports.http}`])
        for (const path of ["/api/health", "/api/bootstrap", "/api/install", "/api/auth/github", "/"])
          await refused(`Host ${host} GET ${path}`, { host, path, headers: { Accept: "text/html" } }, 421, UNKNOWN_ORIGIN)
      // A network peer cannot name the host or the scheme through forwarding headers.
      await refused("forwarded host from the network", { host: "evil.example", path: "/api/health", headers: { "X-Forwarded-Host": known } }, 421, UNKNOWN_ORIGIN)
      const forwarded = await network({ host: known, path: "/api/auth/github", headers: { "X-Forwarded-Host": new URL(install.loopback).host, "X-Forwarded-Proto": "https" } })
      expect(forwarded.status).toBe(302)
      expect(new URL(String(forwarded.headers.location)).searchParams.get("redirect_uri"), "the network peer's forwarding headers are ignored").toBe(`${install.ownerSet[0]}/api/auth/github/callback`)
      expect([forwarded.headers["set-cookie"]].flat().join("\n"), "no header sets the cookie scheme").not.toMatch(/;\s*Secure/i)
      // A request whose Origin is not the effective origin is 403, for another known origin too.
      for (const foreign of ["http://evil.example", install.loopback, ...install.ownerSet.slice(1)])
        await refused(`Origin ${foreign} at ${known}`, { host: known, path: "/api/health", headers: { Origin: foreign } }, 403, ORIGIN_REFUSED)

      // The teammate's own session: a mutation needs the equal Origin and the CSRF token; a refusal changes nothing.
      const jar = await teammate.context.cookies(teammate.origin)
      const cookie = jar.map(each => `${each.name}=${each.value}`).join("; ")
      const csrf = jar.find(each => each.name === "__csrf")!.value
      const change = { method: "PUT", path: "/api/install", body: JSON.stringify({ origins: ["http://evil.example"] }) }
      const json = { "Content-Type": "application/json", Cookie: cookie }
      await refused("cookie mutation with a foreign Origin", { host: known, ...change, headers: { ...json, Origin: "http://evil.example", "X-CSRF-Token": csrf } }, 403, ORIGIN_REFUSED)
      await refused("cookie mutation with another known Origin", { host: known, ...change, headers: { ...json, Origin: install.loopback, "X-CSRF-Token": csrf } }, 403, ORIGIN_REFUSED)
      await refused("cookie mutation without an Origin", { host: known, ...change, headers: { ...json, "X-CSRF-Token": csrf } }, 403, ORIGIN_REFUSED)
      await refused("cookie mutation without the CSRF token", { host: known, ...change, headers: { ...json, Origin: teammate.origin } }, 403, CSRF_REFUSED)
      await refused("cookie mutation with a wrong CSRF token", { host: known, ...change, headers: { ...json, Origin: teammate.origin, "X-CSRF-Token": "0".repeat(64) } }, 403, CSRF_REFUSED)
      const upgrade = { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", Cookie: cookie }
      await refused("live upgrade with a foreign Origin", { host: known, path: "/api/live", headers: { ...upgrade, Origin: "http://evil.example" } }, 403, ORIGIN_REFUSED)
      await refused("live upgrade without an Origin", { host: known, path: "/api/live", headers: upgrade }, 403, ORIGIN_REFUSED)
      keep("refusals.json", refusals)
      expect((await inPage(owner.page, "GET", "/api/install")).body.address, "no refusal changed Address").toEqual({ listen: "network", bind: savedBind, origins: install.ownerSet })

      // In the browser: an origin that resolves to the install and was never set gets the same answer, and no app.
      const stranger = await browser.newContext()
      try {
        const page = await stranger.newPage()
        const answer = await page.goto(`${install.unset}/`)
        expect(answer?.status()).toBe(421)
        expect(JSON.parse(await page.locator("body").innerText())).toEqual(UNKNOWN_ORIGIN)
        expect(await stranger.cookies()).toEqual([])
      } finally { await stranger.close() }
    })

    await test.step("the served bundle calls no secure-context API of our own", async () => {
      const request = owner.context.request
      const index = await (await request.get(`${install.loopback}/`, { headers: { Accept: "text/html" } })).text()
      const pending = [...index.matchAll(/(?:src|href)="\/?(assets\/[A-Za-z0-9_.-]+\.js)"/g)].map(match => match[1]!)
      expect(pending.length, "the app document names its entry script").toBeGreaterThan(0)
      const scanned = new Map<string, string>()
      while (pending.length > 0) {
        const chunk = pending.pop()!
        if (scanned.has(chunk)) continue
        const served = await request.get(`${install.loopback}/${chunk}`)
        expect(served.status(), chunk).toBe(200)
        const source = await served.text()
        scanned.set(chunk, source)
        for (const match of source.matchAll(/["'`]\/?(?:\.\/|assets\/)([A-Za-z0-9_.-]+\.js)["'`]/g)) pending.push(`assets/${match[1]}`)
      }
      expect(scanned.size, "the scan follows the bundle's chunks").toBeGreaterThan(50)
      const matches: Array<{ chunk: string; needle: string; context: string; module?: string; safe?: string }> = []
      for (const [chunk, source] of scanned) for (const needle of NEEDLES) {
        for (let at = source.indexOf(needle); at !== -1; at = source.indexOf(needle, at + needle.length)) {
          const context = source.slice(Math.max(0, at - 90), at + needle.length + 30)
          const known = THIRD_PARTY_FORMS.find(form => form.needle === needle && form.form.test(context))
          matches.push({ chunk, needle, context, ...(known ? { module: known.module, safe: known.safe } : {}) })
        }
      }
      keep("bundle-grep.json", { chunks: scanned.size, needles: NEEDLES, matches })
      // Zero matches in our modules; each third-party match is listed with the form that keeps it off the plain-HTTP path.
      expect(matches.filter(match => match.module === undefined)).toEqual([])
    })

    await test.step("an origin the owner removes is refused on its next request and its next live connection", async () => {
      const gone = visitors.get(removed)!
      const marks = new Map(origins.map(origin => [origin, visitors.get(origin)!.frames.length]))
      const saved = await inPage(owner.page, "PUT", "/api/install", { origins: kept })
      expect(saved.status, JSON.stringify(saved.body)).toBe(200)
      expect(saved.body.address).toEqual({ listen: "network", bind: savedBind, origins: kept })
      expect(await inPage(gone.page, "GET", "/api/install")).toEqual({ status: 421, body: UNKNOWN_ORIGIN })
      expect(await inPage(gone.page, "GET", "/api/bootstrap")).toEqual({ status: 421, body: UNKNOWN_ORIGIN })
      const reconnect = await gone.page.evaluate(url => new Promise<string>(resolve => {
        const socket = new WebSocket(url)
        socket.onopen = () => resolve("open")
        socket.onerror = () => resolve("refused")
        setTimeout(() => resolve("pending"), 10_000)
      }), liveURL(removed))
      expect(reconnect, "the removed origin's next live connection").toBe("refused")
      const reloaded = await gone.page.reload()
      expect(reloaded?.status()).toBe(421)
      // Everyone else carries on: loopback and the kept origins answer, and learn of the change live.
      for (const origin of [install.loopback, ...kept]) {
        expect((await inPage(visitors.get(origin)!.page, "GET", "/api/install")).status, origin).toBe(200)
        await expect.poll(() => visitors.get(origin)!.frames.slice(marks.get(origin)).filter(frame => frame.direction === "received" && frame.t === "delta" && frame.type === "install.address").map(frame => frame.data),
          { message: `${origin} learns of the removal` }).toEqual([{ bind: savedBind, origins: kept }])
      }
      if (install.pid !== undefined) {
        const after = tree()
        keep("lsof-after-removal.txt", listenerReport(processTree(install.pid)))
        expect(listening(after, install.ports.http), "the loopback listener never closes").toContain("127.0.0.1")
      }
    })

    await test.step("no errors and no unhandled rejections on any origin", async () => {
      const report = Object.fromEntries(origins.map(origin => {
        const visitor = visitors.get(origin)!
        return [origin, { signedOut: failedResources(visitor, "signed-out"), signedIn: failedResources(visitor, "signed-in"), lines: visitor.lines }]
      }))
      keep("console.json", report)
      for (const origin of origins) {
        const visitor = visitors.get(origin)!
        // The removed origin's page was refused on purpose, after its slice passed; its 421s are that refusal.
        const lines = visitor.lines.filter(line => !(origin === removed && /status of 421|Unexpected response code: 421/.test(line.text)))
        expect(lines.filter(line => line.kind !== "console"), `${origin}: page errors and unhandled rejections`).toEqual([])
        // The signed-out door makes one setup probe, which may be refused.
        expect(lines.filter(line => line.at === "signed-out" && !line.url.endsWith("/api/install")), `${origin}: errors before sign-in`).toEqual([])
        expect(lines.filter(line => line.at === "signed-out" && line.url.endsWith("/api/install")).length).toBeLessThanOrEqual(1)
        expect(lines.filter(line => line.at === "signed-in"), `${origin}: console errors after sign-in`).toEqual([])
      }
      // An HTTP answer the app logs as failed must not depend on the origin: nothing fails at an owner-set origin that works on loopback.
      const loopbackFailures = report[install.loopback]!.signedIn
      for (const origin of install.ownerSet) expect(report[origin]!.signedIn.filter(failure => !loopbackFailures.includes(failure) && !(origin === removed && failure.startsWith("421 "))),
        `${origin}: requests that fail only off loopback`).toEqual([])
      expect(loopbackFailures, "failed requests on the install").toEqual([])
    })
  } finally {
    keep("connections.json", connections)
    keep("cookies.json", Object.fromEntries([...visitors].map(([origin, visitor]) => [origin, {
      start: visitor.start.cookies.map(line => line.replace(/=[^;]*/, "=…")), callback: visitor.callback.cookies.map(line => line.replace(/=[^;]*/, "=…")), redirectURI: visitor.start.redirectURI }])))
    keep("live-frames.json", Object.fromEntries([...visitors].map(([origin, visitor]) => [origin, { sockets: visitor.sockets, frames: visitor.frames.filter(frame => frame.t !== "snap" || frame.direction === "sent") }])))
    await info.attach("install-origins-evidence", { body: install.evidence, contentType: "text/plain" })
    for (const visitor of visitors.values()) await visitor.context.close()
  }
})
