import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import ts from "typescript"
import { afterEach, describe, expect, it, vi } from "vitest"
import { main } from "../src/cli/Entry.ts"
import { type Host, repoFromRemote, resolveRepo } from "../src/commands/Open.ts"
import { ask } from "../src/internal/backend/AgentDocs.ts"
import { auth } from "../src/internal/backend/Auth.ts"
import { APIError, Client, object } from "../src/internal/backend/Client.ts"
import { local } from "../src/internal/backend/Local.ts"
import { misc } from "../src/internal/backend/Misc.ts"
import { gitAuth, repositories } from "../src/internal/backend/Repositories.ts"
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
    XDG_DATA_HOME: join(home, ".local", "share"),
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
      // Incur reads skill-sync metadata from process.env, not the CLI host's env.
      const previousDataHome = process.env.XDG_DATA_HOME
      process.env.XDG_DATA_HOME = environment.XDG_DATA_HOME
      try {
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
      } finally {
        if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME
        else process.env.XDG_DATA_HOME = previousDataHome
      }
      expect(signals.eventNames()).toEqual([])
      expect(output + error).not.toContain("home-session-secret")
      return { output, error, code }
    }
  }
}

describe("retired product commands", () => {
  it.each([
    ["create-app", "my-app"],
    ["repo", "fork", "owner/repo"],
    ["repo", "transfer", "owner/repo", "--to", "other"],
    ["changeset", "create", "--org", "org", "--member", "repo=change"],
    ["changeset", "get", "--org", "org", "--id", "1"],
    ["changeset", "list", "--org", "org"],
    ["changeset", "land", "--org", "org", "--id", "1"]
  ])("refuses %j without contacting the backend", async (...args) => {
    const request = vi.fn((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(500)
      res.end("removed command contacted server")
    })
    const f = await homeFixture(request)
    try {
      const result = await f.run(args)
      expect(result.code).not.toBe(0)
      expect(request).not.toHaveBeenCalled()
    } finally {
      await f.close()
    }
  })
})

