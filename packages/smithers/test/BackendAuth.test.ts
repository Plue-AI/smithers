import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { request as httpRequest } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, describe, expect, it, vi } from "vitest"
import { auth, browserLogin } from "../src/internal/backend/Auth.ts"
import { Client, object } from "../src/internal/backend/Client.ts"
const dirs: string[] = []
const input = Object.getOwnPropertyDescriptor(process, "stdin")!
const platform = Object.getOwnPropertyDescriptor(process, "platform")!
afterEach(async () => {
  Object.defineProperty(process, "stdin", input)
  Object.defineProperty(process, "platform", platform)
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const fixture = async (env: Record<string, string> = {}) => {
  const home = await mkdtemp(join(tmpdir(), "one-cli-auth-"))
  dirs.push(home)
  const controller = new AbortController()
  const c = new Client({
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: home,
      SMITHERS_AUTH_FILE: join(home, "auth.json"),
      SMITHERS_API_ORIGIN: "https://api.example.test",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
      ...env
    },
    signal: controller.signal,
    stderr: { write: () => {}, isTTY: false, columns: 80 }
  })
  return { c, home, controller }
}
const callback = (url: string) => {
  const params = new URL(url).searchParams
  return { params, url: `http://127.0.0.1:${params.get("callback_port")}/callback` }
}
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", origin: new URL(url).origin, ...headers },
    body: JSON.stringify(body)
  })

describe("browser consent", () => {
  it("validates callback method, route, media type and state before saving a login", async () => {
    const { c } = await fixture()
    let complete!: Promise<void>
    const login = browserLogin(c, "https://api.example.test", true, "30m", (url) => {
      complete = (async () => {
        const { url: destination, params } = callback(url)
        expect(params.get("admin")).toBe("1")
        expect(params.get("ttl")).toBe("30m")
        expect((await fetch(destination.replace("callback", "other"))).status).toBe(404)
        expect((await fetch(destination, { method: "PUT" })).status).toBe(405)
        expect((await post(destination, {}, { "content-type": "text/plain" })).status).toBe(415)
        expect((await post(destination, { callback_state: "bad" })).status).toBe(403)
        expect(
          (await post(destination, {
            callback_state: params.get("callback_state"),
            token: "admin-secret",
            expires_at: new Date(Date.now() + 60_000).toISOString()
          })).status
        ).toBe(200)
      })()
    })
    expect(await login).toMatchObject({ token: "admin-secret" })
    await complete
  })
  it("refuses a DNS-rebinding page's Host or Origin even with the callback state", async () => {
    const { c } = await fixture()
    let complete!: Promise<void>
    const login = browserLogin(c, "https://api.example.test", false, "", (url) => {
      complete = (async () => {
        const { url: destination, params } = callback(url), state = params.get("callback_state")!
        const port = Number(new URL(destination).port)
        const rebound = (method: string, body?: string) =>
          new Promise<number>((resolve, reject) => {
            const req = httpRequest({
              host: "127.0.0.1",
              port,
              path: "/callback",
              method,
              headers: { host: `evil.example:${port}`, "content-type": "application/json" }
            }, (res) => {
              res.resume()
              resolve(res.statusCode ?? 0)
            })
            req.once("error", reject)
            req.end(body)
          })
        expect(await rebound("GET")).toBe(403)
        expect(await rebound("POST", JSON.stringify({ callback_state: state, token: "stolen" }))).toBe(403)
        expect(
          (await post(destination, { callback_state: state, token: "stolen" }, {
            origin: `http://evil.example:${port}`
          }))
            .status
        ).toBe(403)
        expect((await post(destination, { callback_state: state, token: "browser-secret" })).status).toBe(200)
      })()
    })
    expect(await login).toMatchObject({ token: "browser-secret" })
    await complete
  })
  it.each([{ token: " " }, { token: "a b" }, { token: "secret", expires_at: "2000-01-01" }])(
    "refuses invalid admin callback %j",
    async (value) => {
      const { c } = await fixture()
      let submitted!: Promise<Response>
      const login = browserLogin(c, "https://api.example.test", true, "", (url) => {
        const target = callback(url)
        submitted = post(target.url, { callback_state: target.params.get("callback_state"), ...value })
      })
      await expect(login).rejects.toThrow()
      expect((await submitted).status).toBe(400)
    }
  )
  it("expires an unresolved browser login", async () => {
    const { c } = await fixture()
    await expect(browserLogin(c, "https://api.example.test", false, "", () => {}, 1)).rejects.toThrow("Timed out")
  })
  it("cancels a pending browser login", async () => {
    const { c, controller } = await fixture()
    await expect(browserLogin(c, "https://api.example.test", false, "", () => controller.abort())).rejects.toThrow(
      "cancelled"
    )
  })
  it.each([false, true])("uses a one-time Observe handoff after browser consent (bad ticket=%s)", async (badTicket) => {
    const { c } = await fixture()
    c.session.saveConfig({ observe_url: "https://observe.example.test" })
    const request = vi.spyOn(c, "request").mockResolvedValue({ ticket: badTicket ? "invalid" : "t".repeat(43) })
    const actions: Promise<void>[] = []
    vi.spyOn(c, "exec").mockImplementation(async (_command, args) => {
      const url = args.at(-1)!
      actions.push((async () => {
        if (url.includes("/api/auth/github/cli")) {
          const target = callback(url)
          await post(target.url, {
            callback_state: target.params.get("callback_state"),
            token: "observe-secret",
            expires_at: new Date(Date.now() + 60_000).toISOString()
          })
          return
        }
        const params = new URLSearchParams(new URL(url).hash.slice(1)),
          origin = `http://127.0.0.1:${params.get("port")}`,
          destination = origin + "/observe"
        expect((await fetch(origin + "/wrong")).status).toBe(403)
        expect((await fetch(destination)).headers.get("referrer-policy")).toBe("no-referrer")
        expect((await post(destination, {})).status).toBe(403)
        expect((await post(destination, { state: "wrong", challenge: "c".repeat(43) }, { origin })).status).toBe(403)
        const response = await post(destination, { state: params.get("state"), challenge: "c".repeat(43) }, { origin })
        expect(response.status).toBe(badTicket ? 502 : 200)
        if (!badTicket) {
          const data = object(await response.json())
          expect(data.url).not.toContain("observe-secret")
          expect(data.url).toContain("ticket=")
        }
      })())
      return ""
    })
    const login = auth["auth login"]!(c, {}, { observe: true, ttl: "1h30m" })
    if (badTicket) await expect(login).rejects.toThrow("Observe sign-in failed")
    else expect(await login).toMatchObject({ status: "logged_in", admin: true })
    await Promise.all(actions)
    expect(request).toHaveBeenCalledWith("POST", "/api/v1/auth/browser-handoff", { challenge: "c".repeat(43) }, {
      origin: "https://observe.example.test",
      token: "observe-secret"
    })
  })
})

