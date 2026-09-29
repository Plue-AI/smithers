import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { APIError, Client } from "../src/internal/backend/Client.ts"
import { remote } from "../src/internal/backend/SSH.ts"
import { claudeScript, workspaces, workspaceSSH } from "../src/internal/backend/Workspaces.ts"
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
const hostKey = { algorithm: "ssh-ed25519", public_key: key.split(" ")[1], known_hosts_line: key }
const guest = { command: "ssh guest", hostKeys: [key] }
const state = vi.hoisted(() => ({
  terminal: "stopped",
  sent: [] as unknown[],
  url: "",
  options: {} as unknown
}))
vi.mock(
  "../src/internal/backend/SSH.ts",
  async (original) => ({ ...await original<object>(), remote: vi.fn() })
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
  state.terminal = "stopped"
  state.sent = []
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
  const request = vi.spyOn(c, "request").mockImplementation(async (method, path) => {
    if (method === "GET" && path.endsWith("/ssh")) return { ssh_command: "ssh guest", host_keys: [hostKey] }
    if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "generated" }
    if (method === "GET" && path.endsWith("/command-runs/generated")) {
      return {
        operationId: "generated",
        state: "completed",
        result: {
          exit_code: 0,
          stdout: "",
          stderr: "",
          output_truncated: false
        }
      }
    }
    throw new Error(`Unexpected ${method} ${path}`)
  })
  vi.mocked(remote).mockResolvedValue(success())
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
  it("refuses a malformed advertised host key at once instead of polling", async () => {
    const { c, request } = await fixture({ SMITHERS_WORKSPACE_SSH_POLL_TIMEOUT_MS: "60000" })
    request.mockResolvedValue({ ssh_command: "ssh guest", host_keys: [{ known_hosts_line: "ssh-ed25519 not a key" }] })
    await expect(workspaceSSH(c, "box", options)).rejects.toThrow("Invalid workspace SSH host key")
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
  it("admits a command through the public command-runs API before polling its receipt", async () => {
    const { c, request } = await fixture()
    request.mockImplementation(async (method, path) => {
      if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "admitted" }
      if (method === "GET" && path.endsWith("/command-runs/admitted")) {
        return {
          operationId: "admitted",
          state: "completed",
          result: { exit_code: 0, stdout: "done", stderr: "", output_truncated: false }
        }
      }
      throw new Error(`Unexpected ${method} ${path}`)
    })
    await expect(
      workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "printf done", "exec-id": "admitted" })
    )
      .resolves.toMatchObject({ exit_code: 0, stdout: "done", stderr: "" })
    expect(request).toHaveBeenCalledWith("POST", "/api/repos/owner/repo/workspaces/box/command-runs", {
      operation_id: "admitted",
      args: ["/bin/bash", "-lc", "printf done"],
      environment: {}
    })
  })
  it("passes command, environment, and directory as API data", async () => {
    const { c, request, exit } = await fixture()
    request.mockImplementation(async (method, path) => {
      if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "retry" }
      if (method === "GET" && path.endsWith("/command-runs/retry")) {
        return {
          operationId: "retry",
          state: "completed",
          result: {
            exit_code: 9,
            stdout: "out",
            stderr: "err",
            output_truncated: false
          }
        }
      }
      throw new Error(`Unexpected ${method} ${path}`)
    })
    expect(
      await workspaces["workspace exec"]!(c, { id: "box" }, {
        ...options,
        command: "printf '$value'",
        env: ["VALUE=a b", "EMPTY="],
        cwd: "/a'b",
        "exec-id": "retry"
      })
    ).toMatchObject({ exit_code: 9, stdout: "out", stderr: "err" })
    expect(request).toHaveBeenCalledWith("POST", "/api/repos/owner/repo/workspaces/box/command-runs", {
      operation_id: "retry",
      args: ["/bin/bash", "-lc", "printf '$value'"],
      environment: { VALUE: "a b", EMPTY: "" },
      directory: "/a'b"
    })
    expect(exit).toHaveBeenCalledWith(9)
    expect(remote).not.toHaveBeenCalled()
  })
  it("polls a running command until its terminal result", async () => {
    const { c, request } = await fixture()
    let polls = 0
    request.mockImplementation(async (method, path) => {
      if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "poll" }
      if (method === "GET" && path.endsWith("/command-runs/poll")) {
        return ++polls === 1 ? { operationId: "poll", state: "running" } : {
          operationId: "poll",
          state: "completed",
          result: { exit_code: 0, stdout: "ready", stderr: "", output_truncated: false }
        }
      }
      throw new Error(`Unexpected ${method} ${path}`)
    })
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "sleep 1" }))
      .resolves.toMatchObject({ stdout: "ready", exit_code: 0 })
    expect(polls).toBe(2)
  })
  it.each(["failed", "uncertain", "cancelled"])(
    "reports %s without pretending the command completed",
    async (state) => {
      const { c, request } = await fixture()
      request.mockImplementation(async (method, path) => {
        if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "failure" }
        if (method === "GET" && path.endsWith("/command-runs/failure")) {
          return { operationId: "failure", state, error: "remote outcome unavailable" }
        }
        throw new Error(`Unexpected ${method} ${path}`)
      })
      await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "true" }))
        .rejects.toThrow()
    }
  )
  it.each([
    {
      receipt: { state: "completed", result: { exit_code: 0, stdout: "", stderr: "" } },
      label: "missing operation id"
    },
    {
      receipt: {
        operationId: "wrong",
        state: "completed",
        result: { exit_code: 0, stdout: "", stderr: "", output_truncated: false }
      },
      label: "wrong operation id"
    },
    { receipt: { operationId: "bad", state: "mystery" }, label: "unknown state" },
    {
      receipt: { operationId: "bad", state: "completed", result: { exit_code: "zero", stdout: "", stderr: "" } },
      label: "invalid exit code"
    }
  ])("rejects a $label receipt without rerunning the command", async ({ receipt }) => {
    const { c, request } = await fixture()
    request.mockImplementation(async (method, path) => {
      if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "bad" }
      if (method === "GET" && path.endsWith("/command-runs/bad")) return receipt
      throw new Error(`Unexpected ${method} ${path}`)
    })
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "true", "exec-id": "bad" }))
      .rejects.toThrow("--exec-id bad")
    expect(request.mock.calls.filter(([method, path]) => method === "POST" && path.endsWith("/command-runs")))
      .toHaveLength(1)
  })
  it("rejects a lost admission response with an explicit reattach id", async () => {
    const { c, request } = await fixture()
    request.mockRejectedValue(new Error("connection lost"))
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "true", "exec-id": "retry" }))
      .rejects.toThrow("--exec-id retry")
    expect(request).toHaveBeenCalledTimes(1)
  })
  it("uses one explicit operation id when the same command is submitted again", async () => {
    const { c, request } = await fixture()
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "true", "exec-id": "same" }))
        .resolves.toMatchObject({ exit_code: 0 })
    }
    const admissions = request.mock.calls.filter(([method, path]) =>
      method === "POST" && path.endsWith("/command-runs")
    )
    expect(admissions).toHaveLength(2)
    expect(admissions.map(([, , body]) => (body as Record<string, unknown>).operation_id)).toEqual(["same", "same"])
  })
  it.each(["abort", "timeout"])("cancels after %s and waits for a terminal receipt", async (reason) => {
    const { c, request, controller } = await fixture({ SMITHERS_WORKSPACE_COMMAND_POLL_INTERVAL_MS: "1" })
    let polls = 0
    request.mockImplementation(async (method, path) => {
      if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "cancel" }
      if (method === "GET" && path.endsWith("/command-runs/cancel")) {
        if (++polls === 1 && reason === "abort") controller.abort()
        return { operationId: "cancel", state: polls > 2 ? "cancelled" : "running" }
      }
      if (method === "POST" && path.endsWith("/command-runs/cancel/cancel")) {
        return { operationId: "cancel", state: "running" }
      }
      throw new Error(`Unexpected ${method} ${path}`)
    })
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, {
      ...options,
      command: "sleep 600",
      "exec-id": "cancel",
      timeout: reason === "timeout" ? 0.001 : 0
    })).rejects.toThrow("Command interrupted")
    expect(
      request.mock.calls.filter(([method, path]) => method === "POST" && path.endsWith("/command-runs/cancel/cancel"))
    )
      .toHaveLength(1)
    expect(polls).toBeGreaterThan(2)
  })
  it("keeps the reattach id when abort interrupts polling and cancellation cannot be confirmed", async () => {
    const { c, request, controller } = await fixture()
    request.mockImplementation(async (method, path) => {
      if (method === "POST" && path.endsWith("/command-runs")) return { operationId: "recover" }
      if (method === "GET" && path.endsWith("/command-runs/recover")) {
        controller.abort()
        throw new Error("poll request aborted")
      }
      if (method === "POST" && path.endsWith("/command-runs/recover/cancel")) {
        throw new Error("cancel connection lost")
      }
      throw new Error(`Unexpected ${method} ${path}`)
    })
    await expect(workspaces["workspace exec"]!(c, { id: "box" }, {
      ...options,
      command: "sleep 600",
      "exec-id": "recover"
    })).rejects.toThrow("--exec-id recover")
    expect(
      request.mock.calls.filter(([method, path]) => method === "POST" && path.endsWith("/command-runs/recover/cancel"))
    ).toHaveLength(1)
  })
  it.each([{ command: "" }, { command: "true", timeout: -1 }, { command: "true", env: ["bad-key=value"] }])(
    "rejects invalid exec options %j before admission",
    async (o) => {
      const { c, request } = await fixture()
      await expect(workspaces["workspace exec"]!(c, { id: "box" }, { ...options, ...o })).rejects.toThrow()
      expect(request.mock.calls.some(([method, path]) => method === "POST" && path.endsWith("/command-runs"))).toBe(
        false
      )
    }
  )
  it("seeds Claude API credentials over stdin with private guest ownership", async () => {
    const { c, request } = await fixture({ ANTHROPIC_API_KEY: "sk-ant-api03-key" })
    const protect = vi.spyOn(c, "protect")
    await workspaces["workspace exec"]!(c, { id: "box" }, {
      ...options,
      command: "true",
      seedAgentAuth: "CLAUDE,claude"
    })
    expect(protect).toHaveBeenCalledWith("sk-ant-api03-key")
    expect(protect.mock.invocationCallOrder[0]).toBeLessThan(request.mock.invocationCallOrder[0]!)
    expect(remote).toHaveBeenCalledTimes(1)
    const call = vi.mocked(remote).mock.calls[0]!
    expect(call[2]).toBe("bash -s")
    let stdin = ""
    for await (const chunk of call[4]!) stdin += chunk
    expect(stdin).toContain("chmod 600")
    expect(stdin).toContain("chown -R developer:developer")
    expect(JSON.stringify(call.slice(0, 4).slice(1))).not.toContain("subscription")
  })
  it.each([undefined, "custom-codex"])(
    "refuses Codex credential seeding without reading or sending the local login (%s)",
    async (codexDirectory) => {
      const custom = codexDirectory === undefined ? undefined : await mkdtemp(join(tmpdir(), "codex-seed-"))
      if (custom !== undefined) dirs.push(custom)
      const { c, home, request } = await fixture({
        ANTHROPIC_API_KEY: "sk-ant-api03-key",
        ...(custom === undefined ? {} : { CODEX_HOME: custom })
      })
      const directory = custom ?? join(home, ".codex")
      if (custom === undefined) await mkdir(directory)
      await writeFile(
        join(directory, "auth.json"),
        JSON.stringify({
          tokens: { access_token: "local-access-secret", refresh_token: "local-refresh-secret" }
        })
      )
      const protect = vi.spyOn(c, "protect")
      for (const seedAgentAuth of ["CODEX,codex", "claude,codex", "codex,claude"]) {
        await expect(workspaces["workspace exec"]!(c, { id: "box" }, {
          ...options,
          command: "true",
          seedAgentAuth
        })).rejects.toMatchObject({
          fault: "user",
          code: "not_signed_in",
          message: "Run `codex login --device-auth` on the workspace; Codex subscriptions are never sent to a workspace"
        })
      }
      expect(protect).not.toHaveBeenCalledWith("local-access-secret")
      expect(protect).not.toHaveBeenCalledWith("local-refresh-secret")
      expect(remote).not.toHaveBeenCalled()
      expect(request.mock.calls.some(([method, path]) => method === "POST" && path.endsWith("/command-runs"))).toBe(
        false
      )
    }
  )
  it("never seeds a Claude subscription token (#2777)", async () => {
    for (
      const env of [{ ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-subscription" }, {
        ANTHROPIC_API_KEY: "sk-ant-oat01-subscription"
      }]
    ) {
      const { c, home } = await fixture(env)
      await writeFile(
        join(home, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-login" } })
      )
      await expect(
        workspaces["workspace exec"]!(c, { id: "box" }, { ...options, command: "true", seedAgentAuth: "claude" })
      ).rejects.toThrow("ANTHROPIC_API_KEY")
    }
    expect(remote).not.toHaveBeenCalled()
  })
  it.each([
    undefined,
    "",
    "sk-ant-oat01-subscription",
    "sk-ant-api",
    "sk-ant-api--",
    "sk-ant-api03--",
    "not-an-api-key"
  ])(
    "refuses Claude seeding with key %j before workspace lookup or creation",
    async (key) => {
      const { c, request } = await fixture(key === undefined ? {} : { ANTHROPIC_API_KEY: key })
      const protect = vi.spyOn(c, "protect")
      await expect(workspaces["workspace exec"]!(c, {}, { ...options, command: "true", seedAgentAuth: "claude" }))
        .rejects.toMatchObject({
          fault: "user",
          code: "not_signed_in",
          message: "ANTHROPIC_API_KEY is required; Claude subscriptions are never sent to a workspace"
        })
      expect(request).not.toHaveBeenCalled()
      expect(remote).not.toHaveBeenCalled()
      expect(protect).not.toHaveBeenCalled()
    }
  )
  it("refuses unsupported or blank credential seeding before creating or looking up a workspace", async () => {
    const { c, request } = await fixture({ ANTHROPIC_API_KEY: "sk-ant-api03-key" })
    for (const seedAgentAuth of ["other", "claude,other", "other,claude", "", ",", " , "]) {
      await expect(workspaces["workspace exec"]!(c, {}, { ...options, command: "true", seedAgentAuth })).rejects
        .toThrow("claude API keys")
    }
    for (const seedAgentAuth of ["codex", "claude,codex"]) {
      await expect(workspaces["workspace exec"]!(c, {}, { ...options, command: "true", seedAgentAuth })).rejects
        .toMatchObject({ code: "not_signed_in", fault: "user" })
    }
    expect(remote).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
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
    const f = await fixture({ ANTHROPIC_API_KEY: "sk-ant-api03-key" })
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
