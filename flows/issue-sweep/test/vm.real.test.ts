/**
 * The agent microVM against real Microsandbox on this host. Skipped, with the
 * reason, when `msb` or the issue-sweep snapshot is missing.
 *   node --test flows/issue-sweep/test/vm.real.test.ts
 */
import { type MicrosandboxSandbox, Sandbox } from "@smthrs/sandbox"
import { Deferred, Effect, Exit, Fiber, FileSystem, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as Microsandbox from "microsandbox"
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { guestCheckout, guestHome, latestImage, make, reapOrphans, sh } from "../vm.ts"
import { adoptWork, fixRemotely } from "../work/flow.ts"

const sdk = Microsandbox as unknown as MicrosandboxSandbox.Sdk
const missing = spawnSync("msb", ["--version"]).status !== 0
  ? "msb is not on PATH"
  : Exit.isFailure(await Effect.runPromiseExit(latestImage(sdk)))
  ? "no issue-sweep snapshot; build one with node flows/issue-sweep/test/vm-image.ts"
  : undefined

const gone = async (name: string): Promise<boolean> => {
  try {
    await sdk.Sandbox.get(name)
    return false
  } catch (cause) {
    return (cause as { code?: string }).code === "sandboxNotFound"
  }
}

const until = async (check: () => Promise<boolean>, ms: number) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (await check()) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return check()
}

test(
  "a session is a refreshed Smithers checkout with the agent toolchain, removed on close",
  { skip: missing },
  async () => {
    const { name, out } = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const session = yield* make().acquire(`real-${process.pid}-a`)
      const out = yield* sh(
        session,
        "jj log -r @- --no-graph -T commit_id; echo; jj log -r main@origin --no-graph -T commit_id; echo; " +
          "pwd; for t in git jj node pnpm gh codex claude; do command -v $t >/dev/null || echo missing-$t; done"
      )
      return { name: session.remoteId, out }
    })))
    const [parent, main, cwd, ...rest] = out.stdout.trim().split("\n")
    assert.equal(out.code, 0, out.stderr)
    assert.equal(parent, main, "the working copy sits on the fetched main")
    assert.equal(cwd, guestCheckout)
    assert.deepEqual(rest, [], "every agent tool is on PATH")
    assert.equal(await gone(name), true)
  }
)

test("interrupting a running command removes the microVM", { skip: missing }, async () => {
  const ready = await Effect.runPromise(Deferred.make<string>())
  const fiber = Effect.runFork(Effect.scoped(Effect.gen(function*() {
    const session = yield* make({ refresh: false }).acquire(`real-${process.pid}-b`)
    yield* Deferred.succeed(ready, session.remoteId)
    return yield* sh(session, "sleep 1000")
  })))
  const name = await Effect.runPromise(Deferred.await(ready))
  assert.equal(await gone(name), false)
  await Effect.runPromise(Fiber.interrupt(fiber))
  assert.equal(await gone(name), true)
})

test("a host process killed with SIGKILL takes its microVM with it, and reapOrphans finds nothing left", {
  skip: missing
}, async () => {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("vm-hold.ts", import.meta.url)),
    `real-${process.pid}-c`
  ])
  const name = await new Promise<string>((resolve, reject) => {
    child.stdout.on("data", (data: Buffer) => {
      const found = /ready (\S+)/.exec(String(data))
      if (found) resolve(found[1]!)
    })
    child.on("exit", (code) => reject(new Error(`holder exited ${code}`)))
  })
  assert.equal(await gone(name), false)
  child.kill("SIGKILL")
  assert.equal(await until(() => gone(name), 15_000), true)
  const reaped = await Effect.runPromise(reapOrphans(sdk))
  assert.equal(reaped.some((machine) => machine.name === name), false)
})

test("under Sandbox.layerHost the work flow's FileSystem and spawner reach the guest, as with CloudSandbox", {
  skip: missing
}, async () => {
  const layer = Sandbox.layerHost(make(), { session: `real-${process.pid}-d` })
  const result = await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(`${guestHome}/.codex-sweep`, { recursive: true })
      yield* fs.writeFileString(`${guestHome}/.codex-sweep/auth.json`, "{}")
      const spawner = yield* ChildProcessSpawner
      const run = (command: string, args: ReadonlyArray<string>) =>
        Effect.scoped(
          Effect.flatMap(spawner.spawn(ChildProcess.make(command, args)), (handle) =>
            Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode]))
        )
      const [start] = yield* run("jj", ["-R", guestCheckout, "log", "-r", "@", "--no-graph", "-T", "commit_id"])
      const [, wrote] = yield* run("sh", [
        "-c",
        `cd ${guestCheckout} && echo "$1" >> README.md`,
        "sh",
        "a line with 'quotes' and $dollars"
      ])
      const [stat] = yield* run("jj", ["-R", guestCheckout, "diff", "--stat", "--from", start.trim(), "--to", "@"])
      const login = yield* fs.readFileString(`${guestHome}/.codex-sweep/auth.json`)
      return { start: start.trim(), wrote, stat, login }
    }).pipe(Effect.provide(layer))
  )
  assert.match(result.start, /^[0-9a-f]{40}$/)
  assert.equal(result.wrote, 0)
  assert.match(result.stat, /README\.md/)
  assert.equal(result.login, "{}")
})

test("a microVM's edit comes back as work on main@origin and lands as a change in a host clone", {
  skip: missing,
  timeout: 20 * 60_000
}, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "issue-sweep-vm-work-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const config = join(root, "jj.toml")
  writeFileSync(config, "[user]\nname = \"t\"\nemail = \"t@t\"\n")
  Object.assign(process.env, { JJ_CONFIG: config })
  const host = join(root, "host")
  // The host clone downloads while the microVM boots and refreshes.
  const cloned = new Promise<void>((resolve, reject) =>
    spawn("jj", [
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
    ], { stdio: "inherit", env: process.env }).on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`jj git clone exited ${code}`)))
  )
  const remote = await Effect.runPromise(fixRemotely(
    make(),
    `real-${process.pid}-e`,
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const run = (line: string) =>
        Effect.scoped(
          Effect.flatMap(spawner.spawn(ChildProcess.make("sh", ["-c", line])), (handle) =>
            Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode]))
        )
      const [main] = yield* run(`cd ${guestCheckout} && jj log -r main@origin --no-graph -T commit_id`)
      const [, wrote] = yield* run(`cd ${guestCheckout} && echo "a line from the microVM" >> README.md`)
      assert.equal(wrote, 0)
      return { agent: "codex" as const, account: "test", report: main.trim() }
    }).pipe(Effect.orDie)
  ))
  assert.equal(remote.work._tag, "Changed")
  assert.match(remote.work.base, /^[0-9a-f]{40}$/)
  assert.equal(remote.work.base, remote.result.report, "the work is measured from the fetched main")

  await cloned
  const place = { repository: host, directory: join(root, "issue-0"), name: "sweep-0" }
  const report = await Effect.runPromise(adoptWork(remote, place, "test: a line from the microVM"))
  const readme = execFileSync("jj", [
    "-R",
    host,
    "--ignore-working-copy",
    "file",
    "show",
    "-r",
    report.change,
    "root:README.md"
  ], {
    encoding: "utf8",
    env: process.env
  })
  assert.match(readme, /a line from the microVM\n$/)
  assert.match(report.changed, /README\.md/)
})
