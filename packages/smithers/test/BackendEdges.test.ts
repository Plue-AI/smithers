import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ask } from "../src/internal/backend/AgentDocs.ts"
import { auth } from "../src/internal/backend/Auth.ts"
import { APIError, Client, object } from "../src/internal/backend/Client.ts"
import { handlers } from "../src/internal/backend/Commands.ts"
import { repositories } from "../src/internal/backend/Repositories.ts"
import { durable, sshArgs } from "../src/internal/backend/SSH.ts"
const hostKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl"
import { workspaces } from "../src/internal/backend/Workspaces.ts"
const dirs: string[] = [], cwd = process.cwd()
afterEach(async () => {
  process.chdir(cwd)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})
const fixture = async (env: Record<string, string> = {}) => {
  const home = await mkdtemp(join(tmpdir(), "one-cli-edge-"))
  dirs.push(home)
  const c = new Client({
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      SMITHERS_API_ORIGIN: "https://api.example.test",
      SMITHERS_TOKEN: "session",
      SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
      ...env
    },
    stderr: { write: () => {}, isTTY: false, columns: 80 }
  })
  return { c, home }
}
const options = { repo: "owner/repo" },
  apiError = (status: number) => new APIError(status, {}, "GET", "/repo", new Headers())
describe("repository edge contracts", () => {
  it.each([401, 403, 404])("handles clone preflight HTTP %s", async (status) => {
    const { c } = await fixture()
    vi.spyOn(c, "request").mockRejectedValue(apiError(status))
    const exec = vi.spyOn(c, "exec").mockResolvedValue("")
    if (status === 404) await expect(repositories["repo clone"]!(c, { repo: "owner/repo" }, {})).rejects.toThrow("404")
    else expect(await repositories["repo clone"]!(c, { repo: "owner/repo" }, {})).toMatchObject({ tool: "jj" })
    if (status === 404) expect(exec).not.toHaveBeenCalled()
  })
  it("clones anonymously and accepts a positional directory plus clone arguments", async () => {
    const { c } = await fixture({ SMITHERS_TOKEN: "" })
    const exec = vi.spyOn(c, "exec").mockResolvedValue("")
    await repositories["repo clone"]!(c, { repo: "owner/repo", rest: ["copy", "--depth=1"] }, {})
    expect(exec).toHaveBeenCalledWith("jj", [
      "git",
      "clone",
      "git@ssh.example.test:owner/repo.git",
      "copy",
      "--depth=1"
    ])
    await expect(repositories["repo clone"]!(c, {}, {})).rejects.toThrow("required")
  })
  it("lists published refs without starting a local process", async () => {
    const { c } = await fixture()
    const exec = vi.spyOn(c, "exec"), request = vi.spyOn(c, "request").mockResolvedValue([])
    expect(await repositories["repo push"]!(c, {}, { ...options, list: true })).toEqual([])
    expect(exec).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledWith("GET", "/api/repos/owner/repo/user-refs")
  })
  it("infers the repository from a GitHub origin without --repo, in git and non-colocated jj checkouts", async () => {
    const { c, home } = await fixture()
    const run = (command: string, args: Array<string>, dir: string) => {
      const result = spawnSync(command, args, { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: home } })
      if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: ${result.stderr}`)
    }
    const request = vi.spyOn(c, "request").mockResolvedValue([])
    const git = join(home, "git")
    await mkdir(git)
    run("git", ["init", "-q"], git)
    run("git", ["remote", "add", "upstream", "https://github.com/other/fork.git"], git)
    run("git", ["remote", "add", "origin", "git@github.com:acme/widgets.git"], git)
    process.chdir(git)
    expect(await repositories["repo push"]!(c, {}, { list: true })).toEqual([])
    expect(request).toHaveBeenLastCalledWith("GET", "/api/repos/acme/widgets/user-refs")

    // Only origin names the repository; another GitHub remote never does.
    run("git", ["remote", "remove", "origin"], git)
    await expect(repositories["repo push"]!(c, {}, { list: true })).rejects.toThrow("--repo")

    const jj = join(home, "jj")
    await mkdir(jj)
    run("jj", ["git", "init", "--no-colocate"], jj)
    run("jj", ["git", "remote", "add", "origin", "https://github.com/acme/gadgets.git"], jj)
    process.chdir(jj)
    expect(await repositories["repo push"]!(c, {}, { list: true })).toEqual([])
    expect(request).toHaveBeenLastCalledWith("GET", "/api/repos/acme/gadgets/user-refs")
  })
  it.each(["", "00000", "a\nb"])("rejects invalid jj push revisions %j", async (revision) => {
    const { c } = await fixture()
    vi.spyOn(c, "exec").mockResolvedValue(revision)
    await expect(repositories["repo push"]!(c, {}, options)).rejects.toThrow("one non-root")
  })
  it.each(["", "commit\trefs/smithers/users/7/head"])(
    "renews the current ref without forcing a new commit (%j)",
    async (advertisement) => {
      const { c } = await fixture(), request = vi.spyOn(c, "request").mockResolvedValue({ id: 7 })
      const exec = vi.spyOn(c, "exec").mockImplementation(async (_cmd, args) =>
        args.includes("ls-remote") ? advertisement : "commit"
      )
      expect(await repositories["repo push"]!(c, {}, { ...options, "working-copy": true })).toMatchObject({
        updated: !advertisement
      })
      expect(request).toHaveBeenLastCalledWith("POST", "/api/repos/owner/repo/user-refs/renew", { name: "head" })
      if (advertisement) expect(exec.mock.calls.some(([, args]) => args.includes("push"))).toBe(false)
    }
  )
  it("does not delete an absent jj user ref", async () => {
    const { c } = await fixture()
    vi.spyOn(c, "request").mockResolvedValue({ id: 7 })
    const exec = vi.spyOn(c, "exec").mockResolvedValue("")
    expect(await repositories["repo push"]!(c, {}, { ...options, delete: true })).toMatchObject({ deleted: false })
    expect(exec.mock.calls.some(([, args]) => args.includes("push"))).toBe(false)
  })
  it("refuses a git working copy and missing user identity", async () => {
    const { c } = await fixture(),
      exec = vi.spyOn(c, "exec").mockImplementation(async (command) => {
        if (command === "jj") throw new Error("not jj")
        return "commit"
      })
    await expect(repositories["repo push"]!(c, {}, { ...options, "working-copy": true })).rejects.toThrow(
      "requires a jj"
    )
    vi.spyOn(c, "request").mockResolvedValue({})
    exec.mockResolvedValue("commit")
    await expect(repositories["repo push"]!(c, {}, options)).rejects.toThrow("user id")
  })
  it("keeps existing package declarations and reports malformed cache setup", async () => {
    const { c, home } = await fixture()
    process.chdir(home)
    const request = vi.spyOn(c, "request").mockResolvedValue({})
    await expect(repositories["cache connect"]!(c, {}, options)).rejects.toThrow("public read token")
    request.mockResolvedValue({ token: "smithers_cachero_public" })
    await writeFile("PACKAGE.ts", "export const existing = 1\n")
    await expect(repositories["cache connect"]!(c, {}, options)).rejects.toThrow("must import")
    await writeFile("PACKAGE.ts", "import * as Smithers from \"@smthrs/build\"\nexport const existing = 1\n")
    await repositories["cache connect"]!(c, {}, options)
    expect(await readFile("PACKAGE.ts", "utf8")).toContain("export const existing = 1")
  })
  it("rejects invalid local config shapes and a non-directory jj marker", async () => {
    const { c, home } = await fixture()
    process.chdir(home)
    await writeFile(".jj", "bad")
    await expect(repositories["repo status"]!(c, {}, {})).rejects.toThrow("NOT_JJ_REPO")
    await rm(".jj")
    await mkdir(".jj")
    await mkdir(".smithers")
    await writeFile(".smithers/config.json", "[]")
    await expect(repositories["repo status"]!(c, {}, {})).rejects.toThrow("Invalid")
  })
  it("supports repository pagination, overrides and public creation", async () => {
    const { c } = await fixture(), request = vi.spyOn(c, "request").mockResolvedValue({})
    await repositories["repo list"]!(c, {}, { page: 2, limit: 5 })
    expect(request).toHaveBeenLastCalledWith("GET", "/api/user/repos?page=2&per_page=5")
    await repositories["repo view"]!(c, { repo: "owner/repo" }, {})
    expect(request).toHaveBeenLastCalledWith("GET", "/api/repos/owner/repo")
    await repositories["repo view"]!(c, { repo: "wrong/repo" }, options)
    expect(request).toHaveBeenLastCalledWith("GET", "/api/repos/owner/repo")
    await repositories["repo create"]!(c, { name: "repo" }, { description: "Description" })
    expect(request.mock.calls.at(-1)![2]).toEqual({ name: "repo", description: "Description" })
  })
})
describe("offline docs and ancillary commands", () => {
  it("reports unavailable docs and missing repository context honestly", async () => {
    const { c } = await fixture({ SMITHERS_TOKEN: "", XDG_CACHE_HOME: "" })
    vi.spyOn(c, "repo").mockImplementation(() => {
      throw new Error("no repo")
    })
    vi.spyOn(c, "exec").mockImplementation(() => {
      throw new Error("no jj")
    })
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    const value = object(await ask(c, { prompt: "anything" }, {}))
    expect(value.docs_status).toMatchObject({ status: "unavailable", source: "none" })
    expect(object(value.repo_context).repoSource).toBe("unavailable")
    expect(value.response).toContain("503")
    await expect(ask(c, {}, options)).rejects.toThrow("no repo")
  })
  it("chunks large docs, reports no matches, and sends conditional timestamps", async () => {
    const { c } = await fixture()
    vi.spyOn(c, "repo").mockReturnValue("owner/repo")
    vi.spyOn(c, "exec").mockResolvedValue("checkout")
    vi.spyOn(c, "request").mockRejectedValue(apiError(404))
    const fetch = vi.fn().mockResolvedValueOnce(
      new Response(`# Title\n${"words ".repeat(260)}\nNext line\n## Nested\nDetails`, {
        headers: { "last-modified": "yesterday" }
      })
    ).mockResolvedValueOnce(new Response(null, { status: 304 }))
    vi.stubGlobal("fetch", fetch)
    const value = object(await ask(c, { prompt: "unmatched" }, {}))
    expect(value.response).toBe("No Smithers docs sections matched the prompt")
    expect(object(value.repo_context).repoSource).toBe("detected")
    expect(object(value.repo_context).remoteRepo).toMatchObject({ available: false })
    await ask(c, { prompt: "words" }, {})
    expect(fetch.mock.calls[1]![1].headers).toEqual({ "if-modified-since": "yesterday" })
  })
  it.each([false, true])("lists subscription connections for org=%s", async (org) => {
    const { c } = await fixture(), request = vi.spyOn(c, "request").mockResolvedValue([])
    await auth["auth connections"]!(c, {}, org ? { org: "org" } : {})
    expect(request).toHaveBeenCalledWith(
      "GET",
      org ? "/api/orgs/org/provider-connections" : "/api/user/provider-connections"
    )
    expect(await auth["auth revoke"]!(c, { id: "connection" }, {})).toEqual({ status: "revoked", id: "connection" })
  })
  it.each(["bash", "zsh", "fish"])("generates %s completion for the npm executable", async (shell) => {
    const { c } = await fixture()
    expect(await handlers.completion!(c, { shell }, {})).toContain("smithers")
  })
  it("filters workspace snapshot receipts by workspace id", async () => {
    const { c } = await fixture()
    vi.spyOn(c, "response").mockResolvedValue(
      new Response(JSON.stringify([{ workspace_id: "box", id: 1 }, { workspace_id: "other", id: 2 }]))
    )
    expect(await workspaces["workspace snapshots"]!(c, { id: "box" }, options)).toEqual([{
      workspace_id: "box",
      id: 1
    }])
  })
})
describe("SSH validation and durable receipt errors", () => {
  it.each([
    "",
    "ssh",
    "ssh -o",
    "ssh -o= host",
    "ssh -oConnectTimeout=bad host",
    "ssh -oCompression=maybe host",
    "ssh -p",
    "ssh -i 'bad\nkey' host",
    "ssh -q host",
    "ssh host\\"
  ])("rejects malformed SSH command %j", async (command) => {
    const { c } = await fixture()
    await expect(sshArgs(c, { command, hostKeys: [hostKey] })).rejects.toThrow()
  })
  it("preserves escaped identity paths, booleans and address-family flags", async () => {
    const { c } = await fixture()
    const args = await sshArgs(c, {
      command: " ssh  -4 -6 -t -tt -T -i /tmp/key\\ file -oCompression=yes host ",
      hostKeys: [hostKey]
    }, true)
    expect(args).toContain("/tmp/key file")
    expect(args[0]).toBe("-tt")
  })
  it.each([
    "ERROR: state unavailable",
    "not a receipt",
    "SMITHERS_EXEC_V1\n256\n\n\nEND\n",
    "SMITHERS_EXEC_V1\ninvalid\n\n\nEND\n"
  ])("refuses invalid durable receipt %j", async (receipt) => {
    const { c } = await fixture()
    await expect(durable(c, "id", "true", async () => receipt, 0)).rejects.toThrow()
  })
  it("rejects invalid exec ids before contacting a box", async () => {
    const { c } = await fixture(), send = vi.fn()
    await expect(durable(c, "../id", "true", send, 1000)).rejects.toThrow("Invalid exec id")
    expect(send).not.toHaveBeenCalled()
  })
  it("leaves a timed-out remote command attachable", async () => {
    const { c } = await fixture()
    await expect(durable(
      c,
      "id",
      "true",
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 3))
        return "SMITHERS_EXEC_V1\nrunning\n\n\nEND\n"
      },
      1,
      1
    )).rejects.toThrow("Reattach with --exec-id id")
  })
})
