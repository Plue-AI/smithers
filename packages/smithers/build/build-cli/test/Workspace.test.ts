/**
 * `parseSmithersCloudRemote` over every remote spelling git writes into
 * `.git/config`: URL forms, and SCP-style forms with and without a username.
 */
import * as RemoteCache from "@smthrs/targets/RemoteCache"
import * as Secret from "@smthrs/targets/Secret"
import { execFileSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  discoverSmithersCloudRepository,
  normalizeOverrideEndpoint,
  parseSmithersCloudRemote,
  remoteCacheOf,
  smithersCloudCacheEndpoint,
  withheldEnvironment
} from "../src/Workspace.ts"

const roots: Array<string> = []
const temporaryRoot = async (): Promise<string> => {
  const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-workspace-remote-"))
  roots.push(root)
  return root
}
const config = async (root: string, path: string, contents: string): Promise<void> => {
  const file = NodePath.join(root, path)
  await Fs.mkdir(NodePath.dirname(file), { recursive: true })
  await Fs.writeFile(file, contents)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => Fs.rm(root, { recursive: true, force: true })))
})

describe("parseSmithersCloudRemote", () => {
  it("reads the same repository from every spelling of one remote", () => {
    const expected = { repo: "alice/repo", host: "jjhub.tech" }
    expect(parseSmithersCloudRemote("https://jjhub.tech/alice/repo.git")).toEqual(expected)
    expect(parseSmithersCloudRemote("ssh://git@jjhub.tech/alice/repo.git")).toEqual(expected)
    expect(parseSmithersCloudRemote("git@jjhub.tech:alice/repo.git")).toEqual(expected)
    // An SCP-style remote without a user parses as an opaque URL whose scheme
    // is the host, so the host check only sees it if the SCP branch reruns.
    expect(parseSmithersCloudRemote("jjhub.tech:alice/repo.git")).toEqual(expected)
  })

  it("keeps the remote's subdomain and trims surrounding whitespace", () => {
    expect(parseSmithersCloudRemote("  ssh.jjhub.tech:alice/repo  ")).toEqual({
      repo: "alice/repo",
      host: "ssh.jjhub.tech"
    })
    expect(parseSmithersCloudRemote("git@SSH.JJHUB.TECH:alice/repo.git")).toEqual({
      repo: "alice/repo",
      host: "ssh.jjhub.tech"
    })
  })

  it("refuses a remote on another host in either spelling", () => {
    expect(parseSmithersCloudRemote("github.com:alice/repo.git")).toBeUndefined()
    expect(parseSmithersCloudRemote("git@github.com:alice/repo.git")).toBeUndefined()
    expect(parseSmithersCloudRemote("https://github.com/alice/repo.git")).toBeUndefined()
  })

  it("honours the supplied host set instead of the defaults", () => {
    const hosts = new Set(["git.example.test"])
    expect(parseSmithersCloudRemote("git.example.test:alice/repo.git", hosts)).toEqual({
      repo: "alice/repo",
      host: "git.example.test"
    })
    expect(parseSmithersCloudRemote("jjhub.tech:alice/repo.git", hosts)).toBeUndefined()
  })

  it("refuses a remote whose path is not exactly owner and name", () => {
    expect(parseSmithersCloudRemote("jjhub.tech:repo.git")).toBeUndefined()
    expect(parseSmithersCloudRemote("jjhub.tech:alice/team/repo.git")).toBeUndefined()
    expect(parseSmithersCloudRemote("https://jjhub.tech/alice")).toBeUndefined()
    expect(parseSmithersCloudRemote("not a remote")).toBeUndefined()
  })

  it("rejects lookalike hosts, malformed paths, and non-repository URL forms", () => {
    for (
      const remote of [
        "https://jjhub.tech.evil.example/alice/repo.git",
        "https://jjhub.tech/alice/repo.git/extra",
        "https://jjhub.tech//repo.git",
        "https://jjhub.tech/alice/",
        "file:///alice/repo.git",
        "git@jjhub.tech:alice/team/repo.git"
      ]
    ) {
      expect(parseSmithersCloudRemote(remote), remote).toBeUndefined()
    }
  })
})

