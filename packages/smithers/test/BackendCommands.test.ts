import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { main } from "../src/cli/Entry.ts"
import { type Host, repoFromRemote, resolveRepo } from "../src/commands/Open.ts"
import { ask } from "../src/internal/backend/AgentDocs.ts"
import { auth } from "../src/internal/backend/Auth.ts"
import { APIError, Client, object } from "../src/internal/backend/Client.ts"
import { local } from "../src/internal/backend/Local.ts"
import { misc } from "../src/internal/backend/Misc.ts"
import { repositories } from "../src/internal/backend/Repositories.ts"
import { stacks } from "../src/internal/backend/Stack.ts"
import { resolveID, workspaces } from "../src/internal/backend/Workspaces.ts"

const dirs: string[] = []
const cwd = process.cwd()
afterEach(async () => {
  process.chdir(cwd)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true })
})
const fixture = async (env: Record<string, string> = {}) => {
  const home = await mkdtemp(join(tmpdir(), "one-cli-commands-"))
  dirs.push(home)
  const exit = vi.fn()
  const c = new Client({
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      SMITHERS_AUTH_FILE: join(home, "auth.json"),
      SMITHERS_API_ORIGIN: "https://api.example.test",
      SMITHERS_TOKEN: "session-secret",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
      ...env
    },
    exit
  })
  const request = vi.spyOn(c, "request").mockResolvedValue({})
  const exec = vi.spyOn(c, "exec").mockResolvedValue("")
  return { c, home, request, exec, exit }
}
const apiError = (status: number) => new APIError(status, { message: "failed" }, "GET", "/test", new Headers())
const options = { repo: "owner/repo" }

const homeFixture = async (
  handler: (req: IncomingMessage, res: ServerResponse) => void
) => {
  const home = await mkdtemp(join(tmpdir(), "one-cli-home-"))
  dirs.push(home)
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("Expected a local HTTP port")
  const origin = `http://127.0.0.1:${address.port}`
  const environment = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    SMITHERS_API_ORIGIN: origin,
    SMITHERS_AUTH_FILE: join(home, "auth.json"),
    SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
    SMITHERS_AUDIENCE: "human"
  }
  await writeFile(
    environment.SMITHERS_AUTH_FILE,
    JSON.stringify({
      api_url: origin,
      host: "127.0.0.1",
      token: "home-session-secret"
    }),
    { mode: 0o600 }
  )
  return {
    home,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    run: async (args: string[]) => {
      let output = "", error = "", code = 0
      const signals = new EventEmitter()
      await main({
        argv: [...args, "--audience", "human"],
        env: { ...environment },
        stdout: {
          isTTY: true,
          columns: 80,
          write: (text) => {
            output += text
          }
        },
        stderr: {
          isTTY: false,
          columns: 80,
          write: (text) => {
            error += text
          }
        },
        on: (signal, listener) => {
          signals.on(signal, listener)
        },
        removeListener: (signal, listener) => {
          signals.removeListener(signal, listener)
        },
        setExitCode: (value) => {
          code = value
        }
      })
      expect(signals.eventNames()).toEqual([])
      expect(output + error).not.toContain("home-session-secret")
      return { output, error, code }
    }
  }
}