describe("repo clone over local Git HTTP", () => {
  it("preserves the configured origin and uses its saved login for a private repository", async () => {
    let gitRoot = ""
    const gitRequests: Array<{ path: string; authorization: string | undefined }> = []
    const fixture = await homeFixture(async (req, res) => {
      if (req.url === "/api/repos/owner/repo") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end("{}")
        return
      }
      const url = new URL(req.url || "/", `http://${req.headers.host}`)
      gitRequests.push({ path: url.pathname, authorization: req.headers.authorization })
      if (req.headers.authorization !== "Bearer home-session-secret") {
        res.writeHead(401)
        res.end()
        return
      }
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      const result = spawnSync("git", ["http-backend"], {
        input: body,
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: gitRoot,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: req.method || "GET",
          CONTENT_TYPE: String(req.headers["content-type"] || ""),
          CONTENT_LENGTH: String(body.length),
          HTTP_GIT_PROTOCOL: String(req.headers["git-protocol"] || "")
        }
      })
      const output = result.stdout
      const boundary = Buffer.from("\r\n\r\n")
      const end = output.indexOf(boundary)
      if (result.status !== 0 || end < 0) {
        res.writeHead(500)
        res.end(result.stderr)
        return
      }
      let status = 200
      const headers: Record<string, string> = {}
      for (const line of output.subarray(0, end).toString().split("\r\n")) {
        const colon = line.indexOf(":")
        if (colon < 0) continue
        const name = line.slice(0, colon), value = line.slice(colon + 1).trim()
        if (name.toLowerCase() === "status") status = Number(value.split(" ")[0])
        else headers[name] = value
      }
      res.writeHead(status, headers)
      res.end(output.subarray(end + boundary.length))
    })
    try {
      gitRoot = join(fixture.home, "git")
      const owner = join(gitRoot, "owner")
      const source = join(fixture.home, "source")
      await mkdir(owner, { recursive: true })
      const git = (args: string[], at: string) => {
        const result = spawnSync("git", args, { cwd: at, encoding: "utf8" })
        expect(result.status, `${args.join(" ")}: ${result.stderr}`).toBe(0)
      }
      git(["init", "--bare", "repo.git"], owner)
      git(["init", "-b", "main", "source"], fixture.home)
      git(["config", "user.name", "Clone Fixture"], source)
      git(["config", "user.email", "fixture@example.test"], source)
      await writeFile(join(source, "README.md"), "private clone works\n")
      git(["add", "README.md"], source)
      git(["commit", "-qm", "seed"], source)
      git(["remote", "add", "origin", join(owner, "repo.git")], source)
      git(["push", "-q", "origin", "main"], source)
      git(["symbolic-ref", "HEAD", "refs/heads/main"], join(owner, "repo.git"))

      const checkout = join(fixture.home, "checkout")
      const result = await fixture.run(["repo", "clone", "owner/repo", "--protocol", "https", "--directory", checkout])
      expect(result.code, result.error).toBe(0)
      expect(await readFile(join(checkout, "README.md"), "utf8")).toBe("private clone works\n")
      expect(gitRequests.length).toBeGreaterThan(0)
      expect(gitRequests.every((request) =>
        request.path.startsWith("/owner/repo.git/") &&
        request.authorization === "Bearer home-session-secret"
      )).toBe(true)
    } finally {
      await fixture.close()
    }
  })
  it("does not send the saved backend login to another clone URL", async () => {
    const fixture = await homeFixture((_req, res) => res.end("{}"))
    const authorizations: Array<string | undefined> = []
    const external = createServer((req, res) => {
      authorizations.push(req.headers.authorization)
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve))
    try {
      const address = external.address()
      if (!address || typeof address === "string") throw new Error("Expected an external local HTTP port")
      const url = `http://127.0.0.1:${address.port}/another/repo.git`
      const result = await fixture.run(["repo", "clone", url, "--directory", join(fixture.home, "external")])
      expect(result.code).not.toBe(0)
      expect(authorizations.length).toBeGreaterThan(0)
      expect(authorizations.every((authorization) => authorization === undefined)).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) => external.close((error) => error ? reject(error) : resolve()))
      await fixture.close()
    }
  })
  it("does not forward the saved login across a Git redirect to another origin", async () => {
    const redirectedAuthorizations: Array<string | undefined> = []
    const external = createServer((req, res) => {
      redirectedAuthorizations.push(req.headers.authorization)
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => external.listen(0, "127.0.0.1", resolve))
    const address = external.address()
    if (!address || typeof address === "string") throw new Error("Expected an external local HTTP port")
    const trustedAuthorizations: Array<string | undefined> = []
    const fixture = await homeFixture((req, res) => {
      if (req.url === "/api/repos/owner/repo") {
        res.writeHead(200, { "Content-Type": "application/json" })
        res.end("{}")
        return
      }
      trustedAuthorizations.push(req.headers.authorization)
      res.writeHead(302, { Location: `http://127.0.0.1:${address.port}${req.url}` })
      res.end()
    })
    try {
      const result = await fixture.run([
        "repo",
        "clone",
        "owner/repo",
        "--protocol",
        "https",
        "--directory",
        join(fixture.home, "redirected")
      ])
      expect(result.code).not.toBe(0)
      expect(trustedAuthorizations).toContain("Bearer home-session-secret")
      expect(redirectedAuthorizations).toEqual([])
    } finally {
      await fixture.close()
      await new Promise<void>((resolve, reject) => external.close((error) => error ? reject(error) : resolve()))
    }
  })
})

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

  it("returns the server's homepage document unchanged under --json without skill-sync metadata", async () => {
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
      const previousDataHome = process.env.XDG_DATA_HOME
      const result = await f.run(["repo", "home", "owner/repo", "--json"])
      expect(result.code, result.output + result.error).toBe(0)
      expect(JSON.parse(result.output)).toEqual(body)
      expect(process.env.XDG_DATA_HOME).toBe(previousDataHome)
    } finally {
      await f.close()
    }
  })

  it("preserves the server's homepage document and adds the skills CTA when installed skills are stale", async () => {
    const body = { kind: "blocks", blocks: [{ type: "text", title: "First", text: "Hello" }], revision: 7 }
    const f = await homeFixture((_req, res) => {
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify(body))
    })
    const callerDataHome = process.env.XDG_DATA_HOME
    const sentinelDataHome = join(f.home, "caller-data")
    try {
      const installed = join(f.home, "installed-skill")
      const metadata = join(f.home, ".local", "share", "incur")
      await mkdir(installed)
      await mkdir(metadata, { recursive: true })
      await writeFile(join(installed, "SKILL.md"), "---\nname: installed-skill\ndescription: Test skill\n---\n")
      await writeFile(
        join(metadata, "smthrs.json"),
        JSON.stringify({ hash: "stale-hash", skills: ["installed-skill"], paths: [installed] })
      )

      process.env.XDG_DATA_HOME = sentinelDataHome
      const result = await f.run(["repo", "home", "owner/repo", "--json"])
      expect(result.code, result.output + result.error).toBe(0)
      expect(process.env.XDG_DATA_HOME).toBe(sentinelDataHome)
      const parsed = JSON.parse(result.output) as typeof body & {
        cta?: { description: string; commands: Array<{ command: string; description: string }> }
      }
      const { cta, ...document } = parsed
      expect(document).toEqual(body)
      expect(cta?.description).toBe("Skills are out of date:")
      expect(cta?.commands).toEqual([{
        command: expect.stringMatching(/\bsmthrs skills add$/),
        description: "sync outdated skills"
      }])
    } finally {
      if (callerDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = callerDataHome
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

  it("describes remote repo home separately from local smthrs flow list", async () => {
    let requests = 0
    const f = await homeFixture((_req, res) => {
      requests++
      res.end("{}")
    })
    try {
      const home = await f.run(["repo", "home", "--help"])
      const ls = await f.run(["flow", "list", "--help"])
      expect(home.code, home.output + home.error).toBe(0)
      expect(ls.code, ls.output + ls.error).toBe(0)
      expect(home.output).toContain("repo home")
      expect(home.output).toMatch(/homepage|home page/i)
      expect(home.output).toContain("--repo")
      expect(home.output).toContain("local smthrs flow list")
      expect(home.output).toContain("saved login")
      expect(ls.output).toContain("List project flows")
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
      expect(exec).toHaveBeenLastCalledWith("git", ["clone", repo, "copy", "--depth=1"], {})
      expect(request).not.toHaveBeenCalled()
    }
  )
  it.each(["https", "ssh"])("clones a backend slug using %s", async (protocol) => {
    const { c, exec } = await fixture()
    await repositories["repo clone"]!(c, { repo: "owner/repo" }, { protocol })
    expect(exec).toHaveBeenCalledWith("jj", [
      "git",
      "clone",
      protocol === "ssh" ? "git@ssh.example.test:owner/repo.git" : "https://api.example.test/owner/repo.git",
      "repo"
    ], protocol === "https" ? gitAuth("https://api.example.test", "session-secret") : {})
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
  it("emits cache setup that typechecks against the public targets entry", async () => {
    const { c, home, request } = await fixture()
    request.mockResolvedValue({ token: "smithers_cachero_public" })
    await repositories["cache connect"]!(c, {}, { ...options, workspace: home })
    const file = join(home, "PACKAGE.ts")
    const content = await readFile(file, "utf8")
    expect(content).toContain('import { Smithers } from "@smthrs/targets"')
    await writeFile(join(home, "package.json"), JSON.stringify({ type: "module" }))
    const targetsRoot = join(import.meta.dirname, "../build/targets")
    const manifest = JSON.parse(await readFile(join(targetsRoot, "package.json"), "utf8")) as {
      name: string
      exports: Record<string, string>
    }
    expect(manifest.name).toBe("@smthrs/targets")
    // TypeScript is already a test dependency; checking the manifest's public source entry
    // catches missing namespace members without relying on a prior package build.
    const program = ts.createProgram([file], {
      target: ts.ScriptTarget.ES2024,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      types: ["node"],
      paths: { [manifest.name]: [join(targetsRoot, manifest.exports["."]!)] }
    })
    expect(
      ts.getPreEmitDiagnostics(program, program.getSourceFile(file)!).map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      )
    ).toEqual([])
  })
  it("appends cache setup to the standard named Smithers import without replacing existing targets", async () => {
    const { c, home, request } = await fixture()
    request.mockResolvedValue({ token: "smithers_cachero_public" })
    const file = join(home, "PACKAGE.ts")
    const existing = 'import { Smithers } from "@smthrs/targets"\nexport const existing = 1\n'
    await writeFile(file, existing)
    const result = object(await repositories["cache connect"]!(c, {}, { ...options, workspace: home }))
    expect(result.changed).toBe(true)
    expect(await readFile(file, "utf8")).toBe(
      `${existing}\nexport const remoteCache = Smithers.RemoteCache.smithersCloud({ repo: "owner/repo", publicReadToken: "smithers_cachero_public" })\n`
    )
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
  it.each([
    {
      tokens: {
        access_token: "local-access-secret",
        refresh_token: "local-refresh-secret",
        id_token: "local-id-secret"
      }
    },
    { OPENAI_API_KEY: "not-a-subscription" },
    undefined
  ])("refuses Codex connection without consuming local credentials (%j)", async (credentials) => {
    const { c, home, request } = await fixture()
    if (credentials !== undefined) await writeFile(join(home, "auth.json"), JSON.stringify(credentials))
    const protect = vi.spyOn(c, "protect")
    await expect(auth["auth connect"]!(c, { provider: "codex" }, { "config-dir": home, label: "laptop" })).rejects
      .toMatchObject({
        fault: "user",
        code: "not_signed_in",
        message: "Run `codex login --device-auth` on the workspace; Codex subscriptions are never sent to a workspace"
      })
    expect(request).not.toHaveBeenCalled()
    expect(protect).not.toHaveBeenCalledWith("local-access-secret")
    expect(protect).not.toHaveBeenCalledWith("local-refresh-secret")
    expect(protect).not.toHaveBeenCalledWith("local-id-secret")
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
    expect(object(shown).env_overrides).toMatchObject({ token_set: true })
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

describe("workspace create over local HTTP (#2939)", () => {
  // The backend create route stores these fields and refuses every other one (strict decoding).
  const stored = new Set([
    "name",
    "snapshot_id",
    "source_bookmark",
    "kind",
    "environment",
    "client_lease_seconds",
    "resources"
  ])
  const createServer = async () => {
    const bodies: Array<Record<string, unknown>> = []
    const fixture = await homeFixture((req, res) => {
      let raw = ""
      req.on("data", (chunk) => {
        raw += String(chunk)
      })
      req.on("end", () => {
        expect(`${req.method} ${req.url}`).toBe("POST /api/repos/owner/repo/workspaces")
        const body = JSON.parse(raw) as Record<string, unknown>
        bodies.push(body)
        const unknown = Object.keys(body).find((key) => !stored.has(key))
        res.writeHead(unknown === undefined ? 202 : 400, { "Content-Type": "application/json" })
        res.end(
          JSON.stringify(
            unknown === undefined ? { id: "box", status: "pending", kind: body.kind ?? "container" } : {
              message: `unknown field "${unknown}"`
            }
          )
        )
      })
    })
    return { ...fixture, bodies }
  }
  it("sends the selected kind and creates the workspace", async () => {
    const fixture = await createServer()
    try {
      const result = await fixture.run(["workspace", "create", "--repo", "owner/repo", "--name", "dev", "--kind", "vm"])
      expect(result.code, result.error).toBe(0)
      expect(fixture.bodies).toEqual([{ name: "dev", kind: "vm" }])
    } finally {
      await fixture.close()
    }
  })
  it("sends the requested shape from public flags to the API", async () => {
    const fixture = await createServer()
    try {
      const result = await fixture.run([
        "workspace",
        "create",
        "--repo",
        "owner/repo",
        "--name",
        "sized",
        "--cpus",
        "4",
        "--memory",
        "8192",
        "--disk",
        "40"
      ])
      expect(result.code, result.error).toBe(0)
      expect(fixture.bodies).toEqual([{ name: "sized", resources: { vcpu: 4, memory_mib: 8192, disk_gib: 40 } }])
    } finally {
      await fixture.close()
    }
  })
  it.each([
    [["--image", "docker.io/library/python:3.13-slim"], "image"],
    [["--allow", "github.com"], "network"],
    [["--idle-timeout", "1800"], "idle_timeout_seconds"],
    [["--service", "web=npm start"], "services"]
  ])("passes %j through and exits non-zero with the backend refusal", async (flags, field) => {
    const fixture = await createServer()
    try {
      const result = await fixture.run(["workspace", "create", "--repo", "owner/repo", ...flags])
      expect(fixture.bodies).toHaveLength(1)
      expect(fixture.bodies[0]).toHaveProperty(field)
      expect(result.code).not.toBe(0)
      expect(result.output + result.error).toContain("code: request_refused")
      expect(result.output + result.error).toContain(`unknown field \\"${field}\\"`)
    } finally {
      await fixture.close()
    }
  })
  it("refuses an unknown kind before any request", async () => {
    const fixture = await createServer()
    try {
      const result = await fixture.run(["workspace", "create", "--repo", "owner/repo", "--kind", "gpu"])
      expect(result.code).not.toBe(0)
      expect(fixture.bodies).toEqual([])
    } finally {
      await fixture.close()
    }
  })
})

describe("repo report over local HTTP server", () => {
  const WORKSPACE = "0b6f3c1e-5d2a-4f8e-9c47-2a1d6e8b3f90"
  const serve = (report: unknown) => {
    const requests: Array<{ method: string | undefined; url: string | undefined; body: unknown }> = []
    const fixture = homeFixture(async (req, res) => {
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(Buffer.from(chunk))
      requests.push({ method: req.method, url: req.url, body: JSON.parse(Buffer.concat(chunks).toString() || "null") })
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true, payload: { report } }))
    })
    return { requests, fixture }
  }

  it("prints the recorded report with its source commit and launches nothing", async () => {
    const shared = {
      repo: "acme/widgets",
      commit: "fc3f257b643b",
      report: { repo: "acme/widgets" },
      recordedAt: "2026-09-30T00:00:00Z"
    }
    const { requests, fixture } = serve(shared)
    const f = await fixture
    try {
      const result = await f.run(["repo", "report", "Acme/Widgets", "--workspace", WORKSPACE, "--format", "json"])
      expect(result.code, result.output + result.error).toBe(0)
      expect(requests).toEqual([{
        method: "POST",
        url: "/api/workflow/rpc",
        body: {
          repo: "Acme/Widgets",
          procedure: "Registration.Report",
          payload: { repo: "acme/widgets" },
          workspaceId: WORKSPACE
        }
      }])
      expect(JSON.parse(result.output)).toMatchObject({
        cached: true,
        commit: "fc3f257b643b",
        report: { repo: "acme/widgets" }
      })
    } finally {
      await f.close()
    }
  })

  it("says there is no cached report when the backend has none", async () => {
    const { requests, fixture } = serve(null)
    const f = await fixture
    try {
      const result = await f.run(["repo", "report", "acme/widgets", "--workspace", WORKSPACE, "--format", "json"])
      expect(result.code, result.output + result.error).toBe(0)
      expect(requests).toHaveLength(1)
      expect(JSON.parse(result.output)).toEqual({ cached: false, repo: "acme/widgets" })
    } finally {
      await f.close()
    }
  })
})

// T-MCH-01, spec §20.2: the CLI reads the same host model as Settings.
describe("host status", () => {
  it("reads the authenticated profile, limits and clamped capacity", async () => {
    const seen: string[] = []
    const f = await homeFixture((req, res) => {
      seen.push(`${req.method} ${req.url}`)
      expect(req.headers.authorization).toBe("token home-session-secret")
      res.writeHead(200, { "content-type": "application/json" })
      res.end(
        JSON.stringify({
          profile: { memory_bytes: 32 * 2 ** 30 },
          limits: { capacity: 3 },
          machines: { in_use: 1, capacity: 2 }
        })
      )
    })
    try {
      const result = await f.run(["host", "status", "--json"])
      expect(result.code).toBe(0)
      expect(seen).toEqual(["GET /api/install"])
      expect(result.output).toContain("\"capacity\": 2")
    } finally {
      await f.close()
    }
  })
})
