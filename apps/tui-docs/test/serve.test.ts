import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
test("static responses carry a CSP and an unreadable file does not crash the server", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "tui-docs-serve-")), dist = join(dir, "dist")
  mkdirSync(dist)
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>ok</title>")
  writeFileSync(join(dist, "locked.txt"), "secret")
  chmodSync(join(dist, "locked.txt"), 0)
  const child = fork(fileURLToPath(new URL("../server/serve.mjs", import.meta.url)), [], {
    env: { PATH: process.env.PATH, PORT: "0", DOCS_DIST: dist, DOCS_BUDGET_DB: join(dir, "budget.sqlite") },
    stdio: ["ignore", "ignore", "pipe", "ipc"]
  })
  t.after(() => {
    child.kill()
    chmodSync(join(dist, "locked.txt"), 0o600)
    rmSync(dir, { recursive: true, force: true })
  })
  const { origin } = await new Promise<{ origin: string }>((resolve, reject) => {
    child.once("message", resolve)
    child.once("exit", (code) => reject(new Error(`server exited ${code}`)))
  })
  const page = await fetch(`${origin}/`)
  assert.equal(page.status, 200)
  const csp = page.headers.get("content-security-policy") ?? ""
  assert.match(csp, /frame-ancestors 'none'/)
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'(;|$)/)
  await page.text()
  await fetch(`${origin}/locked.txt`).then((response) => response.text()).catch(() => undefined)
  assert.equal(child.exitCode, null)
  assert.equal((await fetch(`${origin}/`)).status, 200)
})