describe("repo home over local HTTP server", () => {
  it("reads the selected repository's home with the saved login and prints blocks in server order", async () => {
    const requests: Array<{ method: string | undefined; url: string | undefined; authorization: string | undefined }> =
      []
    const body = {
      kind: "blocks",
      blocks: [
        { type: "prompt", title: "Start here" },
        { type: "app", name: "Ship a change" }
      ]
    }
    const f = await homeFixture((req, res) => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization })
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(body))
    })
    try {
      const result = await f.run(["repo", "home", "owner/repo"])
      expect(result.code, result.output + result.error).toBe(0)
      expect(requests).toEqual([{
        method: "GET",
        url: "/api/repos/owner/repo/home",
        authorization: "token home-session-secret"
      }])
      const firstType = result.output.indexOf("prompt")
      const firstTitle = result.output.indexOf("Start here")
      const secondType = result.output.indexOf("app", firstTitle + 1)
      const secondName = result.output.indexOf("Ship a change")
      expect(firstType).toBeGreaterThanOrEqual(0)
      expect(firstTitle).toBeGreaterThan(firstType)
      expect(secondType).toBeGreaterThan(firstTitle)
      expect(secondName).toBeGreaterThan(secondType)
    } finally {
      await f.close()
    }
  })

  it.each([0, 32])("prints all %i blocks without truncating the server order", async (count) => {
    const blocks = Array.from({ length: count }, (_, index) => ({ type: "app", title: `App ${index}` }))
    const f = await homeFixture((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ kind: "blocks", blocks }))
    })
    try {
      const result = await f.run(["repo", "home", "--repo", "owner/repo"])
      expect(result.code, result.output + result.error).toBe(0)
      expect(result.output.split("\n").filter((line) => line.startsWith("app")))
        .toEqual(blocks.map((block) => `app  ${block.title}`))
      expect(result.output).not.toContain("Use --json")
    } finally {
      await f.close()
    }
  })

  it.each([
    ["control characters", "\u001b[31mred\u001b[0m\nsecond line\u0007bell", "red second line bell"],
    ["a long title", "x".repeat(700), "x".repeat(500)]
  ])("renders the human type and title for %s", async (_case, title, expectedTitle) => {
    const f = await homeFixture((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ kind: "blocks", blocks: [{ type: "prompt", title }] }))
    })
    try {
      const result = await f.run(["repo", "home", "owner/repo"])
      expect(result.code, result.output + result.error).toBe(0)
      expect(result.output.split("\n").filter((line) => line.startsWith("prompt")))
        .toEqual([`prompt  ${expectedTitle}`])
    } finally {
      await f.close()
    }
  })

  it("infers the repository from the checkout like repo view when no argument is given", async () => {
    const urls: string[] = []
    const f = await homeFixture((req, res) => {
      urls.push(req.url ?? "")
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ kind: "none" }))
    })
    try {
      const checkout = join(f.home, "checkout")
      await mkdir(checkout)
      const git = (args: string[]) => {
        const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8" })
        expect(result.status, result.stderr).toBe(0)
      }
      git(["init", "-q"])
      git(["remote", "add", "origin", "https://smithers.sh/owner/repo.git"])
      process.chdir(checkout)
      const view = await f.run(["repo", "view"])
      const home = await f.run(["repo", "home"])
      expect(view.code, view.output + view.error).toBe(0)
      expect(home.code, home.output + home.error).toBe(0)
      expect(urls).toEqual(["/api/repos/owner/repo", "/api/repos/owner/repo/home"])
    } finally {
      process.chdir(cwd)
      await f.close()
    }
  })

  it("returns the server's homepage document unchanged under --json", async () => {
    const body = {
      kind: "blocks",
      blocks: [
        { type: "text", title: "First", text: "Hello" },
        { type: "links", name: "Resources", links: [{ label: "Guide", url: "/guide" }] }
      ],
      revision: 7
    }
    const f = await homeFixture((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(body))
    })
    try {
      const result = await f.run(["repo", "home", "owner/repo", "--json"])
      expect(result.code, result.output + result.error).toBe(0)
      expect(JSON.parse(result.output)).toEqual(body)
    } finally {
      await f.close()
    }
  })

  it.each([
    [400, "repository homepage is invalid"],
    [401, "login required"],
    [404, "repository not found"]
  ])("prints the backend's %i message and exits nonzero", async (status, message) => {
    const f = await homeFixture((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" })
      res.end(JSON.stringify({ message }))
    })
    try {
      const result = await f.run(["repo", "home", "owner/repo"])
      expect(result.code).not.toBe(0)
      expect(result.output + result.error).toContain(message)
    } finally {
      await f.close()
    }
  })

  it("describes remote repo home separately from local smthrs ls", async () => {
    let requests = 0
    const f = await homeFixture((_req, res) => {
      requests++
      res.end("{}")
    })
    try {
      const home = await f.run(["repo", "home", "--help"])
      const ls = await f.run(["ls", "--help"])
      expect(home.code, home.output + home.error).toBe(0)
      expect(ls.code, ls.output + ls.error).toBe(0)
      expect(home.output).toContain("repo home")
      expect(home.output).toMatch(/homepage|home page/i)
      expect(home.output).toContain("--repo")
      expect(home.output).toContain("local smthrs ls")
      expect(home.output).toContain("saved login")
      expect(ls.output).toMatch(/local|workspace|target/i)
      expect(ls.output).not.toContain("repository homepage")
      expect(requests).toBe(0)
    } finally {
      await f.close()
    }
  })
})

