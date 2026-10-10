/**
 * C-J6-02: a laptop `smthrs login` gets a delegated credential that can't
 * merge; Merge opens a confirmation only B's browser session approves.
 *
 * The source CLI (`bin/smithers.mjs` → `makeCli`) runs in child processes
 * with a private HOME and no system keyring, against the installed composition
 * that packages/backend's TestDelegatedLoginCLIHarness serves: production
 * StartWithOptions, real PostgreSQL, the native repository engine and the
 * GitHub fake that serves OAuth consent and the merge API. The harness seeds
 * the stack and answers read-only evidence queries; it mints no credential.
 *
 * Enable with SMITHERS_DELEGATED_LOGIN_TEST=1 and SMITHERS_TEST_DATABASE_URL.
 */
import { execFile, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { describe, expect, it } from "vitest"

// The Go fixture owns PostgreSQL and the GitHub fake, then invokes the source
// CLI in isolated homes. Keep one composed-boundary implementation of the
// login, private confirmation, stale-head and session-approval assertions.
const run = promisify(execFile)
const backend = fileURLToPath(new URL("../../backend/", import.meta.url))
describe.skipIf(!process.env.SMITHERS_TEST_DATABASE_URL && !process.env.CI)(
  "delegated laptop login against the install",
  () => {
    it("uses the issued credential to request a review_merge card without merging", async () => {
      const { stdout, stderr } = await run("go", [
        "test",
        "./internal/compose",
        "-run",
        "^Test(DelegatedCredentialComposedInstallPostgres|ConfirmationMergeAdmissionComposedPostgres)$",
        "-count=1",
        "-v"
      ], {
        cwd: backend,
        env: { ...process.env, SMITHERS_REQUIRE_DATABASE_TESTS: "1" },
        timeout: 600_000,
        maxBuffer: 4 << 20
      }).catch((error: Error & { stdout?: string; stderr?: string }) => {
        throw new Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`)
      })
      expect(stdout + stderr).not.toContain("--- SKIP:")
      expect(stdout).toContain("--- PASS: TestConfirmationMergeAdmissionComposedPostgres")
      expect(stdout).toContain("--- PASS: TestDelegatedCredentialComposedInstallPostgres")
    }, 610_000)
  }
)

const enabled = process.env.SMITHERS_DELEGATED_LOGIN_TEST === "1"
const root = fileURLToPath(new URL("../../..", import.meta.url))
const bin = join(root, "packages/smithers/bin/smithers.mjs")

type Host = {
  origin: string
  inspector: string
  member: string
  cookies: Record<string, string>
  codes: Array<string>
  t1: number
  t2: number
  t3: number
  head: string
  pull: number
}
type Run = { code: number | null; stdout: string; stderr: string }
type Write = { method: string; path: string; status: number; body?: Record<string, unknown> }

// B's browser completing GitHub consent: the install's start sets its state
// cookie and sends the browser to GitHub; GitHub returns it to the install's
// callback with a code that signs in as B (one the harness registered on the
// fake); the callback hands the CLI's loopback the issued fragment.
const consent = `#!/usr/bin/env node
const start = await fetch(process.argv[2], { redirect: "manual" })
if (start.status !== 302) throw new Error("start " + start.status + " " + await start.text())
const cookie = start.headers.getSetCookie().map(value => value.split(";")[0]).join("; ")
const github = new URL(start.headers.get("location"))
const back = new URL(github.searchParams.get("redirect_uri"))
back.search = new URLSearchParams({ code: process.env.DELEGATED_LOGIN_CODE, state: github.searchParams.get("state") }).toString()
const callback = await fetch(back, { redirect: "manual", headers: { cookie } })
if (callback.status !== 302) throw new Error("callback " + callback.status + " " + await callback.text())
const loopback = new URL(callback.headers.get("location"))
const values = Object.fromEntries(new URLSearchParams(loopback.hash.slice(1)))
loopback.hash = ""
const settled = await fetch(loopback, { method: "POST", headers: { "content-type": "application/json", origin: loopback.origin }, body: JSON.stringify(values) })
if (settled.status !== 200) throw new Error("loopback " + settled.status + " " + await settled.text())
`

const runProcess = (command: string, args: Array<string>, env: NodeJS.ProcessEnv, timeout = 120_000) =>
  new Promise<Run>((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", (bytes) => (stdout += String(bytes)))
    child.stderr.on("data", (bytes) => (stderr += String(bytes)))
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout)
    child.on("error", reject)
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
  })

const poll = async <T>(read: () => Promise<T | undefined>, what: string, timeout = 120_000): Promise<T> => {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}

it.skipIf(!enabled)("C-J6-02 laptop login is delegated, attributed, and cannot merge without B's press", async () => {
  expect(process.env.SMITHERS_TEST_DATABASE_URL, "C-J6-02 requires real PostgreSQL").toBeTruthy()
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")
  const evidence = join(root, ".artifacts/checks/C-J6-02", stamp)
  mkdirSync(evidence, { recursive: true })
  const record = (name: string, value: unknown) =>
    writeFileSync(join(evidence, name), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n")
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim()
  record("commit.txt", `${process.env.GITHUB_SHA || sha || "unrecorded"}\n`)

  const dir = mkdtempSync(join(tmpdir(), "smithers-delegated-login-"))
  const harness = spawn("go", [
    "test",
    "./internal/compose",
    "-run",
    "^TestDelegatedLoginCLIHarness$",
    "-count=1",
    "-timeout=30m",
    "-v"
  ], {
    cwd: join(root, "packages/backend"),
    env: { ...process.env, SMITHERS_DELEGATED_LOGIN_HARNESS: dir },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let logs = ""
  harness.stdout.on("data", (bytes) => (logs += String(bytes)))
  harness.stderr.on("data", (bytes) => (logs += String(bytes)))
  const exited = new Promise<number | null>((resolve) => harness.on("exit", resolve))
  let complete = false
  try {
    const host = await poll(
      async () => {
        if (harness.exitCode !== null) throw new Error(`The harness stopped before serving:\n${logs}`)
        return existsSync(join(dir, "host.json"))
          ? JSON.parse(readFileSync(join(dir, "host.json"), "utf8")) as Host
          : undefined
      },
      "the installed composition",
      900_000
    )
    const inspect = async <T>(path: string): Promise<T> => {
      const response = await fetch(host.inspector + path)
      if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
      return await response.json() as T
    }
    const merges = async () =>
      (await inspect<Array<Write>>("/github")).filter((write) =>
        write.method === "PUT" && write.path.endsWith("/merge")
      )
    const lastMove = async () =>
      (await inspect<Array<{ data: Record<string, unknown> }>>("/events?type=todo.moved")).at(-1)?.data

    const tools = mkdtempSync(join(dir, "browser-"))
    const browser = join(tools, "consent.mjs")
    writeFileSync(browser, consent)
    chmodSync(browser, 0o700)
    const ambient = Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        key !== "CLAUDECODE" && !key.startsWith("CODEX_") && !key.startsWith("SMITHERS_") && key !== "GITHUB_TOKEN" &&
        key !== "GH_TOKEN"
      )
    )
    const laptop = (name: string, code: string) => {
      const home = mkdtempSync(join(dir, `${name}-`))
      return {
        home,
        cli: async (step: string, args: Array<string>, agent: Record<string, string> = {}) => {
          const result = await runProcess(process.execPath, [bin, ...args, "--format", "json"], {
            ...ambient,
            ...agent,
            HOME: home,
            XDG_CONFIG_HOME: home,
            XDG_DATA_HOME: home,
            SMITHERS_AUTH_FILE: join(home, "auth.json"),
            SMITHERS_DISABLE_SYSTEM_KEYRING: "1",
            SMITHERS_API_ORIGIN: host.origin,
            BROWSER: browser,
            DELEGATED_LOGIN_CODE: code
          })
          record(`${step}.cli.json`, { argv: ["smthrs", ...args], agent, ...result })
          return result
        },
        credential: () => JSON.parse(readFileSync(join(home, "auth.json"), "utf8")) as Record<string, unknown>
      }
    }
    const tokenRow = async (token: string) => {
      const digest = createHash("sha256").update(token).digest("hex")
      const rows = await inspect<Array<Record<string, unknown>>>(`/token?digest=${digest}`)
      expect(rows).toHaveLength(1)
      return rows[0]!
    }
    const scopes = (row: Record<string, unknown>) => String(row.scopes).split(/[\s,]+/).filter(Boolean)

    // Step 1: the laptop line Settings shows, consented as B in a browser.
    const claude = laptop("claude-code", host.codes[0]!)
    const login = await claude.cli("1-login-agent", ["login", host.origin, "--agent", "claude-code"], {
      CLAUDECODE: "1"
    })
    expect(login.code, login.stderr).toBe(0)
    expect(JSON.parse(login.stdout)).toMatchObject({ status: "logged_in", user: host.member })
    const saved = claude.credential()
    expect(saved).toMatchObject({ kind: "delegated", via: "claude-code" })
    const token = String(saved.token)
    expect(token).not.toBe("")
    expect(login.stdout + login.stderr).not.toContain(token)

    // Step 2: the server row derives its kind from issuer-bound scopes.
    const row = await tokenRow(token)
    record("2-access-token.json", row)
    expect(row).toMatchObject({ username: host.member, system_issued: true })
    expect(scopes(row)).toContain("via:claude-code")
    expect(scopes(row).filter((scope) => scope.includes("approval"))).toEqual([])
    const status = await claude.cli("2-auth-status", ["auth", "status"], { CLAUDECODE: "1" })
    expect(status.code, status.stderr).toBe(0)
    expect(JSON.parse(status.stdout)).toMatchObject({
      logged_in: true,
      username: host.member,
      credential_kind: "delegated",
      via: "claude-code"
    })

    // Step 3: a write that runs at once is attributed "Claude Code for B".
    const moved = await claude.cli("3-move-claude-code", ["stack", "move", `T${host.t3}`, "up"], {
      CLAUDECODE: "1"
    })
    expect(moved.code, moved.stderr).toBe(0)
    expect(JSON.parse(moved.stdout)).toMatchObject({ state: "accepted" })
    expect(await lastMove()).toMatchObject({
      n: host.t3,
      direction: "up",
      by: { person: host.member, via: "claude-code" }
    })
    const audit = await inspect<
      Array<{ actor_name: string; action: string; target_name: string; metadata: Record<string, unknown> }>
    >(
      `/audit?token=${String(row.id)}`
    )
    expect(audit.find((entry) => entry.action === "POST" && entry.target_name === `/api/todos/${host.t3}`))
      .toMatchObject({
        actor_name: host.member,
        metadata: { kind: "delegated", via: "claude-code", stored_via: "claude-code" }
      })

    // A Codex environment makes the CLI send Smithers-Via: codex. The
    // claude-code credential's stored via stands.
    const forged = await claude.cli("3-move-forged-codex", ["stack", "move", `T${host.t3}`, "down"], {
      CODEX_HOME: join(claude.home, "codex")
    })
    expect(forged.code, forged.stderr).toBe(0)
    expect(await lastMove()).toMatchObject({
      n: host.t3,
      direction: "down",
      by: { person: host.member, via: "claude-code" }
    })
    const forgedAudit = (await inspect<typeof audit>(`/audit?token=${String(row.id)}`)).filter((entry) =>
      entry.action === "POST" && entry.target_name === `/api/todos/${host.t3}`
    )
    expect(forgedAudit).toHaveLength(2)
    expect(forgedAudit.map((entry) => entry.metadata.via)).toEqual(["claude-code", "claude-code"])

    // Step 7: a plain login with no agent and no agent environment is via cli.
    const plain = laptop("plain", host.codes[1]!)
    const plainLogin = await plain.cli("7-login-plain", ["login", host.origin])
    expect(plainLogin.code, plainLogin.stderr).toBe(0)
    const plainSaved = plain.credential()
    expect(plainSaved).toMatchObject({ kind: "delegated", via: "cli" })
    const plainRow = await tokenRow(String(plainSaved.token))
    record("7-access-token.json", plainRow)
    expect(plainRow).toMatchObject({ username: host.member, system_issued: true })
    expect(scopes(plainRow)).toContain("via:cli")
    expect(scopes(plainRow).filter((scope) => scope.includes("approval"))).toEqual([])
    const plainMove = await plain.cli("7-move-plain", ["stack", "move", `T${host.t3}`, "up"])
    expect(plainMove.code, plainMove.stderr).toBe(0)
    expect(await lastMove()).toMatchObject({ n: host.t3, direction: "up", by: { person: host.member, via: "cli" } })

    // Step 4: Merge from the agent opens a confirmation and merges nothing.
    const merge = await claude.cli("4-merge", ["merge", `T${host.t1}`, "--reviewed_head_sha", host.head], {
      CLAUDECODE: "1"
    })
    expect(merge.code, merge.stderr).toBe(3)
    const receipt = JSON.parse(merge.stdout) as Record<string, string>
    expect(Object.keys(receipt).sort()).toEqual(["confirmation", "message", "state"])
    expect(receipt.state).toBe("pending")
    expect(receipt.confirmation).toMatch(/\S/)
    expect(receipt.message).toMatch(/^Waiting for .+ to confirm$/)
    expect(merge.stdout + merge.stderr).not.toMatch(/merged/i)
    expect(await merges()).toEqual([])

    const agent = (method: string, path: string, key: string, body: unknown = {}) =>
      fetch(host.origin + path, {
        method,
        headers: {
          authorization: `token ${token}`,
          "content-type": "application/json",
          "idempotency-key": key,
          "smithers-via": "claude-code"
        },
        body: JSON.stringify(body)
      })
    // Step 5: the same request sent without the CLI is still only a request.
    const direct = await agent("POST", `/api/todos/${host.t1}/merge`, "c-j6-02-direct-merge", {
      reviewed_head_sha: host.head
    })
    const directBody = await direct.json() as Record<string, string>
    record("5-direct-merge.json", { status: direct.status, body: directBody })
    expect(direct.status).toBe(202)
    expect(Object.keys(directBody).sort()).toEqual(["confirmation", "state"])
    expect(directBody.state).toBe("pending")
    expect(await merges()).toEqual([])

    // Step 6: the CLI's token cannot answer it; B's browser session can.
    const denied = await agent("POST", `/api/confirmations/${receipt.confirmation}/approve`, "c-j6-02-agent-press")
    const deniedBody = await denied.json() as Record<string, string>
    record("6-agent-approve.json", { status: denied.status, body: deniedBody })
    expect(denied.status).toBe(403)
    expect(deniedBody.class).toBe("permission")
    // Nothing merges on the agent's request alone, however long it waits.
    const quiet = Date.now() + 5_000
    while (Date.now() < quiet) {
      expect(await merges()).toEqual([])
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const waiting = await inspect<Array<{ id: string; state: string }>>("/approvals")
    expect(waiting.find((approval) => approval.id === receipt.confirmation)?.state).toBe("pending")
    const cookie = Object.entries(host.cookies).map(([name, value]) => `${name}=${value}`).join("; ")
    const press = await fetch(`${host.origin}/api/confirmations/${receipt.confirmation}/approve`, {
      method: "POST",
      headers: {
        cookie,
        "x-csrf-token": host.cookies.__csrf ?? "",
        origin: host.origin,
        "content-type": "application/json",
        "idempotency-key": "c-j6-02-person-press"
      },
      body: "{}"
    })
    const pressBody = await press.json() as Record<string, string>
    record("6-person-approve.json", { status: press.status, body: pressBody })
    expect(press.status, JSON.stringify(pressBody)).toBe(202)
    const sent = await poll(async () => {
      const found = await merges()
      return found.length > 0 ? found : undefined
    }, "GitHub's merge call")
    // B's own confirmations list settles the card once main holds the merge.
    await poll(
      async () => {
        const response = await fetch(`${host.origin}/api/confirmations`, { headers: { cookie } })
        const rows = await response.json() as Array<{ id: string; state: string }>
        return rows.find((row) => row.id === receipt.confirmation)?.state === "approved" ? rows : undefined
      },
      "B's approved confirmation",
      240_000
    )
    const approvals = await inspect<Array<{ id: string; member: string; command: string; state: string }>>("/approvals")
    record("approvals.json", approvals)
    expect(
      approvals.filter((approval) => approval.command === "merge").every((approval) => approval.member === host.member)
    )
      .toBe(true)
    // Any later merge call would arrive while the confirmation settles.
    const calls = await inspect<Array<Write>>("/github")
    record("github-calls.json", calls)
    expect(sent).toHaveLength(1)
    expect(calls.filter((write) => write.method === "PUT" && write.path.endsWith("/merge"))).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      path: `/repos/rehearsal-owner/app/pulls/${host.pull}/merge`,
      status: 200,
      body: { sha: host.head, merge_method: "squash" }
    })
    record("todo-moved-events.json", await inspect("/events?type=todo.moved"))
    record("audit-claude-code.json", await inspect(`/audit?token=${String(row.id)}`))
    record("audit-cli.json", await inspect(`/audit?token=${String(plainRow.id)}`))
    complete = true
  } finally {
    writeFileSync(join(dir, "done"), "done")
    const timer = setTimeout(() => harness.kill("SIGKILL"), 60_000)
    const code = await exited
    clearTimeout(timer)
    record("harness.log", logs)
    rmSync(dir, { recursive: true, force: true })
    if (complete) expect(code, logs).toBe(0)
  }
}, 1_200_000)