describe("discoverSmithersCloudRepository", () => {
  it("prioritizes origin within .git/config and that config over the jj backend", async () => {
    const root = await temporaryRoot()
    await config(
      root,
      ".git/config",
      [
        "[remote \"backup\"]",
        "  url = git@jjhub.tech:backup/repo.git",
        "[remote \"origin\"]",
        "  url = https://jjhub.tech/alice/main.git",
        "[remote \"other\"]",
        "  url = git@jjhub.tech:other/repo.git"
      ].join("\n")
    )
    await config(root, ".jj/repo/store/git/config", "[remote \"origin\"]\nurl = git@jjhub.tech:jj/repo.git\n")
    expect(await discoverSmithersCloudRepository(root, {})).toEqual({ repo: "alice/main", host: "jjhub.tech" })
  })

  it("falls back from an unrelated origin to another remote and then the jj backend", async () => {
    const root = await temporaryRoot()
    const unrelatedOrigin = "[remote \"origin\"]\nurl = https://github.com/alice/elsewhere.git\n"
    await config(
      root,
      ".git/config",
      `${unrelatedOrigin}[remote "backup"]\nurl = git@jjhub.tech:backup/work.git\n`
    )
    await config(
      root,
      ".jj/repo/store/git/config",
      [
        "[remote \"mirror\"]",
        "url = git@GIT.EXAMPLE.TEST:team/work.git",
        "[core]",
        "repositoryformatversion = 0",
        "[remote \"broken\"]",
        "url = not a remote"
      ].join("\n")
    )
    const environment = { SMITHERS_CLOUD_HOSTS: " git.example.test, " }
    expect(await discoverSmithersCloudRepository(root, environment))
      .toEqual({ repo: "backup/work", host: "jjhub.tech" })
    await config(root, ".git/config", unrelatedOrigin)
    expect(await discoverSmithersCloudRepository(root, environment))
      .toEqual({ repo: "team/work", host: "git.example.test" })
  })

  it("ignores missing, non-file, and symlink config inputs", async () => {
    const root = await temporaryRoot()
    expect(await discoverSmithersCloudRepository(root, {})).toBeUndefined()
    await Fs.mkdir(NodePath.join(root, ".git", "config"), { recursive: true })
    expect(await discoverSmithersCloudRepository(root, {})).toBeUndefined()
    await Fs.rm(NodePath.join(root, ".git", "config"), { recursive: true })
    await config(root, "secret-config", "[remote \"origin\"]\nurl = git@jjhub.tech:secret/repo.git\n")
    await Fs.symlink(NodePath.join(root, "secret-config"), NodePath.join(root, ".git", "config"))
    expect(await discoverSmithersCloudRepository(root, {})).toBeUndefined()
  })

  it("discovers the same repository from a real linked Git worktree as from its primary checkout", async () => {
    const primary = await temporaryRoot()
    const linked = NodePath.join(await temporaryRoot(), "linked")
    const git = (cwd: string, ...args: ReadonlyArray<string>) =>
      execFileSync("git", [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.test",
        "-c",
        "commit.gpgsign=false",
        ...args
      ], {
        cwd,
        encoding: "utf8",
        env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))),
        stdio: ["ignore", "pipe", "pipe"]
      })
    git(primary, "init", "-q")
    git(primary, "commit", "-q", "--allow-empty", "-m", "root")
    git(primary, "config", "remote.origin.url", "https://jjhub.tech/alice/review.git")
    git(primary, "worktree", "add", "-q", "--detach", linked, "HEAD")
    expect((await Fs.lstat(NodePath.join(linked, ".git"))).isFile()).toBe(true)
    expect(git(linked, "config", "--get", "remote.origin.url").trim()).toBe("https://jjhub.tech/alice/review.git")
    const expected = { repo: "alice/review", host: "jjhub.tech" }
    expect(await discoverSmithersCloudRepository(primary, {})).toEqual(expected)
    expect(await discoverSmithersCloudRepository(linked, {})).toEqual(expected)
    git(primary, "config", "remote.origin.url", "https://github.com/alice/review.git")
    expect(await discoverSmithersCloudRepository(linked, {})).toBeUndefined()
    expect(await discoverSmithersCloudRepository(linked, { SMITHERS_CLOUD_HOSTS: "github.com" }))
      .toEqual({ repo: "alice/review", host: "github.com" })
  })

  it("follows a relative gitdir pointer with and without a commondir file", async () => {
    const base = await temporaryRoot()
    const root = NodePath.join(base, "checkout")
    await config(root, ".git", "gitdir: ../store/worktrees/one\n")
    await config(base, "store/worktrees/one/config", "[remote \"origin\"]\nurl = git@jjhub.tech:own/dir.git\n")
    // Without commondir, the gitdir itself holds the config.
    expect(await discoverSmithersCloudRepository(root, {})).toEqual({ repo: "own/dir", host: "jjhub.tech" })
    await config(base, "store/worktrees/one/commondir", "../..\n")
    await config(base, "store/config", "[remote \"origin\"]\nurl = git@jjhub.tech:common/dir.git\n")
    expect(await discoverSmithersCloudRepository(root, {})).toEqual({ repo: "common/dir", host: "jjhub.tech" })
  })

  it("ignores malformed, oversized, and symlinked gitdir pointers but still reads the jj backend", async () => {
    const root = await temporaryRoot()
    const target = await temporaryRoot()
    await config(target, "config", "[remote \"origin\"]\nurl = git@jjhub.tech:pointer/target.git\n")
    await config(root, ".jj/repo/store/git/config", "[remote \"origin\"]\nurl = git@jjhub.tech:jj/fallback.git\n")
    const fallback = { repo: "jj/fallback", host: "jjhub.tech" }
    for (
      const pointer of [
        `${target}\n`,
        `gitdir:\n`,
        `gitdir: ${target}\nextra: line\n`,
        `gitdir: ${target}\n${"#".repeat(4096)}`
      ]
    ) {
      await config(root, ".git", pointer)
      expect(await discoverSmithersCloudRepository(root, {}), JSON.stringify(pointer.slice(0, 40))).toEqual(fallback)
    }
    await config(root, ".git", `gitdir: ${target}\n`)
    expect(await discoverSmithersCloudRepository(root, {})).toEqual({ repo: "pointer/target", host: "jjhub.tech" })
    await config(root, "pointer", `gitdir: ${target}\n`)
    await Fs.rm(NodePath.join(root, ".git"))
    await Fs.symlink(NodePath.join(root, "pointer"), NodePath.join(root, ".git"))
    expect(await discoverSmithersCloudRepository(root, {})).toEqual(fallback)
  })

  it("accepts a valid config at 256 KiB and rejects the next byte", async () => {
    const root = await temporaryRoot()
    const remote = "[remote \"origin\"]\nurl = git@jjhub.tech:exact/cap.git\n"
    const maximum = 256 * 1024
    const exact = `${remote}#${"x".repeat(maximum - Buffer.byteLength(remote) - 2)}\n`
    expect(Buffer.byteLength(exact)).toBe(maximum)
    await config(root, ".git/config", exact)
    expect(await discoverSmithersCloudRepository(root, {})).toEqual({ repo: "exact/cap", host: "jjhub.tech" })
    await config(root, ".git/config", `${exact}x`)
    expect(await discoverSmithersCloudRepository(root, {})).toBeUndefined()
  })
})