describe("repository selection and transfer", () => {
  it.each([
    "https://evil.test/owner/repo",
    "git@evil.test:owner/repo",
    "https://api.example.test/owner/repo?redirect=x"
  ])("refuses a foreign or malformed repository URL %s", async (url) => {
    const { c } = await fixture()
    expect(() => c.repo(url)).toThrow()
  })
  it("selects a matching remote instead of an unrelated origin", async () => {
    const host: Host = {
      platform: process.platform,
      home: tmpdir(),
      exists: () => true,
      launch: async () => 0,
      read: (command: string) =>
        command === "jj" ? "origin https://github.com/wrong/repo\nsmithers git@ssh.example.test:owner/repo.git\n" : ""
    }
    expect(resolveRepo(host, cwd, new Set(["example.test", "ssh.example.test"]))).toBe("owner/repo")
    expect(() => resolveRepo(host, cwd, new Set(["other.test"]))).toThrow("--repo")
    expect(repoFromRemote("https://example.test/owner/repo.git", new Set(["example.test"]))).toBe("owner/repo")
  })
  it.each(["https://example.test/team/repo.git", "/tmp/local.git"])(
    "clones %s without interpreting it as an API slug",
    async (repo) => {
      const { c, exec, request } = await fixture()
      exec.mockImplementation(async (command) => {
        if (command === "jj") throw new Error("no jj")
        return ""
      })
      expect(await repositories["repo clone"]!(c, { repo }, { directory: "copy", "clone-arg": ["--depth=1"] }))
        .toMatchObject({ directory: "copy", tool: "git" })
      expect(exec).toHaveBeenLastCalledWith("git", ["clone", repo, "copy", "--depth=1"])
      expect(request).not.toHaveBeenCalled()
    }
  )
  it.each(["https", "ssh"])("clones a backend slug using %s", async (protocol) => {
    const { c, exec } = await fixture()
    await repositories["repo clone"]!(c, { repo: "owner/repo" }, { protocol })
    expect(exec).toHaveBeenCalledWith("jj", [
      "git",
      "clone",
      protocol === "ssh" ? "git@ssh.example.test:owner/repo.git" : "https://example.test/owner/repo.git",
      "repo"
    ])
  })
  it.each(["../bad", ".hidden", "a.lock", "a..b", "bad name"])(
    "rejects unsafe ref %s before launching git",
    async (name) => {
      const { c, exec } = await fixture()
      await expect(repositories["repo push"]!(c, {}, { ...options, name })).rejects.toThrow("ref")
      expect(exec).not.toHaveBeenCalled()
    }
  )
  it.each([false, true])("uses a lease and scoped environment for a git push (delete=%s)", async (del) => {
    const { c, exec, request } = await fixture()
    exec.mockImplementation(async (command, args) => {
      if (command === "jj") throw new Error("not jj")
      if (args.includes("--absolute-git-dir")) return "/tmp/repo/.git"
      if (args.includes("HEAD^{commit}")) return "newcommit"
      if (args.includes("ls-remote")) return "oldcommit\trefs/smithers/users/7/head"
      return ""
    })
    request.mockImplementation(async (_method, path) => path === "/api/user" ? { id: 7 } : { expires_at: "tomorrow" })
    const result = await repositories["repo push"]!(c, {}, { ...options, delete: del })
    expect(result).toMatchObject(del ? { deleted: true } : { updated: true, commit: "newcommit" })
    const push = exec.mock.calls.find(([, args]) => args.includes("push"))!
    expect(push[1]).toContain("--force-with-lease=refs/smithers/users/7/head:oldcommit")
    expect(push[1]).toContain(del ? ":refs/smithers/users/7/head" : "newcommit:refs/smithers/users/7/head")
    expect(JSON.stringify(push[1])).not.toContain("session-secret")
    expect(push[2]).toMatchObject({
      GIT_CONFIG_VALUE_0: "Authorization: Bearer session-secret",
      GIT_CONFIG_VALUE_1: "false"
    })
  })
  it("refuses publishing a jj working copy into a public repository", async () => {
    const { c, exec, request } = await fixture()
    exec.mockResolvedValue("commit")
    request.mockResolvedValue({ is_public: true })
    await expect(repositories["repo push"]!(c, {}, { ...options, "working-copy": true })).rejects.toThrow("public")
    expect(exec.mock.calls.some(([, args]) => args.includes("push"))).toBe(false)
  })
  it("writes the current cache declaration once into PACKAGE.ts", async () => {
    const { c, home, request } = await fixture()
    request.mockResolvedValue({ token: "smithers_cachero_public", endpoint: "https://cache.test" })
    expect(await repositories["cache connect"]!(c, {}, { ...options, workspace: home })).toMatchObject({
      changed: true
    })
    const content = await readFile(join(home, "PACKAGE.ts"), "utf8")
    expect(content).toContain("Smithers.RemoteCache.smithersCloud(")
    expect(content).not.toContain("jjhub")
    expect(await repositories["cache connect"]!(c, {}, { ...options, workspace: home })).toMatchObject({
      changed: false
    })
    expect(request).toHaveBeenCalledTimes(1)
  })
  it("previews cache setup without writing a file", async () => {
    const { c, home, request } = await fixture()
    request.mockResolvedValue({ token: "smithers_cachero_public" })
    expect(await repositories["cache connect"]!(c, {}, { ...options, workspace: home, write: false })).toMatchObject({
      changed: false
    })
    await expect(readFile(join(home, "PACKAGE.ts"))).rejects.toThrow()
  })
  it("keeps an invalid checkout config visible", async () => {
    const { c, home } = await fixture()
    await mkdir(join(home, ".jj"))
    await mkdir(join(home, ".smithers"))
    await writeFile(join(home, ".smithers/config.json"), "{broken")
    process.chdir(home)
    await expect(repositories["repo status"]!(c, {}, {})).rejects.toThrow()
    expect(await readFile(join(home, ".smithers/config.json"), "utf8")).toBe("{broken")
  })
})

