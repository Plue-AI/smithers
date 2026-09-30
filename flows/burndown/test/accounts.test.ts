import { Schema } from "effect"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  Account,
  accountEnv,
  discoverAccounts,
  freshAccessToken,
  readAccounts,
  Reading,
  readUsage,
  Usage
} from "../accounts.ts"
import type { Account as AccountType } from "../accounts.ts"

const jwt = (email: string) => `header.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.sig`
async function fixture(t: test.TestContext) {
  const home = await mkdtemp(join(tmpdir(), "burndown-test-"))
  t.after(() => rm(home, { recursive: true, force: true }))
  const accountsDir = join(home, "accounts")
  await mkdir(accountsDir)
  async function login(id: string, email: string) {
    const directory = id === "codex-default" ? join(home, ".codex") : join(accountsDir, id)
    await mkdir(directory, { recursive: true })
    if (id.startsWith("claude")) {
      await writeFile(join(directory, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: email } }))
      await writeFile(
        join(directory, ".credentials.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: `token-${id}` } })
      )
    } else {await writeFile(
        join(directory, "auth.json"),
        JSON.stringify({ tokens: { id_token: jwt(email), access_token: `token-${id}`, account_id: "account-id" } })
      )}
    return { id, tool: id.startsWith("claude") ? "claude" : "codex", email, directory, aliases: [] } as AccountType
  }
  return { home, accountsDir, login }
}
test("discovery deduplicates by tool/email, lists aliases, and explains skipped logins", async (t) => {
  const f = await fixture(t)
  await f.login("claude-1", "same@test")
  await f.login("claude-2", "same@test")
  await f.login("codex-1", "same@test")
  await f.login("codex-default", "default@test")
  await f.login("claude-3", "will@codeplane.app")
  await mkdir(join(f.accountsDir, "codex-empty"))
  const found = await discoverAccounts({ ...f, excludeEmails: "will@codeplane.app" })
  assert.equal(found.accounts.length, 3)
  const claude = found.accounts.find((a) => a.tool === "claude")!
  assert.equal(claude.email, "same@test")
  assert.equal(claude.aliases.length, 1)
  assert.ok(found.skipped.some((s) => s.id === "codex-empty" && s.reason.length > 0))
  assert.ok(!found.accounts.some((a) => a.email === "will@codeplane.app"))
  Schema.decodeUnknownSync(Account)(claude)
})
test("discovery tolerates malformed login files without losing valid accounts", async (t) => {
  const f = await fixture(t)
  await f.login("codex-1", "ok@test")
  const directory = join(f.accountsDir, "codex-bad")
  await mkdir(directory)
  await writeFile(join(directory, "auth.json"), "{invalid")
  const found = await discoverAccounts(f)
  assert.equal(found.accounts.length, 1)
  assert.ok(found.skipped.some((s) => s.id === "codex-bad"))
})
test("account execution environments and fresh Linux tokens pin the account", async (t) => {
  const f = await fixture(t)
  const claude = await f.login("claude-1", "c@test")
  const codex = await f.login("codex-1", "d@test")
  assert.deepEqual(accountEnv(claude), { CLAUDE_CONFIG_DIR: claude.directory })
  assert.deepEqual(accountEnv(codex), { CODEX_HOME: codex.directory })
  assert.equal(await freshAccessToken(claude, { platform: "linux" }), "token-claude-1")
  await writeFile(
    join(claude.directory, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "refreshed" } })
  )
  assert.equal(await freshAccessToken(claude, { platform: "linux" }), "refreshed")
})
// Inject network/keychain boundaries to avoid real credentials, paid quota, and platform dependence.
test("macOS keychain uses the absolute-directory service hash", async (t) => {
  const f = await fixture(t)
  const account = await f.login("claude-1", "c@test")
  const calls: Array<Array<unknown>> = []
  const token = await freshAccessToken(account, {
    platform: "darwin",
    execFile: async (...args: Array<unknown>) => {
      calls.push(args)
      return { stdout: JSON.stringify({ claudeAiOauth: { accessToken: "keychain-token" } }) }
    }
  })
  assert.equal(token, "keychain-token")
  assert.equal(calls[0]![0], "security")
  assert.deepEqual(calls[0]![1], [
    "find-generic-password",
    "-s",
    `Claude Code-credentials-${createHash("sha256").update(account.directory).digest("hex").slice(0, 8)}`,
    "-w"
  ])
})
test("Claude usage carries both windows and required OAuth headers", async (t) => {
  const f = await fixture(t)
  const account = await f.login("claude-1", "c@test")
  const fetcher: (input: string, init?: RequestInit) => Promise<Response> = async (url, options) => {
    assert.equal(String(url), "https://api.anthropic.com/api/oauth/usage")
    const headers = new Headers(options?.headers)
    assert.equal(headers.get("Authorization"), "Bearer token-claude-1")
    assert.equal(headers.get("anthropic-beta"), "oauth-2025-04-20")
    return Response.json({
      five_hour: { utilization: 20, resets_at: "2026-09-30T00:00:00Z" },
      seven_day: { utilization: 30, resets_at: "2026-10-01T00:00:00Z" }
    })
  }
  const r = await readUsage(account, { platform: "linux", fetch: fetcher })
  assert.equal(r.error, null)
  assert.deepEqual(r.usage!.windows.map((w) => [w.name, w.used, w.durationHours]), [["five_hour", 20, 5], [
    "seven_day",
    30,
    168
  ]])
  assert.equal(r.usage!.windows[0]!.resetsAt, Date.parse("2026-09-30T00:00:00Z"))
  Schema.decodeUnknownSync(Usage)(r.usage)
  Schema.decodeUnknownSync(Reading)(r)
})
test("Codex usage normalizes seconds, percentages, limit flag and account header", async (t) => {
  const f = await fixture(t)
  const account = await f.login("codex-1", "d@test")
  const r = await readUsage(account, {
    fetch: async (url, options) => {
      assert.equal(String(url), "https://chatgpt.com/backend-api/wham/usage")
      const headers = new Headers(options?.headers)
      assert.equal(headers.get("Authorization"), "Bearer token-codex-1")
      assert.equal(headers.get("ChatGPT-Account-Id"), "account-id")
      assert.equal(headers.get("User-Agent"), "codex_cli_rs")
      return Response.json({
        rate_limit: {
          primary_window: { used_percent: 99, limit_window_seconds: 604800, reset_at: 1_800_000_000 },
          limit_reached: true
        }
      })
    }
  })
  assert.deepEqual(r.usage, {
    windows: [{ name: "primary", used: 99, durationHours: 168, resetsAt: 1_800_000_000_000 }],
    limitReached: true
  })
})
test("per-account typed errors isolate expired, missing and unavailable logins", async (t) => {
  const f = await fixture(t)
  const a = await f.login("codex-1", "a@test")
  const b = await f.login("codex-2", "b@test")
  const expired = await readUsage(a, { fetch: async () => new Response("", { status: 401 }) })
  assert.equal(expired.error?._tag, "LoginExpired")
  const unavailable = await readUsage(a, {
    fetch: async () => {
      throw new Error("offline")
    }
  })
  assert.equal(unavailable.error?._tag, "UsageUnavailable")
  const malformed = await readUsage(a, { fetch: async () => Response.json({ wrong: true }) })
  assert.equal(malformed.error?._tag, "UsageUnavailable")
  await writeFile(join(a.directory, "auth.json"), JSON.stringify({ tokens: { id_token: jwt(a.email) } }))
  const readings = await readAccounts([a, b], {
    fetch: async () =>
      Response.json({
        rate_limit: {
          primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_at: 1_800_000_000 },
          limit_reached: false
        }
      })
  })
  assert.equal(readings[0]!.error?._tag, "NoToken")
  assert.equal(readings[1]!.error, null)
  assert.equal(readings[1]!.account.id, b.id)
})
test("missing directories and failed keychains yield safe account results", async (t) => {
  const f = await fixture(t)
  assert.equal((await discoverAccounts({ home: f.home, accountsDir: join(f.home, "absent") })).accounts.length, 0)
  const account = await f.login("claude-1", "c@test")
  const missing = await readUsage(account, {
    platform: "darwin",
    execFile: async () => {
      throw new Error("locked")
    }
  })
  assert.equal(missing.error?._tag, "NoToken")
  for (const status of [403, 429, 500]) {
    assert.equal(
      (await readUsage(account, { platform: "linux", fetch: async () => new Response("", { status }) })).error?._tag,
      "UsageUnavailable"
    )
  }
})
test("invalid usage data cannot become a pacing reading", async (t) => {
  const f = await fixture(t)
  const account = await f.login("codex-1", "d@test")
  for (
    const window of [
      { used_percent: -1, limit_window_seconds: 18000, reset_at: 1800000000 },
      { used_percent: 101, limit_window_seconds: 18000, reset_at: 1800000000 },
      { used_percent: 10, limit_window_seconds: 0, reset_at: 1800000000 },
      { used_percent: 10, limit_window_seconds: 18000, reset_at: "wrong" }
    ]
  ) {
    const r = await readUsage(account, {
      fetch: async () => Response.json({ rate_limit: { primary_window: window, limit_reached: false } })
    })
    assert.equal(r.error?._tag, "UsageUnavailable")
  }
  await writeFile(join(account.directory, "auth.json"), JSON.stringify({ tokens: { access_token: "token" } }))
  assert.equal((await readUsage(account)).error?._tag, "NoToken")
})
test("environment discovery exclusions and default keychain service are honored", async (t) => {
  const f = await fixture(t)
  await f.login("claude-1", " C@Test ")
  const oldBase = process.env.BURNDOWN_ACCOUNTS_DIR
  const oldExclude = process.env.BURNDOWN_EXCLUDE_EMAILS
  t.after(() => {
    if (oldBase === undefined) delete process.env.BURNDOWN_ACCOUNTS_DIR
    else process.env.BURNDOWN_ACCOUNTS_DIR = oldBase
    if (oldExclude === undefined) delete process.env.BURNDOWN_EXCLUDE_EMAILS
    else process.env.BURNDOWN_EXCLUDE_EMAILS = oldExclude
  })
  process.env.BURNDOWN_ACCOUNTS_DIR = f.accountsDir
  process.env.BURNDOWN_EXCLUDE_EMAILS = " ,c@test, "
  assert.equal((await discoverAccounts({ home: f.home })).accounts.length, 0)
  const account: AccountType = {
    id: "claude-default",
    tool: "claude",
    email: "x@test",
    directory: join(homedir(), ".claude"),
    aliases: []
  }
  assert.equal(
    await freshAccessToken(account, {
      platform: "darwin",
      execFile: async (_file, args) => {
        assert.equal(args[2], "Claude Code-credentials")
        return { stdout: JSON.stringify({ claudeAiOauth: { accessToken: "injected" } }) }
      }
    }),
    "injected"
  )
})
test("discovery rejects absent emails and files pretending to be account directories", async (t) => {
  const f = await fixture(t)
  const a = await f.login("claude-1", "")
  await writeFile(join(a.directory, ".claude.json"), JSON.stringify({ oauthAccount: {} }))
  await writeFile(join(f.accountsDir, "codex-file"), "not a directory")
  await mkdir(join(f.accountsDir, "unrelated"))
  const found = await discoverAccounts(f)
  assert.equal(found.accounts.length, 0)
  assert.ok(found.skipped.some((s) => s.id === "claude-1"))
  assert.ok(found.skipped.some((s) => s.id === "codex-file"))
  assert.ok(!found.skipped.some((s) => s.id === "unrelated"))
})
test("malformed keychain credentials and missing tokens are typed failures", async (t) => {
  const f = await fixture(t)
  const account = await f.login("claude-1", "c@test")
  for (const stdout of ["{broken", "{}", "{\"claudeAiOauth\":{\"accessToken\":\"\"}}"]) {
    const r = await readUsage(account, { platform: "darwin", execFile: async () => ({ stdout }) })
    assert.equal(r.error?._tag, "NoToken")
  }
  const codex = await f.login("codex-1", "d@test")
  await writeFile(join(codex.directory, "auth.json"), "{}")
  assert.equal((await readUsage(codex)).error?._tag, "NoToken")
})
test("default discovery paths and filesystem errors remain observable", async (t) => {
  const f = await fixture(t)
  const oldHome = process.env.HOME
  const oldBase = process.env.BURNDOWN_ACCOUNTS_DIR
  t.after(() => {
    if (oldHome === undefined) delete process.env.HOME
    else process.env.HOME = oldHome
    if (oldBase === undefined) delete process.env.BURNDOWN_ACCOUNTS_DIR
    else process.env.BURNDOWN_ACCOUNTS_DIR = oldBase
  })
  process.env.HOME = f.home
  delete process.env.BURNDOWN_ACCOUNTS_DIR
  assert.equal((await discoverAccounts()).accounts.length, 0)
  const file = join(f.home, "file")
  await writeFile(file, "not directory")
  await assert.rejects(discoverAccounts({ accountsDir: file }), { code: "ENOTDIR" })
  const account = await f.login("codex-1", "d@test")
  await writeFile(join(account.directory, "auth.json"), "{}")
  assert.equal((await discoverAccounts({ home: f.home, accountsDir: f.accountsDir })).accounts.length, 0)
})
test("default fetch and process execution use injected host boundaries", async (t) => {
  const f = await fixture(t)
  const account = await f.login("codex-1", "d@test")
  const originalFetch = globalThis.fetch
  t.after(() => {
    globalThis.fetch = originalFetch
  })
  globalThis.fetch = Object.assign(async () =>
    Response.json({
      rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: 1800000000 } }
    }), originalFetch)
  assert.equal((await readUsage(account)).error, null)
  const claude = await f.login("claude-1", "c@test")
  // An isolated executable covers the real child-process boundary without invoking the host keychain.
  const bin = join(f.home, "bin")
  await mkdir(bin)
  await writeFile(join(bin, "security"), "#!/bin/sh\nprintf '{\"claudeAiOauth\":{\"accessToken\":\"fixture\"}}'\n", {
    mode: 0o755
  })
  const originalPath = process.env.PATH
  t.after(() => {
    process.env.PATH = originalPath
  })
  process.env.PATH = bin
  assert.equal(await freshAccessToken(claude, { platform: "darwin" }), "fixture")
  const defaultPlatformToken = await freshAccessToken(claude, {
    execFile: async () => ({ stdout: "{\"claudeAiOauth\":{\"accessToken\":\"fixture\"}}" })
  })
  assert.equal(defaultPlatformToken, process.platform === "darwin" ? "fixture" : "token-claude-1")
})
test("keychain process has a bounded timeout", async (t) => {
  const f = await fixture(t)
  const account = await f.login("claude-1", "c@test")
  const calls: Array<{ timeout: number } | undefined> = []
  const token = await freshAccessToken(account, {
    platform: "darwin",
    execFile: async (_file, _args, options) => {
      calls.push(options)
      return { stdout: "{\"claudeAiOauth\":{\"accessToken\":\"fixture\"}}" }
    }
  })
  assert.equal(token, "fixture")
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { timeout: 30_000 })
})
test("reserved default account directories retain distinct identities and deduplicate aliases", async (t) => {
  const f = await fixture(t)
  const directory = join(f.accountsDir, "codex-default")
  await mkdir(directory)
  await writeFile(join(directory, "auth.json"), JSON.stringify({ tokens: { id_token: jwt("reserved@test") } }))
  await f.login("codex-default", "home@test")
  let found = await discoverAccounts(f)
  assert.deepEqual(found.accounts.map((a) => [a.id, a.directory]), [["accounts/codex-default", directory], [
    "codex-default",
    join(f.home, ".codex")
  ]])
  await writeFile(join(directory, "auth.json"), JSON.stringify({ tokens: { id_token: jwt("home@test") } }))
  found = await discoverAccounts(f)
  assert.equal(found.accounts.length, 1)
  assert.deepEqual(found.accounts[0]!.aliases, ["codex-default"])
  assert.equal(found.accounts[0]!.id, "accounts/codex-default")
  assert.equal(found.accounts[0]!.directory, directory)
})

test("selected-account discovery leaves unrelated login directories unread", async (t) => {
  const f = await fixture(t)
  await f.login("codex-selected", "selected@test")
  await mkdir(join(f.accountsDir, "claude-unrelated"))
  const found = await discoverAccounts({ ...f, onlyIds: ["codex-selected"] })
  assert.deepEqual(found.accounts.map((account) => account.id), ["codex-selected"])
  assert.deepEqual(found.skipped, [])
  assert.deepEqual((await discoverAccounts({ ...f, onlyIds: [] })).accounts, [])
})
