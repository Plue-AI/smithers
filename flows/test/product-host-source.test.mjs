import assert from "node:assert/strict"
import { test } from "node:test"
import { createServer } from "node:net"
import { execFileSync, spawn } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildProductHost } from "../librarian/build.mjs"

const command = (root, binary, ...args) => execFileSync(binary, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

test("bundled product host verifies its actual catalog source before readiness and pins it for its lifetime", { timeout: 120_000 }, async t => {
  const fixture = await mkdtemp(join(tmpdir(), "flow-host-source-"))
  t.after(() => rm(fixture, { recursive: true, force: true }))
  const artifact = join(fixture, "host.mjs")
  const digest = await buildProductHost(artifact)
  const root = join(fixture, "repo"), state = join(fixture, "state")
  await mkdir(root)
  command(root, "git", "init", "-b", "main")
  command(root, "git", "-c", "user.name=Source Test", "-c", "user.email=source@example.invalid", "commit", "--allow-empty", "-m", "initial")
  const revision = command(root, "git", "rev-parse", "HEAD")
  let child, logs = "", exited
  const stop = async () => {
    if (child?.exitCode === null && child?.signalCode === null) child.kill("SIGTERM")
    if (exited) await exited
  }
  t.after(stop)
  const start = async (source, workspace = root) => {
    await stop()
    const listener = createServer()
    await new Promise(resolve => listener.listen(0, "127.0.0.1", resolve))
    const port = listener.address().port
    await new Promise(resolve => listener.close(resolve))
    logs = ""
    child = spawn(process.execPath, [artifact, "serve", "--root", workspace, "--state-dir", state, "--port", String(port)], {
      cwd: workspace,
      env: { ...process.env, SMITHERS_API_KEY: "source-test", SMITHERS_GATEWAY_ID: "11111111-1111-4111-8111-111111111111",
        SMITHERS_OWNER_GENERATION: "1", SMITHERS_SOURCE_REVISION: source, SMITHERS_FLOW_ARTIFACT_SHA256: digest,
        SMITHERS_REPO: "fixture/source" },
      stdio: ["ignore", "pipe", "pipe"]
    })
    exited = new Promise((resolve, reject) => { child.once("exit", code => resolve(code)); child.once("error", reject) })
    child.stdout.on("data", data => { logs += data }); child.stderr.on("data", data => { logs += data })
    return `http://127.0.0.1:${port}`
  }
  const refuse = async source => {
    const base = await start(source)
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        assert.notEqual(await exited, 0, logs)
        assert.match(logs, /Flow host source revision (?:is unavailable|does not match)/)
        return
      }
      assert.equal(await fetch(`${base}/health`, { signal: AbortSignal.timeout(150) }).then(r => r.ok).catch(() => false), false, "unverified host advertised readiness")
      await pause(50)
    }
    assert.fail(`unverified host did not refuse startup: ${logs}`)
  }
  await refuse("0".repeat(40)) // A valid-looking build SHA cannot stand in for this repository.
  await writeFile(join(root, "untracked.txt"), "dirty\n")
  await refuse(revision)
  await rm(join(root, "untracked.txt"))
  const base = await start(revision)
  let health
  for (let i = 0; i < 200; i++) {
    if (child.exitCode !== null) assert.fail(logs)
    health = await fetch(`${base}/health`, { signal: AbortSignal.timeout(150) }).then(r => r.ok ? r.json() : undefined).catch(() => undefined)
    if (health) break
    await pause(50)
  }
  assert.equal(health?.runtimeBridge?.sourceRevision, revision, logs)
  await writeFile(join(root, "untracked.txt"), "after catalog load\n")
  assert.equal((await fetch(`${base}/health`).then(r => r.json())).runtimeBridge.sourceRevision, revision, "running catalog stays pinned")
  await refuse(revision) // Restart must capture the real source again.
  await stop()
  await rm(join(root, "untracked.txt"))
  let jjAvailable = true
  try { command(root, "jj", "--version") } catch { jjAvailable = false }
  await t.test("JJ working-copy snapshots are verified by the same bundled host", { skip: !jjAvailable }, async () => {
    command(root, "jj", "git", "init", "--colocate", ".")
    const snapshot = command(root, "jj", "log", "-r", "@", "--no-graph", "--color=never", "-T", "commit_id")
    const jjBase = await start(snapshot)
    let ready
    for (let i = 0; i < 200; i++) {
      if (child.exitCode !== null) assert.fail(logs)
      ready = await fetch(`${jjBase}/health`, { signal: AbortSignal.timeout(150) }).then(r => r.ok ? r.json() : undefined).catch(() => undefined)
      if (ready) break
      await pause(50)
    }
    assert.equal(ready?.runtimeBridge?.sourceRevision, snapshot, logs)
    await stop()
    await writeFile(join(root, "new-jj-source.txt"), "another immutable working-copy snapshot\n")
    await refuse(snapshot)
    await stop()
    await rm(join(root, ".jj"), { recursive: true, force: true })
  })
  await rm(join(root, ".git"), { recursive: true, force: true })
  await refuse(revision)
})