describe("remote cache endpoint resolution", () => {
  it("normalizes local HTTP overrides and preserves declared split credentials", () => {
    const declaration = RemoteCache.make({
      endpoint: "https://cache.example.test/base/",
      read: Secret.Secret("CACHE_READ"),
      write: Secret.Secret("CACHE_WRITE")
    })
    expect(remoteCacheOf(declaration, " http://127.0.0.1:8080/cache/ ")).toEqual({
      endpoint: "http://127.0.0.1:8080/cache",
      credentials: { _tag: "split", readTokenEnv: "CACHE_READ", writeTokenEnv: "CACHE_WRITE" }
    })
    expect(remoteCacheOf(declaration, "  ")).toEqual({
      endpoint: "https://cache.example.test/base",
      credentials: { _tag: "split", readTokenEnv: "CACHE_READ", writeTokenEnv: "CACHE_WRITE" }
    })
    expect(remoteCacheOf(undefined, "  ")).toBeUndefined()
    expect(() => remoteCacheOf(declaration, "http://cache.example.test/override"))
      .toThrow("remote cache endpoint must use HTTPS")
  })

  it("keeps shared, public-read, and undeclared credential contracts across endpoint overrides", () => {
    const shared = RemoteCache.make({
      endpoint: "https://cache.example.test/shared",
      token: Secret.Secret("SHARED_TOKEN")
    })
    const publicReadToken = `smithers_cachero_${"a".repeat(40)}`
    const publicWithWrite = RemoteCache.make({
      endpoint: "https://cache.example.test/public",
      publicReadToken,
      write: Secret.Secret("WRITE_TOKEN")
    })
    const publicWithDefaultWrite = RemoteCache.make({
      endpoint: "https://cache.example.test/public-default",
      publicReadToken
    })
    expect(remoteCacheOf(shared, "https://staging.example.test/cache/")).toEqual({
      endpoint: "https://staging.example.test/cache",
      credentials: { _tag: "shared", tokenEnv: "SHARED_TOKEN" }
    })
    expect(remoteCacheOf(publicWithWrite, "https://staging.example.test/cache")).toEqual({
      endpoint: "https://staging.example.test/cache",
      credentials: { _tag: "public", publicReadToken, writeTokenEnv: "WRITE_TOKEN" }
    })
    expect(remoteCacheOf(publicWithDefaultWrite)).toEqual({
      endpoint: "https://cache.example.test/public-default",
      credentials: { _tag: "public", publicReadToken, writeTokenEnv: "SMITHERS_CACHE_TOKEN" }
    })
    expect(remoteCacheOf(undefined, "https://override.example.test/cache")).toEqual({
      endpoint: "https://override.example.test/cache",
      credentials: { _tag: "shared", tokenEnv: "SMITHERS_CACHE_TOKEN" }
    })
  })

  it("supports IPv6 loopback but refuses network HTTP and secret-bearing overrides without echoing input", () => {
    expect(normalizeOverrideEndpoint("http://[::1]:8080/cache/")).toBe("http://[::1]:8080/cache")
    const secret = "never-log-this-credential"
    for (
      const [value, message] of [
        [`not-an-endpoint-${secret}`, "remote cache endpoint must be an absolute HTTPS URL"],
        ["http://cache.example.test/cache", "remote cache endpoint must use HTTPS"],
        [`http://user:${secret}@localhost:8080/cache`, "remote cache endpoint must not contain credentials"],
        [`http://localhost:8080/cache?token=${secret}`, "remote cache endpoint must not contain a query or fragment"],
        ["http://localhost:8080/cache#fragment", "remote cache endpoint must not contain a query or fragment"]
      ] as const
    ) {
      let error: unknown
      try {
        normalizeOverrideEndpoint(value)
      } catch (cause) {
        error = cause
      }
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toBe(message)
      expect(String(error)).not.toContain(secret)
    }
  })

  it("escapes Cloud repository components and honors an explicit HTTPS API base", () => {
    expect(smithersCloudCacheEndpoint("a b/repo#1", { SMITHERS_CLOUD_API_URL: "https://api.example.test/base/" }))
      .toBe("https://api.example.test/base/api/repos/a%20b/repo%231/build-cache")
    expect(smithersCloudCacheEndpoint("alice/repo", {}))
      .toBe("https://api.jjhub.tech/api/repos/alice/repo/build-cache")
  })
})

