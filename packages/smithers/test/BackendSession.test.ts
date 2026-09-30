import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { inspect } from "node:util"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Client } from "../src/internal/backend/Client.ts"
import { NotFound, run } from "../src/internal/backend/Process.ts"
import { normalizeOrigin, observeOrigin, Session } from "../src/internal/backend/Session.ts"
vi.mock("../src/internal/backend/Process.ts", async (actual) => ({ ...await actual(), run: vi.fn() }))
const spawn = vi.mocked(run)
const platform = Object.getOwnPropertyDescriptor(process, "platform")!
const dirs: string[] = []
afterEach(async () => {
  Object.defineProperty(process, "platform", platform)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  spawn.mockReset()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const fixture = async (env: Record<string, string> = {}) => {
  const home = await mkdtemp(join(tmpdir(), "one-cli-session-"))
  dirs.push(home)
  const environment = {
    HOME: home,
    XDG_CONFIG_HOME: home,
    SMITHERS_AUTH_FILE: join(home, "auth.json"),
    SMITHERS_API_ORIGIN: "https://api.example.test",
    ...env
  }
  return { home, environment, session: new Session(environment) }
}
const result = (stdout = "", code = 0, stderr = "") => Promise.resolve({ code, stdout, stderr })
const missing = () => new NotFound("pwsh")
describe("native login stores", () => {
  it("falls back from pwsh to Windows PowerShell and replaces the previous credential", async () => {
    Object.defineProperty(process, "platform", { value: "win32" })
    const { session } = await fixture()
    spawn.mockRejectedValueOnce(missing()).mockReturnValueOnce(result())
    await session.keyring("set", "example.test", "replacement-secret")
    expect(spawn.mock.calls.map(([command]) => command)).toEqual(["pwsh", "powershell"])
    expect(JSON.stringify(spawn.mock.calls[1]![1])).toContain("$v.Remove")
    expect(JSON.stringify(spawn.mock.calls[1]![1])).not.toContain("replacement-secret")
  })
  it.each(["darwin", "linux", "win32"])("uses native %s storage without a secret in argv", async (os) => {
    Object.defineProperty(process, "platform", { value: os })
    const { session } = await fixture()
    spawn.mockReturnValue(result())
    expect(await session.keyring("set", "example.test", "private-secret")).toBe("")
    const call = spawn.mock.calls[0]!
    expect(JSON.stringify(call.slice(0, 2))).not.toContain("private-secret")
    if (os === "win32") expect(call[2]).toMatchObject({ env: { SMITHERS_CRED_TOKEN: "private-secret" } })
    else expect(call[2]).toMatchObject({ input: expect.stringContaining("private-secret") })
    spawn.mockReturnValue(result("private-secret\n"))
    expect(await session.keyring("get", "example.test")).toBe("private-secret")
    spawn.mockReturnValue(result())
    expect(await session.keyring("delete", "example.test")).toBe("")
  })
  it("falls back to a private auth file only when the native store is unavailable", async () => {
    const { session, home } = await fixture()
    spawn.mockRejectedValue(missing())
    await session.save("https://api.example.test", "fallback-secret", { username: "owner" })
    expect((await stat(join(home, "auth.json"))).mode & 0o777).toBe(0o600)
    expect(await session.require()).toMatchObject({ source: "smithers_auth_file", token: "fallback-secret" })
    expect(await readFile(session.configPath, "utf8")).not.toContain("fallback-secret")
  })
  it("does not duplicate a native credential into the auth file", async () => {
    const { session } = await fixture()
    spawn.mockReturnValue(result())
    await session.save("https://api.example.test", "native-secret")
    expect(await readFile(session.authPath, "utf8")).not.toContain("native-secret")
    spawn.mockReturnValue(result("native-secret"))
    expect(await session.require()).toMatchObject({ source: "keyring", token: "native-secret" })
  })
  it("surfaces a locked store and preserves an existing fallback login", async () => {
    const { session } = await fixture()
    session.saveConfig({ api_origin: "https://api.example.test" })
    spawn.mockReturnValue(result("", 1, "keychain locked"))
    await expect(session.resolve()).rejects.toThrow("Secure credential")
    await writeFile(session.authPath, JSON.stringify({ api_url: "https://api.example.test", token: "fallback" }))
    expect((await session.resolve())?.token).toBe("fallback")
  })
  it.each(["darwin", "linux"])("handles an absent %s credential", async (os) => {
    Object.defineProperty(process, "platform", { value: os })
    const { session } = await fixture()
    spawn.mockReturnValue(result("", os === "darwin" ? 44 : 1))
    expect(await session.keyring("get", "example.test")).toBe("")
  })
  it.each([
    ["darwin", "delete-generic-password"],
    ["linux", "\"secret-tool\",[\"clear\""],
    ["win32", "$v.Remove($v.Retrieve"]
  ])("deletes a configured native %s login even without an auth record", async (os, command) => {
    Object.defineProperty(process, "platform", { value: os })
    const { session } = await fixture()
    session.saveConfig({ api_origin: "https://api.example.test" })
    spawn.mockReturnValue(result())
    await session.clear()
    expect(JSON.stringify(spawn.mock.calls)).toContain(command)
  })
  it("migrates a legacy config token on login and removes it on logout", async () => {
    const { session } = await fixture({ SMITHERS_DISABLE_SYSTEM_KEYRING: "1" })
    await mkdir(join(session.configPath, ".."), { recursive: true })
    await writeFile(session.configPath, "api_url: https://api.example.test\ntoken: legacy-secret\n")
    expect((await session.require()).token).toBe("legacy-secret")
    await session.clear()
    expect(await readFile(session.configPath, "utf8")).not.toContain("legacy-secret")
    expect(await session.resolve()).toBeUndefined()
  })
  it.each(["", "a b", "a\nb", " padded", "x' -w y' ; delete-keychain", "x\"y", "x\\y", "x$(id)"])(
    "rejects invalid stored tokens %j before any keychain command",
    async (token) => {
      Object.defineProperty(process, "platform", { value: "darwin" })
      const { session } = await fixture()
      await expect(session.save("https://api.example.test", token)).rejects.toThrow("token")
      expect(spawn).not.toHaveBeenCalled()
    }
  )
  it.each([
    "ftp://example.test",
    "https://user:password@example.test",
    "https://example.test/path",
    "https://example.test?q=x",
    "https://example.test#secret"
  ])("rejects an unsafe API origin %s", (origin) => expect(() => normalizeOrigin(origin)).toThrow())
  it("normalizes API suffixes and enforces secure Observe origins", () => {
    expect(normalizeOrigin("https://api.example.test/api/")).toBe("https://api.example.test")
    expect(observeOrigin("http://127.0.0.1:8000")).toBe("http://127.0.0.1:8000")
    expect(() => observeOrigin("http://example.test")).toThrow("HTTPS")
  })
  it.each([
    ["", "observe_url is not configured; run `smithers config set observe_url https://<your Observe console>`"],
    ["  ", "observe_url is not configured"],
    ["example.test", "observe_url must be an HTTPS origin"],
    ["https://observe.example.test/console", "observe_url must be an HTTPS origin"]
  ])("names observe_url when it is missing or malformed (%j)", (raw, message) => {
    expect(() => observeOrigin(raw)).toThrow(message)
    expect(() => observeOrigin(raw)).not.toThrow("Smithers API origin")
  })
  it.each(["https://api.example.test", "example.test", "localhost:8000"])(
    "resolves configured host %s",
    async (host) => {
      const { session } = await fixture()
      expect(session.target(host).api_url).toBe(
        host.startsWith("localhost") ? "http://localhost:8000" : "https://api.example.test"
      )
    }
  )
})

describe("authenticated transport boundaries", () => {
  it("makes stderr controls inert after redaction while retaining multiline whitespace", () => {
    let output = ""
    const c = new Client({ stderr: { write: (text) => void (output += text), isTTY: false, columns: 80 } })
    c.protect("synthetic-sse-secret")
    c.write("before\u001b]0;changed\u0007\u001b[2J\u009b31mred\u0000\u202e\r\n\tsecond synthetic-sse-secret\n")
    expect(output).toBe("beforered\n\tsecond [REDACTED]\n")
  })

  it("redacts a saved token split across live chunks and UTF-8 boundaries", async () => {
    const { environment } = await fixture({
      SMITHERS_TOKEN: "private-session-secret",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1"
    })
    let output = ""
    const c = new Client({
      environment,
      stdout: {
        write: (text) => {
          output += text
        },
        isTTY: false,
        columns: 80
      }
    }, true)
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}")))
    await c.request("GET", "/api/user")
    const bytes = Buffer.from("🙂 private-session-secret\ntail")
    for (let i = 0; i < bytes.length; i++) c.output(bytes.subarray(i, i + 1), Buffer.alloc(0))
    c.flushOutput()
    expect(output).toContain("🙂")
    expect(output).toContain("tail")
    expect(output).not.toContain("private-session-secret")
  })
  it("redacts a private key and an inspected string split over live lines and chunks", async () => {
    const { environment } = await fixture()
    const secret = "ZqSynthetic7Secret4Value9"
    let output = ""
    const sink = { write: (text: string) => void (output += text), isTTY: false, columns: 80 }
    const c = new Client({ environment, stdout: sink, stderr: sink }, true)
    const pem = `-----BEGIN PRIVATE KEY-----\n${secret}${secret}\n${secret}\n-----END PRIVATE KEY-----\n`
    const bytes = Buffer.from(`${pem}${inspect({ privateKey: `${secret}\n`.repeat(8) })}\ndone`)
    for (let i = 0; i < bytes.length; i += 7) c.output(Buffer.alloc(0), bytes.subarray(i, i + 7))
    c.flushOutput()
    expect(output).not.toContain(secret)
    expect(output).toContain("[REDACTED]")
    expect(output.endsWith("done")).toBe(true)
  })
  it("redacts diagnostic credential spellings on stderr, errors and live output", async () => {
    const { environment } = await fixture()
    const secret = "ZqSynthetic7Secret4Value9"
    let output = ""
    const sink = { write: (text: string) => void (output += text), isTTY: false, columns: 80 }
    const c = new Client({ environment, stdout: sink, stderr: sink }, true)
    c.protect("session-only-value")
    c.write(`sshpass -p ${secret} ssh host session-only-value\n`)
    expect(c.redact(`Authorization: Token ${secret}`)).toBe("Authorization: [REDACTED]")
    c.output(Buffer.from(`Authorization: Token ${secret}\n`), Buffer.from(`mysql -p${secret} db\n`))
    c.flushOutput()
    expect(output).not.toContain(secret)
    expect(output).not.toContain("session-only-value")
    expect(output).toContain("sshpass -p [REDACTED] ssh host")
  })
  it("redacts every line of a multi-line session secret in live output", async () => {
    const { environment } = await fixture()
    const secret = "ZqSynthetic7Secret4Value9\nQxSynthetic3Second8Line"
    let output = ""
    const sink = { write: (text: string) => void (output += text), isTTY: false, columns: 80 }
    const c = new Client({ environment, stdout: sink, stderr: sink }, true)
    c.protect(secret)
    c.output(Buffer.from(`begin\n${secret}\nend\n`), Buffer.alloc(0))
    c.flushOutput()
    expect(output).not.toContain("ZqSynthetic7Secret4Value9")
    expect(output).not.toContain("QxSynthetic3Second8Line")
    expect(output).toContain("end")
  })
  it("bounds JSON payload reads and preserves empty responses", async () => {
    const { environment } = await fixture()
    const c = new Client({ environment })
    await expect(c.text(new Response("too long"), 2)).rejects.toThrow("maximum")
    expect(await c.text(new Response(null))).toBe("")
    vi.spyOn(c, "response").mockResolvedValue(new Response(null, { status: 204 }))
    expect(await c.request("DELETE", "/item")).toBeNull()
  })
  it.each(["https://evil.test", "//evil.test/path"])("rejects an absolute request destination %s", async (path) => {
    const { environment } = await fixture()
    const c = new Client({ environment })
    await expect(c.response("GET", path)).rejects.toThrow("API path")
  })
  it("refuses repeated pagination cursors", async () => {
    const { environment } = await fixture()
    const c = new Client({ environment })
    vi.spyOn(c, "response").mockImplementation(async () => new Response("[]", { headers: { "x-next-cursor": "same" } }))
    await expect(c.pages((cursor) => `/items?cursor=${cursor}`, "", true)).rejects.toThrow("repeated")
  })
  it("includes the next-page cursor when pagination is not requested", async () => {
    const { environment } = await fixture()
    const c = new Client({ environment })
    vi.spyOn(c, "response").mockResolvedValue(new Response("[1]", { headers: { "x-next-cursor": "next" } }))
    expect(await c.pages(() => "/items")).toEqual({ items: [1], next_cursor: "next" })
  })
  it("preserves plain-text SSE, ignores heartbeats, and reads an unterminated final event", async () => {
    const { environment } = await fixture()
    const c = new Client({ environment, stderr: { write: () => {}, isTTY: false, columns: 80 } })
    vi.spyOn(c, "response").mockResolvedValue(
      new Response(":heartbeat\n\nevent: log\ndata: hello\ndata: world\n\ndata: tail")
    )
    expect(await c.events("/stream")).toEqual([{ type: "log", data: "hello\nworld" }, { type: "log", data: "tail" }])
  })
  it("returns a bounded process error without stderr or secrets", async () => {
    const { environment } = await fixture()
    const c = new Client({ environment })
    spawn.mockReturnValue(result("", 1, "secret diagnostic"))
    await expect(c.exec("git", ["push"])).rejects.toThrow(/^git failed$/)
    spawn.mockReturnValue(result("  output  \n"))
    expect(await c.exec("jj", ["status"])).toBe("output")
  })
})
