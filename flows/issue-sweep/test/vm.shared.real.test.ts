/** Opt-in real k=3 evidence; never runs in the ordinary suite or during host burndown. */
import { Deferred, Effect, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { freemem, loadavg, tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { make } from "../vm.ts"
import { adoptWork } from "../work/flow.ts"
import { fixRemotely } from "./remote-capture.ts"

test("three agents on one real VM capture and apply independent edits", {
  skip: process.env.ISSUE_SWEEP_SHARED_VM_REAL !== "1"
    ? "set ISSUE_SWEEP_SHARED_VM_REAL=1 explicitly on an idle host"
    : false,
  timeout: 20 * 60_000
}, async (t) => {
  const load = loadavg()
  const threshold = Number(process.env.ISSUE_SWEEP_SHARED_VM_MAX_LOAD ?? 16)
  t.diagnostic(JSON.stringify({ at: new Date().toISOString(), load, freeBytes: freemem(), maxLoad: threshold }))
  assert.ok(Number.isFinite(threshold) && threshold > 0, "the load threshold must be positive")
  const currentLoad = load[0]
  assert.ok(currentLoad !== undefined, "the host must report its current load")
  if (currentLoad > threshold) {
    t.skip(`host load ${currentLoad} exceeds ${threshold}`)
    return
  }
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-shared-vm-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = join(root, "jj.toml")
  writeFileSync(config, "[user]\nname = \"t\"\nemail = \"t@t\"\n")
  const priorConfig = process.env.JJ_CONFIG
  process.env.JJ_CONFIG = config
  t.after(() => {
    if (priorConfig === undefined) delete process.env.JJ_CONFIG
    else process.env.JJ_CONFIG = priorConfig
  })
  const host = join(root, "host")
  await new Promise<void>((resolve, reject) => {
    const child = spawn("jj", [
      "git",
      "clone",
      "--colocate",
      "--depth",
      "1",
      "--branch",
      "main",
      "--quiet",
      "https://github.com/smithersai/smithers.git",
      host
    ], { stdio: "inherit", env: process.env })
    child.on("error", reject)
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`jj clone exited ${code}`)))
  })
  const provider = make({ agentsPerVm: 3, maxVms: 1 })
  const barrier = await Effect.runPromise(Deferred.make<void>())
  let arrived = 0
  const homes = new Set<string>()
  const workdirs = new Set<string>()
  const identities = new Set<string>()
  const tracked = {
    acquire: (key: string) =>
      provider.acquire(key).pipe(Effect.tap((session) =>
        Effect.sync(() => {
          identities.add(session.remoteId)
          workdirs.add(session.workdir)
        })
      ))
  }
  const remotes = await Effect.runPromise(Effect.forEach([0, 1, 2], (index) =>
    fixRemotely(
      tracked,
      `real-shared-${process.pid}-${index}`,
      Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const run = (line: string) =>
          Effect.scoped(Effect.flatMap(
            spawner.spawn(ChildProcess.make("sh", ["-c", line])),
            (handle) => Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode])
          ))
        const [home, code] = yield* run("printf \"%s\" \"$HOME\"")
        assert.equal(code, 0)
        homes.add(home)
        const [, wrote] = yield* run(`printf 'agent ${index}\\n' > shared-vm-agent-${index}.txt`)
        assert.equal(wrote, 0)
        if (++arrived === 3) yield* Deferred.succeed(barrier, undefined)
        yield* Deferred.await(barrier)
        const [seen, listed] = yield* run("ls shared-vm-agent-*.txt")
        assert.equal(listed, 0)
        assert.equal(seen.trim(), `shared-vm-agent-${index}.txt`, "sibling files never enter this checkout")
        return { agent: "codex" as const, account: "test", report: `agent ${index}` }
      }).pipe(Effect.orDie)
    ), { concurrency: "unbounded" }))
  assert.equal(identities.size, 1)
  assert.equal(workdirs.size, 3)
  assert.equal(homes.size, 3)
  for (const [index, remote] of remotes.entries()) {
    assert.equal(remote.work._tag, "Changed")
    if (remote.work._tag === "Changed") {
      assert.match(remote.work.patch, new RegExp(`shared-vm-agent-${index}\\.txt`))
      for (const other of [0, 1, 2].filter((n) => n !== index)) {
        assert.doesNotMatch(remote.work.patch, new RegExp(`shared-vm-agent-${other}\\.txt`))
      }
    }
    const report = await Effect.runPromise(adoptWork(
      { repo: "o/r", issue: index, title: `agent ${index}`, remote },
      { repository: host, directory: join(root, `issue-${index}`), name: `shared-${index}` }
    ))
    const content = execFileSync("jj", [
      "-R",
      host,
      "--ignore-working-copy",
      "file",
      "show",
      "-r",
      report.change,
      `root:shared-vm-agent-${index}.txt`
    ], { encoding: "utf8", env: process.env })
    assert.equal(content, `agent ${index}\n`)
  }
})