describe("one-login authentication", () => {
  it("logs in from stdin and exposes only metadata", async () => {
    const { c } = await fixture({ SMITHERS_TOKEN: "" })
    vi.spyOn(c, "stdin").mockResolvedValue("new-secret")
    expect(await auth["auth login"]!(c, {}, { "with-token": true })).toMatchObject({ status: "logged_in" })
    expect((await c.session.require())?.token).toBe("new-secret")
    expect(JSON.stringify(await auth["auth token"]!(c, {}, {}))).not.toContain("new-secret")
    await auth["auth logout"]!(c, {}, {})
    expect(await c.session.resolve()).toBeUndefined()
  })
  it.each([
    { ttl: "1h" },
    { admin: true, "with-token": true },
    { admin: true, ttl: "1s" },
    { admin: true, ttl: "13h" },
    { admin: true, ttl: "bogus" }
  ])("rejects invalid admin consent options %j", async (o) => {
    const { c } = await fixture()
    await expect(auth["auth login"]!(c, {}, o)).rejects.toThrow()
  })
  it.each([401, 403, 503])("keeps status honest on HTTP %s", async (code) => {
    const { c, request, exit } = await fixture()
    request.mockRejectedValue(apiError(code))
    expect(await auth["auth status"]!(c, {}, {})).toMatchObject(
      code === 503 ? { verified: false, logged_in: true } : { logged_in: false }
    )
    if (code !== 503) expect(exit).toHaveBeenCalledWith(1)
  })
  it.each(["login", "bootstrap"])("obtains one owner session through local %s", async (action) => {
    const { c, request } = await fixture({
      SMITHERS_AUTH_USERNAME: "owner",
      SMITHERS_AUTH_PASSWORD: "password",
      SMITHERS_AUTH_BOOTSTRAP_TOKEN: "bootstrap",
      SMITHERS_TOKEN: ""
    })
    request.mockResolvedValue({ token: "owner-token", user: { username: "owner" }, token_id: 7 })
    expect(await auth[`auth local ${action}`]!(c, {}, {})).toMatchObject({ user: "owner", token_id: 7 })
    expect((await c.session.require())?.token).toBe("owner-token")
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/auth/local/token",
      expect.objectContaining({ username: "owner", password: "password" }),
      expect.objectContaining({ anonymous: true })
    )
    if (action === "bootstrap") {
      expect(request.mock.calls[0]![3]).toMatchObject({ headers: { "X-Smithers-Bootstrap-Token": "bootstrap" } })
    }
  })
  it("connects Codex subscription credentials", async () => {
    const provider = "codex"
    const { c, home, request } = await fixture()
    const jwt = (body: object) => `header.${Buffer.from(JSON.stringify(body)).toString("base64url")}.signature`
    await writeFile(
      join(home, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: jwt({ exp: 2e9 }),
          refresh_token: "refresh",
          id_token: jwt({
            email: "owner@example.test",
            "https://api.openai.com/auth": { chatgpt_account_id: "account", chatgpt_plan_type: "pro" }
          })
        }
      })
    )
    await auth["auth connect"]!(c, { provider }, { "config-dir": home, label: "laptop" })
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/user/provider-connections",
      expect.objectContaining({ provider, kind: "oauth", refresh_token: "refresh", label: "laptop" })
    )
  })
  it("refuses a Codex API-key login", async () => {
    const { c, home } = await fixture()
    await writeFile(join(home, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "not-a-subscription" }))
    await expect(auth["auth connect"]!(c, { provider: "codex" }, { "config-dir": home })).rejects.toThrow(
      "subscription"
    )
  })
  it("accepts an Anthropic API key and never a Claude subscription token (#2777)", async () => {
    const { c, home, request } = await fixture()
    vi.spyOn(c, "stdin").mockResolvedValue("Here is sk-ant-api03-key")
    await auth["auth connect"]!(c, { provider: "claude" }, { "api-key": true })
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/api/user/provider-connections",
      expect.objectContaining({ provider: "claude", kind: "api_key", access_token: "sk-ant-api03-key" })
    )
    request.mockClear()
    vi.spyOn(c, "stdin").mockResolvedValue("sk-ant-oat01-subscription")
    await expect(auth["auth connect"]!(c, { provider: "claude" }, { "api-key": true })).rejects.toThrow("API key")
    // The local Claude login is never read, so nothing can forward it.
    await writeFile(
      join(home, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "sk-ant-oat01-login", refreshToken: "r", subscriptionType: "max" }
      })
    )
    await expect(auth["auth connect"]!(c, { provider: "claude" }, { "config-dir": home })).rejects.toThrow(
      "never stored"
    )
    expect(request).not.toHaveBeenCalled()
    for (const command of ["login", "logout", "push", "status", "token"]) {
      expect(auth[`auth claude ${command}`]).toBeUndefined()
    }
  })
  it("does not reuse host-only legacy credentials at another port", async () => {
    const { c, home } = await fixture({ SMITHERS_TOKEN: "" })
    c.session.saveConfig({ api_origin: "https://api.example.test" })
    await writeFile(join(home, "auth.json"), JSON.stringify({ host: "example.test", token: "legacy-secret" }))
    expect((await c.session.resolve())?.token).toBe("legacy-secret")
    expect(await c.session.resolve("https://api.example.test:8443")).toBeUndefined()
  })
})

