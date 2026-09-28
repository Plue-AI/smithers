import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { APIError, Client } from "../src/internal/backend/Client.ts"
import { durable, remote } from "../src/internal/backend/SSH.ts"
import { claudeScript, workspaces, workspaceSSH } from "../src/internal/backend/Workspaces.ts"
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
const hostKey = { algorithm: "ssh-ed25519", public_key: key.split(" ")[1], known_hosts_line: key }
const guest = { command: "ssh guest", hostKeys: [key] }
const state = vi.hoisted(() => ({
  terminal: "stopped",
  sent: [] as unknown[],
  url: "",
  options: {} as unknown,
  character: true
}))
vi.mock(
  "node:fs",
  async (original) => ({ ...await original<object>(), fstatSync: () => ({ isCharacterDevice: () => state.character }) })
)
vi.mock(
  "../src/internal/backend/SSH.ts",
  async (original) => ({ ...await original<object>(), remote: vi.fn(), durable: vi.fn() })
)
vi.mock("@effect/platform-node/NodeSocket", async () => {
  const { EventEmitter } = await import("node:events")
  return {
    NodeWS: {
      WebSocket: class extends EventEmitter {
        closed = false
        constructor(url: string, options: unknown) {
          super()
          state.url = url
          state.options = options
          queueMicrotask(() => {
            if (state.terminal === "error") {
              this.emit("error", new Error("socket failed"))
              return
            }
            this.emit("open")
            this.emit("message", Buffer.from("hello"), true)
            this.emit("message", Buffer.from("not json"), false)
            this.emit("message", Buffer.from(JSON.stringify({ type: "status", status: state.terminal })), false)
          })
        }
        send(value: unknown) {
          state.sent.push(value)
        }
        close() {
          if (!this.closed) {
            this.closed = true
            this.emit("close")
          }
        }
      }
    }
  }
})
const dirs: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(remote).mockReset()
  vi.mocked(durable).mockReset()
  state.terminal = "stopped"
  state.sent = []
  state.character = true
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const success = (stdout = "", code = 0) => ({ code, stdout: Buffer.from(stdout), stderr: Buffer.alloc(0) })
const fixture = async (environment: Record<string, string> = {}) => {
  const home = await mkdtemp(join(tmpdir(), "one-cli-box-"))
  dirs.push(home)
  const exit = vi.fn(), controller = new AbortController()
  const c = new Client({
    environment: {
      HOME: home,
      SMITHERS_API_ORIGIN: "https://api.example.test",
      SMITHERS_TOKEN: "login-secret",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
      SMITHERS_WORKSPACE_SSH_POLL_INTERVAL_MS: "1",
      SMITHERS_WORKSPACE_SSH_POLL_TIMEOUT_MS: "5",
      ...environment
    },
    exit,
    signal: controller.signal
  })
  const request = vi.spyOn(c, "request").mockResolvedValue({ ssh_command: "ssh guest", host_keys: [hostKey] })
  vi.mocked(remote).mockResolvedValue(success())
  vi.mocked(durable).mockResolvedValue(success())
  return { c, home, exit, request, controller }
}
const options = { repo: "owner/repo" }
describe("box remote execution", () => {
  it("polls transient SSH errors and preserves requested user", async () => {
    const { c, request } = await fixture({ SMITHERS_WORKSPACE_SSH_POLL_TIMEOUT_MS: "1000" })
    request.mockRejectedValueOnce(new APIError(503, {}, "GET", "/ssh", new Headers())).mockResolvedValueOnce({
      command: "ssh ready",
      host_keys: [hostKey]
    })
    expect(await workspaceSSH(c, "box", { ...options, user: "root" })).toEqual({
      command: "ssh ready",
      hostKeys: [key]
    })
    expect(request.mock.calls[0]![1]).toEqual(expect.stringContaining("/ssh?user=root"))
  })
  it("stops immediately for denied SSH access", async () => {
    const { c, request } = await fixture()
    request.mockRejectedValue(new APIError(403, {}, "GET", "/ssh", new Headers()))
    await expect(workspaceSSH(c, "box", options)).rejects.toThrow("403")
    expect(request).toHaveBeenCalledTimes(1)
  })
  it("times out missing SSH receipts", async () => {
    const { c, request } = await fixture()
    request.mockResolvedValue({})
    await expect(workspaceSSH(c, "box", options)).rejects.toThrow("SSH-ready")
  })
  it("honors abort while polling", async () => {
    const { c, request, controller } = await fixture()
    request.mockResolvedValue({})
    controller.abort()
    await expect(workspaceSSH(c, "box", options)).rejects.toThrow()
  })
  it("opens an interactive SSH connection and returns its exit status", async () => {
    const { c, exit } = await fixture()
    vi.mocked(remote).mockResolvedValue(success("", 7))
    expect(await workspaces["workspace ssh"]!(c, { id: "box" }, options)).toMatchObject({ connected: false })
    expect(remote).toHaveBeenCalledWith(c, guest, undefined, 0, undefined, true)
    expect(exit).toHaveBeenCalledWith(7)
  })
  it("uses a durable command receipt and passes shell inputs as data", async () => {
    const { c, exit } = await fixture()
    vi.mocked(durable).mockResolvedValue({ code: 9, stdout: Buffer.from("out"), stderr: Buffer.from("err") })
    expect(
      await workspaces["workspace exec"]!(c, { id: "box" }, {
        ...options,
        command: "printf '$value'",
        env: ["VALUE=a b"],
        cwd: "/a'b",
        "exec-id": "retry"
      })
    ).toMatchObject({ exit_code: 9, stdout: "out", stderr: "err" })
    const call = vi.mocked(durable).mock.calls[0]!
    expect(call[1]).toBe("retry")
    expect(call[2]).toContain("'VALUE=a b'")
    expect(call[2]).toContain("'\"'\"'")
    expect(await call[3]("control")).toBe("")
    expect(exit).toHaveBeenCalledWith(9)
  })
  it("keeps a failed SSH control call retryable", async () => {
    const { c } = await fixture()
    vi.mocked(remote).mockResolvedValue(success("", 255))
    vi.mocked(durable).mockImplementation(async (_c, _id, _script, send) => {
      await send("control")
      return success()
    })
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "true" })).rejects.toThrow(
      "SSH control"
    )
  })
  it("forwards piped stdin without creating a durable retry receipt", async () => {
    const { c } = await fixture()
    state.character = false
    expect(await workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "cat", timeout: 0 }))
      .toMatchObject({ exit_code: 0 })
    expect(durable).not.toHaveBeenCalled()
    expect(remote).toHaveBeenCalledWith(c, guest, expect.stringContaining("cat"), 0, process.stdin, false, true)
  })
  it.each([{ command: "" }, { command: "true", timeout: -1 }, { command: "true", env: ["bad-key=value"] }])(
    "rejects invalid exec options %j",
    async (o) => {
      const { c } = await fixture()
      await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, ...o })).rejects.toThrow()
      expect(durable).not.toHaveBeenCalled()
    }
  )
  it.each(["claude", "codex"])("seeds %s credentials over stdin with private guest ownership", async (provider) => {
    const { c, home } = await fixture({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-subscription" })
    await mkdir(join(home, ".codex"))
    await writeFile(
      join(home, ".codex/auth.json"),
      JSON.stringify({ tokens: { access_token: "subscription", refresh_token: "refresh" } })
    )
    await workspaces["workspace exec"]!(c, { id: "box" }, {
      ...options,
      command: "true",
      seedAgentAuth: provider.toUpperCase() + "," + provider
    })
    expect(remote).toHaveBeenCalledTimes(1)
    const call = vi.mocked(remote).mock.calls[0]!
    expect(call[2]).toBe("bash -s")
    let stdin = ""
    for await (const chunk of call[4]!) stdin += chunk
    expect(stdin).toContain("chmod 600")
    expect(stdin).toContain("chown -R developer:developer")
    expect(JSON.stringify(call.slice(0, 4).slice(1))).not.toContain("subscription")
  })
  it("refuses an unsupported agent credential kind", async () => {
    const { c } = await fixture()
    await expect(
      workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "true", seedAgentAuth: "other" })
    ).rejects.toThrow("claude,codex")
  })
  it.each(["stopped", "failed", "error"])("cleans up a terminal on %s", async (terminal) => {
    const { c, request, exit } = await fixture()
    state.terminal = terminal
    request.mockResolvedValue({ id: "terminal" })
    vi.spyOn(process.stdout, "write").mockReturnValue(true)
    if (terminal === "error") {
      await expect(workspaces["workspace shell"]!(c, { id: "box" }, { ...options, cols: 100, rows: 40 })).rejects
        .toThrow("socket failed")
    } else await workspaces["workspace shell"]!(c, { id: "box" }, { ...options, cols: 100, rows: 40 })
    expect(state.url).toBe("wss://api.example.test/api/repos/owner/repo/workspace/sessions/terminal/terminal")
    expect(state.options).toMatchObject({ headers: { Authorization: "token login-secret" } })
    expect(request).toHaveBeenLastCalledWith("POST", "/api/repos/owner/repo/workspace/sessions/terminal/destroy")
    if (terminal === "failed") expect(exit).toHaveBeenCalledWith(1)
  })
  it("requires an actual terminal id", async () => {
    const { c, request } = await fixture()
    request.mockResolvedValue({})
    await expect(workspaces["workspace shell"]!(c, { id: "box" }, options)).rejects.toThrow("omitted id")
  })
})