describe("subscription storage and owner input", () => {
  it("refuses Claude subscription logins and unsupported providers", async () => {
    const { c, home } = await fixture()
    vi.spyOn(c, "stdin").mockResolvedValue("API-key")
    await expect(auth["auth connect"]!(c, { provider: "claude" }, { "api-key": true })).rejects.toThrow("API key")
    await writeFile(join(home, ".credentials.json"), "{}")
    await expect(auth["auth connect"]!(c, { provider: "claude" }, { "config-dir": home })).rejects.toThrow(
      "never stored"
    )
    await expect(auth["auth connect"]!(c, { provider: "other" }, {})).rejects.toThrow("Provider")
  })
  it("never reads the Claude keychain entry", async () => {
    Object.defineProperty(process, "platform", { value: "darwin" })
    const { c, home } = await fixture()
    const exec = vi.spyOn(c, "exec").mockResolvedValue("{\"claudeAiOauth\":{\"accessToken\":\"oauth\"}}")
    const request = vi.spyOn(c, "request").mockResolvedValue({})
    await expect(auth["auth connect"]!(c, { provider: "claude" }, { "config-dir": home })).rejects.toThrow(
      "never stored"
    )
    expect(exec).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
  })
  it("deletes the legacy Claude setup token entry without reading it (#2777)", async () => {
    const { c } = await fixture()
    const keyring = vi.spyOn(c.session, "keyring").mockResolvedValue("")
    const exec = vi.spyOn(c, "exec")
    vi.spyOn(c, "stdin").mockResolvedValue("sk-ant-api03-key")
    const request = vi.spyOn(c, "request").mockResolvedValue({ id: "conn-1" })
    await auth["auth connect"]!(c, { provider: "claude" }, { "api-key": true })
    await expect(auth["auth connect"]!(c, { provider: "claude" }, {})).rejects.toThrow("never stored")
    expect(await auth["auth logout"]!(c, {}, {})).toMatchObject({ status: "logged_out" })
    const legacy = keyring.mock.calls.filter(([, host]) => host === "claude.subscription-token")
    expect(legacy).toEqual(Array(3).fill(["delete", "claude.subscription-token"]))
    expect(exec).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(1)

    keyring.mockClear().mockRejectedValue(new Error("Secure credential storage delete failed"))
    expect(await auth["auth logout"]!(c, {}, {})).toMatchObject({ status: "logged_out" })
    await auth["auth connect"]!(c, { provider: "codex" }, { "config-dir": "/nonexistent" }).catch(() => undefined)
    expect(keyring.mock.calls.filter(([, host]) => host === "claude.subscription-token")).toHaveLength(1)
  })
  it("validates owner identity and incomplete token receipts", async () => {
    const { c } = await fixture()
    const stdin = vi.spyOn(c, "stdin").mockResolvedValue("password"),
      request = vi.spyOn(c, "request").mockResolvedValue({})
    await expect(auth["auth local login"]!(c, {}, {})).rejects.toThrow("username")
    await expect(auth["auth local login"]!(c, {}, { username: "owner" })).rejects.toThrow("incomplete")
    expect(stdin).toHaveBeenCalledWith("Password")
    await expect(auth["auth local bootstrap"]!(c, {}, { username: "owner" })).rejects.toThrow("BOOTSTRAP_TOKEN")
    expect(request).toHaveBeenCalledTimes(1)
  })
  it.each(["hello", "", " ", "x".repeat(4 * 1024 * 1024 + 1)].map((value) => ({ value, size: value.length })))(
    "bounds stdin input ($size bytes)",
    async ({ value }) => {
      const { c } = await fixture()
      Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from([value]) })
      if (!value.trim() || value.length > 4 * 1024 * 1024) await expect(c.stdin("Secret")).rejects.toThrow()
      else expect(await c.stdin("Secret")).toBe(value)
    }
  )
})