describe("configuration and agent conversations", () => {
  it("updates persistent config without exposing a session", async () => {
    const { c } = await fixture()
    await misc["config set"]!(c, { key: "api_url", value: "https://api.example.test" }, {})
    expect(await misc["config get"]!(c, { key: "api_url" }, {})).toEqual({ api_url: "https://api.example.test" })
    expect(await misc["config list"]!(c, {}, {})).toMatchObject({ git_protocol: "ssh" })
    const shown = await misc["config show"]!(c, {}, {})
    expect(JSON.stringify(shown)).not.toContain("session-secret")
    expect(object(shown).env_overrides).toMatchObject({ SMITHERS_TOKEN: "(set)" })
    await expect(misc["config set"]!(c, { key: "token", value: "secret" }, {})).rejects.toThrow("Unknown")
  })
  it.each(["run", "chat"])("sends %s to the existing conversation API", async (action) => {
    const { c, request } = await fixture()
    request.mockResolvedValue({ id: "conversation" })
    await misc[`agent ${action}`]!(c, { id: "conversation", prompt: "Fix it", message: "Continue" }, options)
    expect(request).toHaveBeenLastCalledWith("POST", "/api/repos/owner/repo/agent/sessions/conversation/messages", {
      role: "user",
      parts: [{ type: "text", content: action === "run" ? "Fix it" : "Continue" }],
      agent_provider: "smithers",
      agent_transport: "workflow"
    })
  })
  it.each(["list", "view"])("reads %s through the same conversation API", async (action) => {
    const { c, request } = await fixture()
    await misc[`agent session ${action}`]!(c, { id: "conversation" }, options)
    expect(request.mock.calls[0]![1]).toContain("/agent/sessions")
  })
  it("refreshes, conditionally reuses, and falls back to cached docs", async () => {
    const { c, exec, request } = await fixture({ SMITHERS_AGENT_DOCS_URL: "https://docs.example.test/reference" })
    exec.mockResolvedValue("checkout")
    request.mockResolvedValue({ login: "owner" })
    const fetch = vi.fn().mockResolvedValueOnce(
      new Response("# Issues\nUse smithers issue list to find issues.\n# Login\nSign in with smithers auth login.", {
        headers: { etag: "v1" }
      })
    ).mockResolvedValueOnce(new Response(null, { status: 304 })).mockRejectedValueOnce(new Error("offline"))
    vi.stubGlobal("fetch", fetch)
    const first = object(await ask(c, { prompt: "issues" }, options))
    expect(first.docs_status).toMatchObject({ source: "network", status: "fresh" })
    expect(first.response).toContain("smithers issue list")
    expect(object(await ask(c, { prompt: "issues" }, options)).docs_status).toMatchObject({
      source: "cache",
      status: "fresh"
    })
    expect(fetch.mock.calls[1]![1].headers).toEqual({ "if-none-match": "v1" })
    expect(object(await ask(c, { prompt: "issues" }, options)).docs_status).toMatchObject({
      source: "cache",
      status: "stale"
    })
  })
  it("returns offline context without making signed-out summary fail", async () => {
    const { c, exec, exit } = await fixture({ SMITHERS_TOKEN: "" })
    exec.mockImplementation(() => {
      throw new Error("no checkout")
    })
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const result = object(await ask(c, {}, options))
    expect(object(result.repo_context).auth).toMatchObject({ loggedIn: false })
    expect(exit).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("workspace selection and local changes", () => {
  it.each([[], [{ id: "stopped", status: "stopped" }], [{ id: "stopped", status: "stopped" }, {
    id: "running",
    status: "running"
  }]].map((boxes) => ({ boxes })))("selects or creates a box from $boxes", async ({ boxes }) => {
    const { c, request } = await fixture()
    request.mockResolvedValueOnce(boxes).mockResolvedValueOnce({ id: "new" })
    expect(await resolveID(c, {}, options)).toBe(boxes.length ? boxes.at(-1)!.id : "new")
    expect(await resolveID(c, { id: "explicit" }, options)).toBe("explicit")
  })
  it("waits for a real running receipt", async () => {
    const { c, request } = await fixture({ SMITHERS_WORKSPACE_CREATE_POLL_INTERVAL_MS: "1" })
    request.mockResolvedValueOnce({ id: "box" }).mockResolvedValueOnce({ id: "box", status: "creating" })
      .mockResolvedValueOnce({ id: "box", status: "running" })
    expect(await workspaces["workspace create"]!(c, {}, { ...options, wait: true })).toMatchObject({
      status: "running"
    })
    expect(request).toHaveBeenCalledTimes(3)
  })
  it("renders persisted box details even when SSH is not ready", async () => {
    const { c, request } = await fixture()
    request.mockResolvedValueOnce({
      id: "box",
      status: "running",
      ssh_host: "guest",
      created_at: new Date(Date.now() - 7200000).toISOString()
    }).mockRejectedValueOnce(apiError(503))
    expect(await workspaces["workspace view"]!(c, { id: "box" }, options)).toMatchObject({
      ssh: { host: "guest", command: "ssh guest" },
      uptime: "2h 0m"
    })
  })
  it("parses jj revisions, changes, bookmarks, and conflicts", async () => {
    const { c, exec } = await fixture()
    exec.mockImplementation(async (_command, args) =>
      args[0] === "diff"
        ? "M changed.ts\nC conflict.ts\n"
        : args[0] === "bookmark"
        ? "main\tchange\tcommit"
        : "change\tcommit\tDescription"
    )
    expect(await local.status!(c, {}, {})).toMatchObject({
      working_copy: { change_id: "change", commit_id: "commit" },
      files: [{ status: "M", path: "changed.ts" }, { status: "C", path: "conflict.ts" }]
    })
    expect(await local["change conflicts"]!(c, { id: "change" }, {})).toEqual({
      change_id: "change",
      conflicts: ["conflict.ts"]
    })
    expect(await local["bookmark list"]!(c, {}, {})).toEqual([{
      name: "main",
      target_change_id: "change",
      target_commit_id: "commit"
    }])
    expect(await local["bookmark delete"]!(c, { name: "main" }, {})).toEqual({ status: "deleted", name: "main" })
    await expect(local["bookmark delete"]!(c, { name: "missing" }, {})).rejects.toThrow("not found")
  })
})

describe("stack lifecycle", () => {
  const changes = [{ change_id: "abcdefgh", position: 0, pr_number: 7, branch_name: "smithers/abcdefgh" }]
  it.each(["status", "sync", "land", "unsubmit"])("handles an absent active stack for %s", async (action) => {
    const { c, request } = await fixture()
    request.mockRejectedValue(apiError(404))
    expect(await stacks[`stack ${action}`]!(c, {}, options)).toMatchObject(
      action === "status" ? { state: "inactive" } : { stack_deleted: false }
    )
  })
  it("submits local changes and persists the resulting PR mapping", async () => {
    const { c, exec, request } = await fixture()
    exec.mockImplementation(async (_command, args) =>
      args.includes("log") ? args.at(-1)!.startsWith("change_id") ? "abcdefgh\tcommit" : "Fix bug\n\nDetails" : ""
    )
    request.mockImplementation(async (_method, path, body) =>
      path.endsWith("/github-proxy")
        ? object(body).method === "POST" ? { number: 7, state: "open", html_url: "https://github.test/pr/7" } : {}
        : { id: "stack" }
    )
    expect(await stacks["stack submit"]!(c, {}, options)).toMatchObject({ pr_numbers: [7], stack_id: "stack" })
    expect(request).toHaveBeenLastCalledWith(
      "POST",
      "/api/repos/owner/repo/stacks/active",
      expect.objectContaining({
        target_ref: "main",
        changes: [expect.objectContaining({ change_id: "abcdefgh", pr_number: 7 })]
      })
    )
    expect(exec.mock.calls.some(([, args]) => args.includes("push"))).toBe(true)
  })
  it.each(["success", "failure", "pending"])("refreshes authoritative stack checks (%s)", async (status) => {
    const { c, exec, request } = await fixture()
    exec.mockImplementation(() => {
      throw new Error("no checkout")
    })
    request.mockImplementation(async (_method, path, body) => {
      if (!path.endsWith("/github-proxy")) return { id: "stack", changes }
      const target = String(object(body).path)
      if (target.endsWith("check-runs")) {
        return {
          check_runs: [{
            name: "tests",
            status: status === "pending" ? "in_progress" : "completed",
            conclusion: status
          }]
        }
      }
      if (target.endsWith("reviews")) return [{ user: { login: "Owner" }, state: "APPROVED" }]
      return { state: "open", mergeable: true, head: { sha: "commit" } }
    })
    const result = object(await stacks["stack status"]!(c, {}, options))
    expect(result.changes).toEqual([
      expect.objectContaining({
        ci_status: status === "success" ? "passing" : status === "failure" ? "failing" : "pending",
        review_status: "approved"
      })
    ])
  })
  it("lands only after fresh checks and removes the completed stack", async () => {
    const { c, request } = await fixture()
    request.mockImplementation(async (_method, path, body) => {
      if (!path.endsWith("/github-proxy")) return { id: "stack", changes }
      const target = String(object(body).path)
      if (target.endsWith("check-runs")) return { check_runs: [{ status: "completed", conclusion: "success" }] }
      if (target.endsWith("reviews")) return [{ user: { login: "owner" }, state: "APPROVED" }]
      if (target.endsWith("/merge")) return { merged: true }
      return { state: "open", mergeable: true, head: { sha: "commit" } }
    })
    expect(await stacks["stack land"]!(c, {}, options)).toMatchObject({
      stack_deleted: true,
      landed: [expect.objectContaining({ pr_number: 7 })]
    })
    expect(request).toHaveBeenLastCalledWith("DELETE", "/api/repos/owner/repo/stacks/active?target_ref=main")
  })
  it("closes submitted PRs and removes their branches", async () => {
    const { c, request } = await fixture()
    request.mockImplementation(async (_method, path) =>
      path.endsWith("/github-proxy") ? { state: "open" } : { id: "stack", changes }
    )
    expect(await stacks["stack unsubmit"]!(c, {}, options)).toMatchObject({
      stack_deleted: true,
      prs: [{ pr_number: 7, status: "closed" }]
    })
    expect(request.mock.calls.some(([, , body]) => object(body).method === "DELETE")).toBe(true)
  })
})