describe("issue to landing", () => {
  const prepare = async () => {
    const f = await fixture({ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-subscription" })
    f.request.mockImplementation(async (method, path) =>
      path.endsWith("/issues/7")
        ? { title: "Fix $quoting", body: "Details", labels: [{ name: "bug" }] }
        : path.endsWith("/ssh")
        ? { ssh_command: "ssh guest", host_keys: [hostKey] }
        : path.endsWith("/landings")
        ? { number: 12 }
        : method === "POST"
        ? { id: "box" }
        : {}
    )
    return f
  }
  it("runs Claude as developer and lands changes in parent-first order", async () => {
    const { c, request } = await prepare()
    vi.mocked(remote).mockResolvedValueOnce(success()).mockResolvedValueOnce(success()).mockResolvedValueOnce(
      success("parent\nchild\n")
    )
    expect(await workspaces["workspace issue"]!(c, { number: 7 }, options)).toMatchObject({
      landing_request: 12,
      change_ids: ["parent", "child"]
    })
    const script = vi.mocked(remote).mock.calls[1]![2]!
    expect(script).toContain("runuser -u developer")
    expect(script).toContain("--no-session-persistence")
    expect(script).toContain("--dangerously-skip-permissions")
    expect(vi.mocked(remote).mock.calls[2]![2]).toContain("--reversed")
    expect(request).toHaveBeenLastCalledWith(
      "POST",
      "/api/repos/owner/repo/landings",
      expect.objectContaining({ target_bookmark: "main", change_ids: ["parent", "child"] })
    )
  })
  it("does not create an empty landing", async () => {
    const { c, request } = await prepare()
    expect(await workspaces["workspace issue"]!(c, { number: 7 }, options)).toMatchObject({
      status: "completed",
      change_ids: []
    })
    expect(request.mock.calls.some(([, path]) => path.endsWith("/landings"))).toBe(false)
  })
  it("retains the box and reports diagnostics after a failed Claude run", async () => {
    const { c, request, exit } = await prepare()
    vi.mocked(remote).mockResolvedValueOnce(success()).mockResolvedValueOnce(success("", 7)).mockResolvedValueOnce(
      success("missing node")
    )
    await expect(workspaces["workspace issue"]!(c, { number: 7 }, options)).rejects.toThrow(
      "Workspace diagnostics:\nmissing node"
    )
    expect(exit).toHaveBeenCalledWith(7)
    expect(request.mock.calls.some(([method]) => method === "DELETE")).toBe(false)
  })
  it("refuses an unreadable change receipt", async () => {
    const { c } = await prepare()
    vi.mocked(remote).mockResolvedValueOnce(success()).mockResolvedValueOnce(success()).mockResolvedValueOnce(
      success("", 1)
    )
    await expect(workspaces["workspace issue"]!(c, { number: 7 }, options)).rejects.toThrow("read workspace changes")
  })
  it("encodes hostile prompt text as data and keeps subscription tokens out of the script", () => {
    const prompt = "$(touch /tmp/should-not-exist)'\nFix it"
    const script = claudeScript(prompt)
    expect(script).not.toContain(prompt)
    expect(script).toContain(Buffer.from(prompt).toString("base64"))
  })
})
