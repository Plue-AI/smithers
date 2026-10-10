/**
 * The coding host's terminal port (T-TRM-05) against a stand-in for the
 * installed `smithers-machined client pty`. The real client, the local
 * socket and the broker are covered by crates/smithers-machined/tests
 * (local.rs, session_dispatch.rs, agent_run.rs); this proves the coding host
 * hands the planned call to that client and maps only its documented status.
 */
import { NodeServices } from "@effect/platform-node"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import type * as Cell from "@smthrs/harness/Cell"
import { Context, Effect, Option, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as CodingTerminal from "../coding/agentTerminal.ts"

const fakeClient = `#!/usr/bin/env node
const fs = require("node:fs")
if (process.argv.slice(2).join(" ") !== "client pty") process.exit(64)
const request = JSON.parse(fs.readFileSync(0, "utf8"))
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(request) + "\\n")
const status = (value) => process.stderr.write(JSON.stringify(value) + "\\n")
const hang = (clean) => {
  process.on("SIGTERM", () => { status({ cancelled: true, clean }); process.exit(clean ? 0 : 1) })
  setInterval(() => {}, 1000)
}
switch (request.display) {
  case "pnpm test":
    process.stdout.write("\\x1b[32mAGENT_TERMINAL_FIRST\\x1b[0m\\r\\n")
    process.stdout.write("AGENT_TERMINAL_LAST", () => status({ exit: 7 }))
    break
  case "big": process.stdout.write("y".repeat(200000), () => status({ exit: 0 })); break
  case "terminated": process.stdout.write("x", () => status({ signal: 15 })); break
  case "refused": status({ error: { code: "unauthorized" } }); process.exitCode = 1; break
  case "runner": status({ error: { code: "runner", exit: 1 } }); process.exitCode = 1; break
  case "garbage": process.stderr.write("not a status\\n"); break
  case "hang": hang(true); break
  case "hang-dirty": hang(false); break
  default: status({ exit: 0 })
}
`

const callOf = (input: unknown): Cell.Call =>
  ({
    flowName: "bash",
    input,
    capabilities: [],
    effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "irreversible" },
    placement: Option.none(),
    identity: { session: "agent-terminal", frame: 0, cell: "cell", ordinal: 0, declaration: "declaration", layers: [] }
  }) as unknown as Cell.Call

