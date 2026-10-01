import assert from "node:assert/strict"
import { execFile, execFileSync, spawn } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, it } from "node:test"
import { promisify } from "node:util"

import { proxyUrl } from "./github-proxy.mjs"

const script = new URL("./github-proxy.mjs", import.meta.url).pathname
const hasGh = (() => { try { execFileSync("gh", ["--version"], { stdio: "ignore" }); return true } catch { return false } })()

const freePort = async () => {
  const probe = createServer()
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve))
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

/** A fake GitHub that records the Authorization each request carried. */
const fakeGitHub = async () => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization })
    res.writeHead(200, { "content-type": "application/json" })
    res.end("{\"ok\":true}")
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }) }
}

const waitHealthy = async (base) => {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/_smithers/health`)).ok) return } catch { /* not yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`no proxy at ${base}`)
}

const serve = (env) => {
  const child = spawn(process.execPath, [script], { env: { ...process.env, ISSUE_CLAIM_APP_CONFIG: "/nonexistent.json", ...env }, stdio: ["ignore", "ignore", "pipe"] })
  let stderr = ""
  child.stderr.on("data", (chunk) => { stderr += chunk })
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve({ code, stderr })))
  return { child, exited }
}

describe("the GitHub proxy daemon", () => {
  it("defaults to loopback port 47821 and trims a trailing slash", () => {
    assert.equal(proxyUrl({}), "http://127.0.0.1:47821")
    assert.equal(proxyUrl({ SMITHERS_GITHUB_PROXY: "http://127.0.0.1:9/" }), "http://127.0.0.1:9")
  })

  it("--ensure starts one proxy in the background and finds it the next time", async () => {
    const port = await freePort()
    const dir = mkdtempSync(join(tmpdir(), "github-proxy-"))
    const env = { ...process.env, SMITHERS_GITHUB_PROXY: `http://127.0.0.1:${port}`, SMITHERS_GITHUB_PROXY_LOG: join(dir, "logs", "proxy.log"),
      SMITHERS_GITHUB_TOKEN: "t", ISSUE_CLAIM_APP_CONFIG: "/nonexistent.json" }
    const ensure = () => JSON.parse(execFileSync(process.execPath, [script, "--ensure"], { env, encoding: "utf8" }))
    try {
      assert.deepEqual(ensure(), { proxy: `http://127.0.0.1:${port}`, started: true })
      assert.deepEqual(ensure(), { proxy: `http://127.0.0.1:${port}`, started: false })
      assert.match(readFileSync(join(dir, "logs", "proxy.log"), "utf8"), /listening on http:\/\/127\.0\.0\.1/)
    } finally {
      const pid = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).trim()
      if (pid) process.kill(Number(pid))
    }
  })

  it("--ensure reports a proxy that never answers", () => {
    const env = { ...process.env, SMITHERS_GITHUB_PROXY: "http://0.0.0.0:1", SMITHERS_GITHUB_PROXY_LOG: join(mkdtempSync(join(tmpdir(), "github-proxy-")), "log") }
    let failure
    try { execFileSync(process.execPath, [script, "--ensure"], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }) } catch (error) { failure = error }
    assert.equal(failure?.status, 1)
    assert.match(failure.stderr, /did not answer/)
  })

  it("refuses to listen beyond loopback without a capability", async () => {
    const { code, stderr } = await serve({ SMITHERS_GITHUB_PROXY: `http://0.0.0.0:${await freePort()}` }).exited
    assert.equal(code, 1)
    assert.match(stderr, /SMITHERS_GITHUB_PROXY_CAPABILITY_FILE/)
  })

  it("refuses to start without any credential, so a sandboxed caller cannot hold the port", async () => {
    // No App, no token variables, and no `gh` on PATH.
    const { code, stderr } = await serve({ PATH: dirname(process.execPath), SMITHERS_GITHUB_TOKEN: "", GITHUB_TOKEN: "",
      SMITHERS_GITHUB_PROXY: `http://127.0.0.1:${await freePort()}` }).exited
    assert.equal(code, 1)
    assert.match(stderr, /no GitHub credential/)
  })

  it("lets gh through only with the capability, sent as GH_ENTERPRISE_TOKEN", { skip: hasGh ? false : "gh is not installed" }, async () => {
    const github = await fakeGitHub()
    const dir = mkdtempSync(join(tmpdir(), "github-proxy-"))
    writeFileSync(join(dir, "capability"), "cap-for-tests\n", { mode: 0o600 })
    const base = `http://127.0.0.1:${await freePort()}`
    const { child } = serve({ SMITHERS_GITHUB_PROXY: base, SMITHERS_GITHUB_PROXY_UPSTREAM: github.origin, SMITHERS_GITHUB_TOKEN: "ghp_operator",
      SMITHERS_GITHUB_PROXY_CAPABILITY_FILE: join(dir, "capability") })
    // Asynchronous, so the fake GitHub in this process can answer while gh runs.
    const gh = async (token) => {
      const env = { ...process.env, GH_CONFIG_DIR: join(dir, "gh"), GH_ENTERPRISE_TOKEN: token }
      delete env.GH_TOKEN
      delete env.GITHUB_TOKEN
      try { return { code: 0, out: (await promisify(execFile)("gh", ["api", `${base}/repos/o/r`], { env, encoding: "utf8" })).stdout } }
      catch (error) { return { code: error.code, out: error.stderr } }
    }
    try {
      await waitHealthy(base)
      assert.match((await gh("wrong")).out, /HTTP 401/)
      assert.equal(github.seen.length, 0)
      assert.deepEqual(await gh("cap-for-tests"), { code: 0, out: "{\"ok\":true}" })
      assert.deepEqual(github.seen, [{ url: "/repos/o/r", auth: "Bearer ghp_operator" }])
    } finally {
      child.kill()
      await github.close()
    }
  })
})
