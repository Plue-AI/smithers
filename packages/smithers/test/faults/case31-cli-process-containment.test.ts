import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import { isAlive, parentPid, waitFor } from "@smthrs/testing/Faults"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const executable = fileURLToPath(new URL("../../src/bin.ts", import.meta.url))
const preload = new URL("./fixtures/recorded-provider.mjs", import.meta.url).href
const processState = (pid: number) => {
  const result = spawnSync("/bin/ps", ["-o", "pgid=,stat=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1000
  })
  if (result.status !== 0) return undefined
  const [group, state] = result.stdout.trim().split(/\s+/)
  return { group: Number(group), stopped: state?.startsWith("T") === true }
}

const containment = async (mode: "shell" | "mcp", recovery: "automatic" | "reaper") => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-cli-containment-")))
  const recording = join(root, "recording")
  mkdirSync(recording)
  const marker = join(recording, "child.pid")
  const mcpConfig = join(recording, "mcp.json")
  const environment: NodeJS.ProcessEnv = {
    NODE_OPTIONS: `--import=${preload}`,
    SMITHERS_TEST_RECORDING: recording,
    // The recorded model proxy serves the ChatGPT seat and its judge.
    SMITHERS_OPENAI_AUTH: "chatgpt",
    SMITHERS_MODEL_PROXY_URL: "https://model-proxy.recorded.invalid",
    OPENAI_API_KEY: "recorded-fixture-not-a-real-key"
  }
  for (const key of ["PATH", "TMPDIR", "SystemRoot", "WINDIR", "SMITHERS_WORKSPACE_JJ_EXPORT_BINARY"]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  const invoke = (...args: Array<string>) => {
    const result = spawnSync(process.execPath, [
      executable,
      ...args,
      ...(mode === "mcp" ? ["--mcp-config", mcpConfig] : []),
      "--json"
    ], {
      cwd: root,
      env: environment,
      encoding: "utf8",
      timeout: 45_000,
      maxBuffer: 1024 * 1024
    })
    // A failed invocation may still have launched a detached CLI or MCP pair.
    // Capture its recorded identities before status or JSON assertions throw.
    captureLiveRecorded()
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, `${result.stderr}\n${result.stdout}`).toBe(0)
    return { pid: result.pid, value: JSON.parse(result.stdout) }
  }
  const processes = (): Array<{ pid: number; ppid: number; verb: string; event: string }> => {
    const path = join(recording, "processes.jsonl")
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []
  }
  const mcpProcesses = (): Array<{ pid: number; supervisor: number }> => {
    const path = join(recording, "mcp-pids.jsonl")
    return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []
  }
  // Capture OS start times while the fixture identities are alive. Teardown
  // rechecks that identity before signalling each test-owned PID.
  const owned = new Map<number, number>()
  const remember = (pid: number) => {
    expect(Number.isSafeInteger(pid) && pid > 1, `fixture PID ${pid}`).toBe(true)
    const started = ProcessReaper.posixSystem.startedAtMs(pid)
    expect(started._tag, `start time for fixture PID ${pid}`).toBe("started")
    if (started._tag === "started") {
      if (owned.has(pid)) expect(started.startedAtMs, `unchanged fixture PID ${pid}`).toBe(owned.get(pid))
      else owned.set(pid, started.startedAtMs)
    }
    return pid
  }
  const captureLiveRecorded = () => {
    const recorded = [
      ...processes().filter((entry) => entry.event === "start").map((entry) => entry.pid),
      ...mcpProcesses().flatMap((entry) => [entry.pid, entry.supervisor])
    ]
    for (const pid of recorded) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || owned.has(pid)) continue
      const started = ProcessReaper.posixSystem.startedAtMs(pid)
      if (started._tag === "started") owned.set(pid, started.startedAtMs)
    }
  }
  const expectCompletedMcpGone = (supervisor: number) => {
    // Completed commands' MCP servers ignore TERM. Their exit proves normal
    // scope shutdown escalates, including the final replacement command.
    for (const entry of mcpProcesses().filter((entry) => entry.supervisor !== supervisor)) {
      expect(isAlive(entry.pid)).toBe(false)
      expect(isAlive(entry.supervisor)).toBe(false)
    }
  }
  const ledger = () => {
    const database = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
    try {
      return database.prepare(
        "SELECT event_type, payload_json FROM flows_journal_events WHERE event_type LIKE 'flows.host.process-%' ORDER BY emitted_at_ms, seq"
      ).all().map((row) => ({ kind: row.event_type, payload: JSON.parse(String(row.payload_json)) }))
    } finally {
      database.close()
    }
  }
  let primaryFailure: { error: unknown } | undefined
  try {
    expect(spawnSync("git", ["init", "--quiet"], { cwd: root }).status).toBe(0)
    writeFileSync(join(root, ".gitignore"), ".flows/\nrecording/\n")
    for (const name of ["busy", "done"]) {
      mkdirSync(join(root, "flows", name), { recursive: true })
      writeFileSync(
        join(root, "flows", name, "flow.mdx"),
        [
          "---",
          `name: ${name}`,
          "description: Recorded process containment exercise.",
          "model: openai:gpt-4o-mini",
          name === "busy" && mode === "shell" ? "capabilities: [\"proc:spawn:*\"]" : "capabilities: []",
          "---",
          "Perform the recorded exercise."
        ].join("\n")
      )
    }
    const script = [
      `require("node:fs").writeFileSync(${JSON.stringify(marker)}, String(process.pid))`,
      "process.on(\"SIGTERM\", () => {})",
      "setInterval(() => {}, 1000)"
    ].join("\n")
    writeFileSync(
      mcpConfig,
      JSON.stringify([{
        server: "contained",
        command: process.execPath,
        args: [fileURLToPath(new URL("./fixtures/contained-mcp.mjs", import.meta.url)), recording]
      }])
    )
    writeFileSync(
      join(recording, "cell.txt"),
      mode === "mcp"
        ? "await ctx.call(\"wait\", { seconds: 150, reason: \"MCP containment\" }); ctx.done(\"finished\")"
        : `await ctx.call("bash", ${
          JSON.stringify({
            mode: "unhermetic",
            interpreter: "node",
            script,
            cwd: root,
            timeoutMs: 120_000
          })
        })\nctx.done("finished")`
    )
    const launched = invoke("up", "busy", "-d")
    const owner = processes().find((entry) =>
      entry.event === "start" && entry.ppid === launched.pid && entry.verb === "run"
    )
      ?.pid
    expect(owner).toBeDefined()
    remember(owner!)
    const ownedMcp = () => {
      const spawned = ledger().filter((event) =>
        event.kind === "flows.host.process-spawned.v1" && event.payload.ownerPid === owner
      )
      return mcpProcesses().find((entry) => spawned.some((event) => event.payload.pid === entry.supervisor))
    }
    await waitFor(
      () => mode === "mcp" ? ownedMcp() !== undefined : existsSync(marker),
      "the real child to announce itself under its recorded supervisor",
      30_000
    ).catch((cause) => {
      throw new Error(`${String(cause)}\n${readFileSync(launched.value.logFile, "utf8")}`, { cause })
    })
    const child = remember(mode === "mcp" ? ownedMcp()!.pid : Number(readFileSync(marker, "utf8")))
    expect(Number.isSafeInteger(child) && child > 1).toBe(true)
    const supervisor = remember(parentPid(child)!)
    expect(supervisor).not.toBe(owner)
    expect(parentPid(supervisor)).toBe(owner)
    expect(processState(child)?.group).toBe(supervisor)
    expect(processState(supervisor)?.group).toBe(supervisor)
    expect(isAlive(child)).toBe(true)
    const childEvents = () =>
      ledger().filter((event) => event.payload.pid === supervisor && event.payload.ownerPid === owner)
    expect(childEvents()).toMatchObject([
      { kind: "flows.host.process-spawned.v1", payload: { pid: supervisor, pgid: supervisor, ownerPid: owner } }
    ])
    // Startup may inspect this child's record, but a living owner excludes it
    // from reaping. `plan` builds the full CLI composition without competing
    // for the workspace boundary the first agent is currently holding.
    invoke("plan", "done")
    expect(isAlive(owner!)).toBe(true)
    expect(parentPid(child)).toBe(supervisor)
    expect(parentPid(supervisor)).toBe(owner)
    expect(isAlive(child)).toBe(true)
    expectCompletedMcpGone(supervisor)
    expect(childEvents()).toHaveLength(1)

    if (recovery === "reaper") {
      // Stop only the recorded supervisor, leaving its target running. This
      // deliberately prevents the automatic parent-EOF cleanup so replacement
      // startup must exercise the durable reaper against a real owned group.
      process.kill(supervisor, "SIGSTOP")
      await waitFor(() => processState(supervisor)?.stopped === true, "the supervisor to stop before its owner crashes")
    }
    process.kill(owner!, "SIGKILL")
    await waitFor(() => !isAlive(owner!), "the crashed CLI to disappear", 10_000)
    if (recovery === "automatic") {
      // No replacement CLI has started: the private channel's EOF must make
      // the supervisor terminate even a TERM-ignoring target by itself.
      await waitFor(() => !isAlive(child) && !isAlive(supervisor), "automatic crash cleanup", 10_000)
    } else {
      expect(isAlive(child)).toBe(true)
      expect(isAlive(supervisor)).toBe(true)
      expect(parentPid(child)).toBe(supervisor)
      await waitFor(() => parentPid(supervisor) !== owner, "the stopped supervisor to be reparented", 10_000)
    }
    invoke("plan", "done")
    expectCompletedMcpGone(supervisor)
    expect(isAlive(child), "A replacement CLI left the crashed CLI's child alive").toBe(false)
    expect(isAlive(supervisor), "A replacement CLI left the crashed CLI's supervisor alive").toBe(false)
    expect(childEvents()).toMatchObject([
      { kind: "flows.host.process-spawned.v1", payload: { pid: supervisor, pgid: supervisor, ownerPid: owner } },
      recovery === "automatic"
        ? { kind: "flows.host.process-reap-skipped.v1", payload: { reason: "process-gone" } }
        : { kind: "flows.host.process-reaped.v1" }
    ])
  } catch (error) {
    primaryFailure = { error }
    throw error
  } finally {
    // Every identity was observed in this fixture while alive. No broad
    // process-name or process-group kill is used for teardown. Signal every
    // owner before waiting: a stopped parent cannot reap its killed child.
    const cleanupErrors: Array<unknown> = []
    const signalled: Array<number> = []
    try {
      captureLiveRecorded()
    } catch (error) {
      cleanupErrors.push(error)
    }
    for (const [pid, startedAtMs] of owned) {
      try {
        const current = ProcessReaper.posixSystem.startedAtMs(pid)
        if (current._tag !== "started" || current.startedAtMs !== startedAtMs) continue
        signalled.push(pid)
        process.kill(pid, "SIGKILL")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupErrors.push(error)
      }
    }
    const settled = await Promise.allSettled(
      signalled.map((pid) => waitFor(() => !isAlive(pid), `test-owned child ${pid} cleanup`, 10_000))
    )
    for (const result of settled) {
      if (result.status === "rejected") cleanupErrors.push(result.reason)
    }
    try {
      rmSync(root, { recursive: true, force: true })
    } catch (error) {
      cleanupErrors.push(error)
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [...(primaryFailure ? [primaryFailure.error] : []), ...cleanupErrors],
        "CLI containment fixture cleanup failed",
        primaryFailure ? { cause: primaryFailure.error } : undefined
      )
    }
  }
}

it(
  "automatically contains a crashed CLI's shell child and retires its durable record on replacement startup",
  () => containment("shell", "automatic"),
  180_000
)
it(
  "automatically contains a crashed CLI's mcp child and retires its durable record on replacement startup",
  () => containment("mcp", "automatic"),
  180_000
)
it(
  "reaps a crashed CLI's shell group when its supervisor cannot perform automatic cleanup",
  () => containment("shell", "reaper"),
  180_000
)
it(
  "reaps a crashed CLI's mcp group when its supervisor cannot perform automatic cleanup",
  () => containment("mcp", "reaper"),
  180_000
)
