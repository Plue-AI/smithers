import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import { isAlive, parentPid, waitFor } from "@smthrs/testing/Faults"
import * as ProcessTable from "@smthrs/testing/ProcessTable"
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

/** Every process the host reports, keyed by host pid. */
const hostTable = () => {
  const table = new Map<number, { readonly parent: number; readonly group: number }>()
  for (const line of ProcessTable.query({ columns: ["pid", "ppid", "pgid"] }).split("\n")) {
    const [pid, parent, group] = line.trim().split(/\s+/).map(Number)
    if (Number.isSafeInteger(pid) && Number.isSafeInteger(parent) && Number.isSafeInteger(group)) {
      table.set(pid!, { parent: parent!, group: group! })
    }
  }
  return table
}

/** The host pids below `root` in one table, nearest generation first. */
const descendantsOf = (table: ReturnType<typeof hostTable>, root: number) => {
  const found: Array<number> = []
  let generation = [root]
  while (generation.length > 0) {
    const next = [...table].filter(([, { parent }]) => generation.includes(parent)).map(([pid]) => pid)
    found.push(...next)
    generation = next
  }
  return found
}

/**
 * The pid the process with host pid `pid` sees as its own: the innermost
 * `NSpid` entry on Linux, the pid itself elsewhere, `undefined` once it is gone.
 *
 * On Linux an approved shell command runs under bubblewrap in its own PID
 * namespace (#3140), so the pid it announces is 2 there, and the host's pid 2
 * is a kernel thread. The release smoke fixture made the same mistake and sent
 * SIGKILL to host pid 2 (5e83665567).
 */
const selfReportedPid = (pid: number): number | undefined => {
  if (process.platform !== "linux") return pid
  let status: string
  try {
    status = readFileSync(`/proc/${pid}/status`, "utf8")
  } catch {
    return undefined
  }
  const line = /^NSpid:\s+(\d+(?:\s+\d+)*)\s*$/m.exec(status)
  return line === null ? pid : Number(line[1]!.split(/\s+/).at(-1))
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
    // The recorded model proxy serves the ChatGPT seat.
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
    if (Number.isSafeInteger(result.pid)) launchedPids.add(result.pid)
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
  // A record is what a process says about itself, and a confined command says
  // it from inside a PID namespace. A recorded pid is owned only when the host
  // agrees about its parent, or the parent was a command this fixture launched
  // and has since exited (the detached owner). An MCP supervisor records
  // nothing itself; it is owned once its target or the process above it is.
  const launchedPids = new Set<number>()
  const captureLiveRecorded = () => {
    const table = hostTable()
    const pairs = [
      ...processes().filter((entry) => entry.event === "start").map((entry) => [entry.pid, entry.ppid] as const),
      ...mcpProcesses().map((entry) => [entry.pid, entry.supervisor] as const)
    ]
    const own = (pid: number) => {
      const started = ProcessReaper.posixSystem.startedAtMs(pid)
      if (started._tag === "started") owned.set(pid, started.startedAtMs)
    }
    for (const [pid, parent] of pairs) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || owned.has(pid)) continue
      const state = table.get(pid)
      if (state === undefined || (state.parent !== parent && !launchedPids.has(parent))) continue
      own(pid)
    }
    for (const pid of new Set(mcpProcesses().map((entry) => entry.supervisor))) {
      if (!Number.isSafeInteger(pid) || pid <= 1 || owned.has(pid)) continue
      const state = table.get(pid)
      if (state === undefined) continue
      if (owned.has(state.parent) || [...table].some(([child, entry]) => entry.parent === pid && owned.has(child))) {
        own(pid)
      }
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
      // The detached owner runs `flow execute` (src/Detached.ts); it was `run` before #3634.
      entry.event === "start" && entry.ppid === launched.pid && entry.verb === "flow"
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
    // The shell child announces the pid it sees for itself. Its supervisor
    // comes from the ledger, the one this owner spawned, and its host pid is
    // the process below that supervisor reporting the announced pid. Without
    // a PID namespace that is the announced pid itself.
    const shellSupervisor = () => {
      const spawned = ledger().filter((event) =>
        event.kind === "flows.host.process-spawned.v1" && event.payload.ownerPid === owner
      ).map((event) => event.payload.pid as number)
      expect(spawned.length, `shell supervisors: ${spawned.join(", ")}`).toBeLessThanOrEqual(1)
      return spawned[0]
    }
    const shellChild = () => {
      const supervisor = shellSupervisor()
      if (supervisor === undefined || !existsSync(marker)) return undefined
      const announced = Number(readFileSync(marker, "utf8"))
      const found = descendantsOf(hostTable(), supervisor).filter((pid) => selfReportedPid(pid) === announced)
      expect(found.length, `processes below ${supervisor} reporting pid ${announced}`).toBeLessThanOrEqual(1)
      return found[0]
    }
    await waitFor(
      () => mode === "mcp" ? ownedMcp() !== undefined : shellChild() !== undefined,
      "the real child to announce itself under its recorded supervisor",
      30_000
    ).catch((cause) => {
      throw new Error(`${String(cause)}\n${readFileSync(launched.value.logFile, "utf8")}`, { cause })
    })
    const supervisor = remember(mode === "mcp" ? ownedMcp()!.supervisor : shellSupervisor()!)
    const child = remember(mode === "mcp" ? ownedMcp()!.pid : shellChild()!)
    expect(Number.isSafeInteger(child) && child > 1).toBe(true)
    expect(descendantsOf(hostTable(), supervisor)).toContain(child)
    // A confined child hangs below its supervisor through the sandbox's own
    // processes, in the session the sandbox opened, so the direct-parent and
    // same-group checks apply only to an unconfined child.
    const confined = selfReportedPid(child) !== child
    const childParent = parentPid(child)
    expect(supervisor).not.toBe(owner)
    expect(parentPid(supervisor)).toBe(owner)
    if (confined) {
      expect(childParent).not.toBe(owner)
    } else {
      expect(childParent).toBe(supervisor)
      expect(processState(child)?.group).toBe(supervisor)
    }
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
    expect(parentPid(child)).toBe(childParent)
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
      expect(parentPid(child)).toBe(childParent)
      await waitFor(() => parentPid(supervisor) !== owner, "the stopped supervisor to be reparented", 10_000)
    }
    invoke("plan", "done")
    expectCompletedMcpGone(supervisor)
    // The reaper kills the supervisor's group. A confined child is outside
    // that group and dies with its namespace a moment after the group is gone.
    if (confined) await waitFor(() => !isAlive(child), "the confined orphan to die with its namespace", 5_000)
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