describe("withheldEnvironment", () => {
  const ambient = {
    SMITHERS_CACHE_URL: "https://cache.example",
    SMITHERS_CACHE_TOKEN: "default",
    SHARED_TOKEN: "shared",
    READ_TOKEN: "read",
    WRITE_TOKEN: "write",
    PATH: "/bin",
    HOME: "/home/user"
  }

  it("withholds the default cache names without a declaration", () => {
    expect(withheldEnvironment(ambient, undefined)).toEqual({
      SHARED_TOKEN: "shared",
      READ_TOKEN: "read",
      WRITE_TOKEN: "write",
      PATH: "/bin",
      HOME: "/home/user"
    })
  })

  it("withholds every name each credential shape declares and keeps the rest", () => {
    expect(withheldEnvironment(ambient, { _tag: "shared", tokenEnv: "SHARED_TOKEN" })).toEqual({
      READ_TOKEN: "read",
      WRITE_TOKEN: "write",
      PATH: "/bin",
      HOME: "/home/user"
    })
    expect(withheldEnvironment(ambient, { _tag: "split", readTokenEnv: "READ_TOKEN", writeTokenEnv: "WRITE_TOKEN" }))
      .toEqual({ SHARED_TOKEN: "shared", PATH: "/bin", HOME: "/home/user" })
    expect(withheldEnvironment(ambient, { _tag: "public", publicReadToken: "committed", writeTokenEnv: "WRITE_TOKEN" }))
      .toEqual({ SHARED_TOKEN: "shared", READ_TOKEN: "read", PATH: "/bin", HOME: "/home/user" })
  })

  it("matches names case-insensitively only on Windows", () => {
    const lower = { smithers_cache_token: "default", Path: "/bin" }
    const expected = process.platform === "win32" ? { Path: "/bin" } : lower
    expect(withheldEnvironment(lower, undefined)).toEqual(expected)
  })
})
