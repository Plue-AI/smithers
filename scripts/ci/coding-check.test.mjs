import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"

const script = resolve(import.meta.dirname, "coding-check.sh")
const fixture = (mode, args = ["//flows:codingNative"], env = {}) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coding-bootstrap-")))
  writeFileSync(join(root, "bun"), `#!/bin/sh
echo "$*" >> "$FIXTURE/install.log"
echo "$BUN_INSTALL_CACHE_DIR" >> "$FIXTURE/cache.log"
case "$MODE" in
  fail) exit 23 ;;
  stall) exec sleep 30 ;;
  retry) if [ ! -f "$FIXTURE/retried" ]; then touch "$FIXTURE/retried"; exec sleep 30; fi ;;
esac
`, { mode: 0o755 })
  writeFileSync(join(root, "node"), `#!/bin/sh
echo "$*" >> "$FIXTURE/node.log"
case "$MODE:$1" in
  testfail:packages/*) exit 7 ;;
esac
`, { mode: 0o755 })
  const result = spawnSync("sh", [script, ...args], {
    cwd: root, encoding: "utf8", timeout: 15_000,
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, FIXTURE: root, MODE: mode,
      SMITHERS_CHECK_INSTALL_TIMEOUT: "1s", BUN_INSTALL_CACHE_DIR: join(tmpdir(), "persistent-bun-cache"),
      SMITHERS_CHECK_CACHE_DIR: join(root, "check-cache"), ...env }
  })
  const attempts = existsSync(join(root, "install.log")) ? readFileSync(join(root, "install.log"), "utf8").trim().split("\n") : []
  const calls = existsSync(join(root, "node.log")) ? readFileSync(join(root, "node.log"), "utf8").trim().split("\n") : []
  const checked = calls.find(call => call.startsWith("packages/")) ?? null
  const caches = existsSync(join(root, "cache.log")) ? readFileSync(join(root, "cache.log"), "utf8").trim().split("\n") : []
  rmSync(root, { recursive: true, force: true })
  assert.equal(result.error, undefined)
  assert.ok(attempts.every(args => args === "install --frozen-lockfile"))
  assert.ok(caches.every(cache => cache === join(root, "check-cache", "bun")),
    "every install, including retries, must use the dedicated check cache instead of an inherited persistent cache")
  return { result, attempts, checked, calls }
}

test("a stalled install is terminated and retried before the requested check", () => {
  const { result, attempts, checked } = fixture("retry")
  assert.equal(result.status, 0)
  assert.equal(attempts.length, 2)
  assert.match(result.stderr, /timed out; retrying once/)
  assert.equal(checked, "packages/smithers/build/build-cli/src/main.js test //flows:codingNative")
})

test("a second stalled install fails without running checks", () => {
  const { result, attempts, checked } = fixture("stall")
  assert.equal(result.status, 124)
  assert.equal(attempts.length, 2)
  assert.equal(checked, null)
})

test("ordinary install failures retain their status without retry or checks", () => {
  const { result, attempts, checked } = fixture("fail")
  assert.equal(result.status, 23)
  assert.equal(attempts.length, 1)
  assert.equal(checked, null)
})

test("target results are seeded before the check and saved after it, even when it fails", () => {
  for (const [mode, status] of [["ok", 0], ["testfail", 7]]) {
    const { result, calls } = fixture(mode)
    assert.equal(result.status, status)
    assert.deepEqual(calls, ["scripts/ci/check-cache.mjs seed .",
      "packages/smithers/build/build-cli/src/main.js test //flows:codingNative", "scripts/ci/check-cache.mjs save ."])
  }
})

test("terminating the wrapper stops the running check", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coding-cancel-")))
  try {
    writeFileSync(join(root, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    writeFileSync(join(root, "node"), `#!/bin/sh
case "$1" in
  packages/*) echo $$ > "${root}/check.pid"; exec sleep 30 ;;
esac
`, { mode: 0o755 })
    const child = spawn("sh", [script, "//flows:codingNative"], { cwd: root, stdio: "ignore",
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, SMITHERS_CHECK_CACHE_DIR: join(root, "check-cache") } })
    const pidFile = join(root, "check.pid")
    for (let attempt = 0; attempt < 100 && !existsSync(pidFile); attempt++) await new Promise(done => setTimeout(done, 50))
    const pid = Number(readFileSync(pidFile, "utf8"))
    const exited = new Promise(done => child.on("exit", (code, signal) => done({ code, signal })))
    child.kill("SIGTERM")
    assert.deepEqual(await exited, { code: 143, signal: null })
    assert.throws(() => process.kill(pid, 0), /ESRCH/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an affected check passes each written path as one literal argument, judged by the known-red list", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "coding-affected-")))
  try {
    writeFileSync(join(root, "bun"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    writeFileSync(join(root, "node"), `#!/bin/sh
case "$1" in packages/*) printf '%s\\n' "$@" > "$FIXTURE/argv.log" ;; esac
`, { mode: 0o755 })
    // Files that a glob would match: a written path must never expand to them.
    writeFileSync(join(root, "i.tsx"), "")
    writeFileSync(join(root, "d.tsx"), "")
    const result = spawnSync("sh", [script, "affected", "lint", "//..."], {
      cwd: root, encoding: "utf8", timeout: 15_000,
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, FIXTURE: root,
        SMITHERS_CHECK_CACHE_DIR: join(root, "check-cache"),
        SMITHERS_CHECK_FILES: "flows/coding/todo.ts\ndocs/a file.md\n[id].tsx\n*.tsx" }
    })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(readFileSync(join(root, "argv.log"), "utf8").trim().split("\n"), [
      "packages/smithers/build/build-cli/src/main.js", "affected", "lint", "//...",
      "--known-red", ".github/ci-known-red.json",
      "--files", "flows/coding/todo.ts", "--files", "docs/a file.md", "--files", "[id].tsx", "--files", "*.tsx"
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an affected check of a Change that wrote nothing passes without installing or running anything", () => {
  const { result, attempts, calls } = fixture("ok", ["affected", "test", "//..."], { SMITHERS_CHECK_FILES: "" })
  assert.equal(result.status, 0)
  assert.match(result.stderr, /wrote no files/)
  assert.deepEqual(attempts, [])
  assert.deepEqual(calls, [])
})

test("an affected check without its check host's written paths refuses instead of passing", () => {
  const { result, attempts, calls } = fixture("ok", ["affected", "test", "//..."])
  assert.equal(result.status, 2)
  assert.match(result.stderr, /needs SMITHERS_CHECK_FILES/)
  assert.deepEqual(attempts, [])
  assert.deepEqual(calls, [])
})