const harness = async () => {
  const dir = await mkdtemp(join(tmpdir(), "coding-agent-terminal-"))
  const client = join(dir, "smithers-machined")
  const log = join(dir, "requests.log")
  await writeFile(client, fakeClient)
  await chmod(client, 0o755)
  await writeFile(log, "")
  process.env.FAKE_LOG = log
  const bash = await Effect.runPromise(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const path = yield* Path.Path
      const source = StandardFlows.shell(
        Context.make(Path.Path, path).pipe(Context.add(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        undefined,
        { terminal: "agent", terminalPort: CodingTerminal.port(spawner, client) }
      )
      const [binding] = yield* source.bindings()
      return binding!
    }).pipe(Effect.provide(NodeServices.layer))
  )
  const run = (input: unknown) => Effect.runPromise(bash.run(callOf(input)).pipe(Effect.provide(NodeServices.layer)))
  const requests = async () =>
    (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  return { dir, run, requests, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

test("a command runs through the installed client and returns its terminal output and exit status", async (t) => {
  const h = await harness()
  t.after(h.cleanup)
  const result = await h.run({ command: "pnpm test", cwd: "web", env: { FOO: "1" }, mode: "unhermetic" })
  assert.equal(result.outcome, "success")
  assert.deepEqual(result.value, {
    exitCode: 7,
    stdout: "AGENT_TERMINAL_FIRST\nAGENT_TERMINAL_LAST",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutDroppedBytes: 0,
    stderrDroppedBytes: 0
  })
  const script = await h.run({ script: "print(1)", interpreter: "python3", args: ["-v"], mode: "unhermetic" })
  assert.equal(script.outcome, "success")
  assert.deepEqual(await h.requests(), [
    { argv: ["/bin/sh", "-c", "pnpm test"], cwd: "web", env: { FOO: "1" }, display: "pnpm test" },
    { argv: ["python3", "-", "-v"], env: {}, stdin: "print(1)", display: "python3 - -v" }
  ])
})

test("output is bounded like Bash and signals keep the shell's 128+n status", async (t) => {
  const h = await harness()
  t.after(h.cleanup)
  const big = await h.run({ command: "big", mode: "unhermetic" })
  assert.equal(big.outcome, "success")
  const value = big.value as { stdout: string; stdoutTruncated: boolean; stdoutDroppedBytes: number }
  assert.equal(value.stdout.length, 30_000)
  assert.equal(value.stdoutTruncated, true)
  assert.equal(value.stdoutDroppedBytes, 170_000)
  const terminated = await h.run({ command: "terminated", mode: "unhermetic" })
  assert.equal((terminated.value as { exitCode: number }).exitCode, 143)
})

test("a refused open, a failed runner and an unreadable status are typed failures", async (t) => {
  const h = await harness()
  t.after(h.cleanup)
  const refused = await h.run({ command: "refused", mode: "unhermetic" })
  assert.equal(refused.outcome, "failure")
  assert.match(String(refused.message), /Agent terminal unavailable: unauthorized/)
  const runner = await h.run({ command: "runner", mode: "unhermetic" })
  assert.equal(runner.outcome, "failure")
  const garbage = await h.run({ command: "garbage", mode: "unhermetic" })
  assert.equal(garbage.outcome, "failure")
})

test("a timeout cancels through the client and fences the run only after confirmed cleanup", async (t) => {
  const h = await harness()
  t.after(h.cleanup)
  const timedOut = await h.run({ command: "hang", timeoutMs: 300, mode: "unhermetic" })
  assert.equal(timedOut.outcome, "failure")
  assert.match(String(timedOut.message), /timed out|timeout/i)
  const after = await h.run({ command: "pnpm test", mode: "unhermetic" })
  assert.equal(after.outcome, "failure")
  assert.match(String(after.message), /run ended/)
  // The fenced run spawned no further client.
  assert.equal((await h.requests()).length, 1)
})

test("an unconfirmed cancellation reports that cleanup is unconfirmed", async (t) => {
  const h = await harness()
  t.after(h.cleanup)
  const timedOut = await h.run({ command: "hang-dirty", timeoutMs: 300, mode: "unhermetic" })
  assert.equal(timedOut.outcome, "failure")
  const after = await h.run({ command: "pnpm test", mode: "unhermetic" })
  assert.equal(after.outcome, "failure")
  assert.equal((await h.requests()).length, 1)
})

test("the status parser accepts only the client's documented lines", () => {
  assert.deepEqual(CodingTerminal.parseStatus('noise\n{"exit":7}\n'), { exit: 7 })
  assert.deepEqual(CodingTerminal.parseStatus('{"signal":9}'), { signal: 9 })
  assert.deepEqual(CodingTerminal.parseStatus('{"cancelled":true,"clean":false}'), { cancelled: true, clean: false })
  assert.deepEqual(CodingTerminal.parseStatus('{"error":{"code":"busy"}}'), { error: { code: "busy" } })
  for (
    const bad of [
      "",
      "{",
      "[1]",
      '{"exit":256}',
      '{"exit":-1}',
      '{"exit":1.5}',
      '{"exit":1,"signal":2}',
      '{"signal":0}',
      '{"cancelled":false,"clean":true}',
      '{"error":{"code":"Bad Code"}}',
      '{"error":null}',
      "null"
    ]
  ) {
    assert.equal(CodingTerminal.parseStatus(bad), undefined, bad)
  }
})

test("off a machine there is no agent terminal, so bash refuses instead of spawning here", async () => {
  const port = await Effect.runPromise(
    Effect.map(ChildProcessSpawner.ChildProcessSpawner, CodingTerminal.installed).pipe(Effect.provide(NodeServices.layer))
  )
  assert.equal(port, undefined)
  assert.deepEqual(CodingTerminal.request({ command: "a", script: "b", mode: "unhermetic" }) instanceof Error, true)
})
