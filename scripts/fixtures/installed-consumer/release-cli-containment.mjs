// Runs entirely from the external consumer: no workspace imports or source loader.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { assertInstalledConsumer } from "./consumer-boundary.mjs"
import { processStates } from "./process-state.mjs"

assertInstalledConsumer(import.meta.url)
const format = process.argv[2]
assert.ok(format === "esm" || format === "cjs")
const require = createRequire(import.meta.url)
const ProcessReaper = format === "cjs"
  ? require("@smthrs/platform-node/ProcessReaper")
  : await import("@smthrs/platform-node/ProcessReaper")
const executable = format === "esm"
  ? fileURLToPath(import.meta.resolve("@smthrs/cli/bin"))
  : require.resolve("@smthrs/cli/bin")
assert.ok(executable.replaceAll("\\", "/").endsWith(`/dist/${format}/bin.js`), executable)
const preload = new URL("./release-recorded-provider.mjs", import.meta.url).href
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== "ESRCH" }
}
const waitFor = async (predicate, label, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Installed ${format}: timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

// Both transports live under the same real CLI owner. Each keeps its own
// supervisor, identity and ledger assertions. Sharing the three CLI launches
// avoids duplicating startup for otherwise identical crash/replacement steps.
const containment = async (recovery) => {
  const kind = "shell+mcp"
  const started = performance.now()
  let stateMs = 0
  let stateProbes = 0
  const states = (pids) => {
    const before = performance.now()
    try { return processStates(pids) }
    finally { stateMs += performance.now() - before; stateProbes++ }
  }
  let identityMs = 0
  let identityProbes = 0
  const identify = (pid) => {
    const before = performance.now()
    try { return ProcessReaper.posixSystem.startedAtMs(pid) }
    finally { identityMs += performance.now() - before; identityProbes++ }
  }
  console.log(JSON.stringify({ containment: { format, kind, recovery }, event: "start", at: new Date().toISOString() }))
  const root = realpathSync(mkdtempSync(join(tmpdir(), `smthrs-installed-${format}-${kind}-${recovery}-`)))
  const recording = join(root, "recording")
  mkdirSync(recording)
  const marker = join(recording, "child.pid")
  const mcpConfig = join(recording, "mcp.json")
  const environment = {
    NODE_OPTIONS: `--import=${preload}`,
    SMITHERS_TEST_RECORDING: recording,
    // The recorded model proxy serves the ChatGPT seat and its judge, as in
    // packages/smithers/test/faults/case31-cli-process-containment.test.ts.
    SMITHERS_OPENAI_AUTH: "chatgpt",
    SMITHERS_MODEL_PROXY_URL: "https://model-proxy.recorded.invalid",
    OPENAI_API_KEY: "recorded-fixture-not-a-real-key"
  }
  for (const key of ["PATH", "TMPDIR", "SystemRoot", "WINDIR", "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  const records = (file) => existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []
  const mcpProcesses = () => records(join(recording, "mcp-pids.jsonl"))
  const invoke = (...args) => {
    const before = performance.now()
    const result = spawnSync(process.execPath, [executable, ...args,
      "--mcp-config", mcpConfig, "--json"], {
      // Each combined invocation replaces two separately bounded 45 s calls.
      // Node 24 measurement on 2026-09-14: CJS mixed startup took 48.08 s
      // before the inherited single-call limit interrupted it. Preserve the
      // original summed budget while exercising both transports together.
      cwd: root, env: environment, encoding: "utf8", timeout: 90_000, maxBuffer: 1024 * 1024
    })
    console.log(JSON.stringify({ containmentCommand: { format, kind, recovery, args }, at: new Date().toISOString(), durationMs: performance.now() - before }))
    // Capture leaked fixture processes before a failed command or JSON parse
    // can throw, including the final replacement command's MCP pair.
    captureRecorded()
    assert.equal(result.error, undefined,
      `${format} ${kind}: ${result.error?.message ?? ""}\n${result.stderr}\n${result.stdout}`)
    assert.equal(result.status, 0, `${format} ${kind}: ${result.stderr}\n${result.stdout}`)
    return { pid: result.pid, value: JSON.parse(result.stdout) }
  }
  const ledger = () => {
    const database = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
    try {
      return database.prepare(
        "SELECT event_type, payload_json FROM flows_journal_events WHERE event_type LIKE 'flows.host.process-%' ORDER BY emitted_at_ms, seq"
      ).all().map((row) => ({ kind: row.event_type, payload: JSON.parse(row.payload_json) }))
    } finally { database.close() }
  }
  // Teardown signals only identities observed alive in this fixture, never a
  // recycled PID or a broad process-name/process-group match.
  const owned = new Map()
  const remember = (pid) => {
    assert.ok(Number.isSafeInteger(pid) && pid > 1, `Invalid fixture PID: ${pid}`)
    const started = identify(pid)
    assert.equal(started._tag, "started", `Cannot identify fixture PID ${pid}`)
    if (owned.has(pid)) assert.equal(started.startedAtMs, owned.get(pid), `Fixture PID ${pid} was reused`)
    else owned.set(pid, started.startedAtMs)
    return pid
  }
  const captureRecorded = () => {
    const pids = [
      ...records(join(recording, "processes.jsonl")).filter((entry) => entry.event === "start").map((entry) => entry.pid),
      ...mcpProcesses().flatMap((entry) => [entry.pid, entry.supervisor])
    ]
    for (const pid of pids) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || owned.has(pid)) continue
      const started = identify(pid)
      if (started._tag === "started") owned.set(pid, started.startedAtMs)
    }
  }
  const assertCompletedMcps = (supervisor) => {
    for (const entry of mcpProcesses().filter((entry) => entry.supervisor !== supervisor)) {
      assert.equal(isAlive(entry.pid), false, `Completed command left MCP target ${entry.pid} alive`)
      assert.equal(isAlive(entry.supervisor), false, `Completed command left MCP supervisor ${entry.supervisor} alive`)
    }
  }
  const signalOwned = (pid, signal) => {
    const current = identify(pid)
    assert.equal(current._tag, "started", `Fixture PID ${pid} exited before ${signal}`)
    assert.equal(current.startedAtMs, owned.get(pid), `Fixture PID ${pid} was reused before ${signal}`)
    process.kill(pid, signal)
  }
  let testError
  try {
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root }).status, 0)
    writeFileSync(join(root, ".gitignore"), ".flows/\nrecording/\n")
    for (const name of ["busy", "done"]) {
      mkdirSync(join(root, "flows", name), { recursive: true })
      writeFileSync(join(root, "flows", name, "flow.mdx"), [
        "---", `name: ${name}`, "description: Installed containment exercise.",
        "model: openai:gpt-4o-mini",
        name === "busy" ? 'capabilities: ["proc:spawn:*"]' : "capabilities: []",
        "---", "Perform the recorded exercise."
      ].join("\n"))
    }
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, supervisor: process.ppid }))`,
      'process.on("SIGTERM", () => {})', "setInterval(() => {}, 1000)"
    ].join("\n")
    writeFileSync(mcpConfig, JSON.stringify([{
      server: "contained", command: process.execPath,
      args: [fileURLToPath(new URL("./release-contained-mcp.mjs", import.meta.url)), recording]
    }]))
    writeFileSync(join(recording, "cell.txt"), `await ctx.call("bash", ${JSON.stringify({
        mode: "unhermetic", interpreter: "node", script, cwd: root, timeoutMs: 120_000
      })}); ctx.done("finished")`)
    const launched = invoke("up", "busy", "-d")
    assert.equal(launched.value.detached, true)
    const owner = remember(records(join(recording, "processes.jsonl"))
      .find((entry) => entry.event === "start" && entry.ppid === launched.pid && entry.verb === "run")?.pid)
    const ownedMcp = () => {
      const spawned = ledger().filter((entry) =>
        entry.kind === "flows.host.process-spawned.v1" && entry.payload.ownerPid === owner)
      return mcpProcesses().find((entry) => spawned.some((event) => event.payload.pid === entry.supervisor))
    }
    await waitFor(() => ownedMcp() !== undefined && existsSync(marker),
      "both real children under their recorded supervisors", 30_000)
    const shell = JSON.parse(readFileSync(marker, "utf8"))
    const mcp = ownedMcp()
    const children = [
      { kind: "shell", child: remember(shell.pid), supervisor: remember(shell.supervisor) },
      { kind: "mcp", child: remember(mcp.pid), supervisor: remember(mcp.supervisor) }
    ]
    const snapshot = () => states(children.flatMap(({ child, supervisor }) => [child, supervisor]))
    const spawnedState = snapshot()
    assert.notEqual(children[0].supervisor, children[1].supervisor,
      "shell and MCP must have independent process groups")
    const mcpSupervisor = children[1].supervisor
    const childEvents = (supervisor) => ledger().filter((entry) =>
      entry.payload.pid === supervisor && entry.payload.ownerPid === owner)
    for (const { child, supervisor } of children) {
      assert.notEqual(supervisor, owner)
      assert.equal(spawnedState.get(child)?.parent, supervisor)
      assert.equal(spawnedState.get(supervisor)?.parent, owner)
      assert.equal(spawnedState.get(child)?.group, supervisor)
      assert.equal(spawnedState.get(supervisor)?.group, supervisor)
      const spawned = childEvents(supervisor)
      assert.equal(spawned.length, 1)
      assert.equal(spawned[0].kind, "flows.host.process-spawned.v1")
      assert.equal(spawned[0].payload.pgid, supervisor)
    }

    // A replacement composition may inspect the ledger, but cannot reap a
    // living owner's groups. Completed commands must clean up their own MCPs.
    invoke("plan", "done")
    const liveState = snapshot()
    for (const { child, supervisor } of children) {
      assert.ok(isAlive(owner) && isAlive(child), "A live owner's child was reaped")
      assert.equal(liveState.get(child)?.parent, supervisor)
      assert.equal(liveState.get(supervisor)?.parent, owner)
      assert.equal(childEvents(supervisor).length, 1)
    }
    assertCompletedMcps(mcpSupervisor)
    if (recovery === "reaper") {
      // Freeze both supervisors, leaving both stubborn targets running. This
      // prevents automatic EOF cleanup and forces real durable reaper work.
      for (const { supervisor } of children) signalOwned(supervisor, "SIGSTOP")
      await waitFor(() => {
        const stopped = snapshot()
        return children.every(({ supervisor }) => stopped.get(supervisor)?.stopped === true)
      }, "both supervisors to stop")
    }
    signalOwned(owner, "SIGKILL")
    await waitFor(() => !isAlive(owner), "the crashed owner to disappear")
    for (const { child, supervisor } of children) {
      if (recovery === "automatic") {
        await waitFor(() => !isAlive(child) && !isAlive(supervisor), "automatic crash cleanup before replacement startup")
      } else {
        assert.ok(isAlive(child) && isAlive(supervisor), "The injected crash did not leave a real orphan group")
        await waitFor(() => {
          const orphan = snapshot()
          assert.equal(orphan.get(child)?.parent, supervisor)
          const parent = orphan.get(supervisor)?.parent
          assert.ok(parent !== undefined, "the stopped supervisor must still exist")
          return parent !== owner
        }, "the stopped supervisor to be reparented")
      }
    }
    invoke("plan", "done")
    assertCompletedMcps(mcpSupervisor)
    for (const { kind, child, supervisor } of children) {
      assert.equal(isAlive(child), false, "Installed CLI left the orphan alive")
      assert.equal(isAlive(supervisor), false, "Installed CLI left the supervisor alive")
      const events = childEvents(supervisor)
      assert.deepEqual(events.map((entry) => entry.kind), [
        "flows.host.process-spawned.v1",
        recovery === "automatic" ? "flows.host.process-reap-skipped.v1" : "flows.host.process-reaped.v1"
      ])
      if (recovery === "automatic") assert.equal(events[1].payload.reason, "process-gone")
      console.log(`Installed ${format} CLI ${kind} ${recovery} containment passed`)
    }
    assert.equal(records(join(recording, "requests.jsonl")).length, 1)
  } catch (error) {
    testError = error
    throw error
  } finally {
    const cleanupErrors = []
    const signalled = []
    try { captureRecorded() } catch (error) { cleanupErrors.push(error) }
    // Signal every owned process before waiting. A killed target can remain a
    // zombie while its supervisor is stopped and cannot reap it yet.
    for (const [pid, startedAtMs] of owned) {
      try {
        const current = identify(pid)
        if (current._tag !== "started" || current.startedAtMs !== startedAtMs) continue
        signalled.push(pid)
        try { process.kill(pid, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
      } catch (error) { cleanupErrors.push(error) }
    }
    const settled = await Promise.allSettled(signalled.map((pid) =>
      waitFor(() => !isAlive(pid), `test-owned PID ${pid} cleanup`)))
    for (const result of settled) if (result.status === "rejected") cleanupErrors.push(result.reason)
    try { rmSync(root, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(error) }
    console.log(JSON.stringify({ containment: { format, kind, recovery }, event: "end", at: new Date().toISOString(), durationMs: performance.now() - started, identityMs, identityProbes, stateMs, stateProbes }))
    if (cleanupErrors.length > 0) {
      throw new AggregateError(testError === undefined ? cleanupErrors : [testError, ...cleanupErrors],
        `Installed ${format} ${kind} ${recovery} fixture cleanup failed`)
    }
  }
}

for (const recovery of ["automatic", "reaper"]) await containment(recovery)
