import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { descendantsOf, processStates, processTable, selfReportedPid } from "./fixtures/installed-consumer/process-state.mjs"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { captureProcess } from "./release-process.mjs"

const node = (source, options) => captureProcess(process.execPath, ["--eval", source], process.cwd(), options)

test("drains all output before classifying a successful release probe", async () => {
  const result = await node('process.stdout.write("x".repeat(200_000)); process.stderr.write("end")')
  assert.deepEqual(result, { ok: true, output: "x".repeat(200_000) + "end" })
})

test("a nonzero probe retains its diagnostics and failing outcome", async () => {
  const result = await node('process.stdout.write("partial"); process.stderr.write("failure"); process.exitCode = 9')
  assert.equal(result.ok, false)
  assert.ok(result.output.startsWith("partialfailure"))
})

test("noninteractive probes receive EOF instead of waiting for input", async () => {
  const result = await node('process.stdin.on("end", () => process.stdout.write("eof")); process.stdin.resume()', {
    timeoutMs: 5000
  })
  assert.deepEqual(result, { ok: true, output: "eof" })
})

test("an executable that cannot start produces a useful failed result", async () => {
  const result = await captureProcess("/nonexistent/smthrs-release-probe", [], process.cwd())
  assert.equal(result.ok, false)
  assert.match(result.output, /ENOENT/)
})

test("a probe that never terminates is killed within its budget", async () => {
  const result = await node("setInterval(() => {}, 1000)", { timeoutMs: 100 })
  assert.equal(result.ok, false)
  assert.match(result.output, /timed out after 100 ms/)
})

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    throw error
  }
}

const exited = async (pid, withinMs = 2000) => {
  for (const started = Date.now(); Date.now() - started < withinMs;) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

/** Parent writes, starts one owned descendant with the given stdio, records its PID, and exits 0. */
const parentWithDescendant = (pidFile, stdio) => `
  const { spawn } = require("node:child_process")
  const { writeFileSync } = require("node:fs")
  const child = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: ${JSON.stringify(stdio)} })
  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))
  process.stdout.write("parent finished\\n")
  process.exit(0)
`

const withDescendant = async (t, stdio, run) => {
  const root = mkdtempSync(join(tmpdir(), "release-probe-"))
  const pidFile = join(root, "pid")
  let pid
  t.after(() => {
    if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL")
    rmSync(root, { recursive: true, force: true })
  })
  const result = await run(parentWithDescendant(pidFile, stdio))
  pid = Number(readFileSync(pidFile, "utf8"))
  return { result, pid }
}

test("an expired output drain fails the probe even after its parent exited 0, and kills the descendant", async (t) => {
  const started = Date.now()
  const { result, pid } = await withDescendant(t, ["ignore", "inherit", "inherit"], (source) => node(source, { timeoutMs: 300 }))
  const elapsed = Date.now() - started
  assert.equal(result.ok, false)
  assert.ok(result.output.startsWith("parent finished\n"))
  assert.match(result.output, /timed out after 300 ms before its output closed/)
  assert.ok(elapsed >= 300 && elapsed < 2000, `settled after ${elapsed} ms`)
  assert.equal(await exited(pid), true)
})

test("a successful probe still reaps an owned descendant that closed its output", async (t) => {
  const { result, pid } = await withDescendant(t, "ignore", (source) => node(source, { timeoutMs: 5000 }))
  assert.deepEqual(result, { ok: true, output: "parent finished\n" })
  assert.equal(await exited(pid), true)
})

test("excessive probe output fails rather than growing the gate without bound", async () => {
  const result = await node('process.stdout.write("x".repeat(200_000))', { maxOutputBytes: 4096 })
  assert.equal(result.ok, false)
  assert.match(result.output, /exceeds its 4096-byte limit/)
  assert.ok(result.output.length < 8192)
})

test("a targeted process snapshot agrees with a real child's recorded parent and inherited group", async (t) => {
  const child = spawn(process.execPath, ["--eval", `
    process.on("message", () => {})
    process.send({ pid: process.pid, parent: process.ppid })
  `], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
  })
  const [recorded] = await once(child, "message")
  const snapshot = processStates([process.pid, recorded.pid])
  assert.deepEqual([...snapshot.keys()].sort((a, b) => a - b), [process.pid, recorded.pid].sort((a, b) => a - b))
  assert.equal(snapshot.get(process.pid).parent, process.ppid)
  assert.equal(snapshot.get(recorded.pid).parent, recorded.parent)
  assert.equal(recorded.parent, process.pid)
  assert.equal(snapshot.get(recorded.pid).group, snapshot.get(process.pid).group)
  assert.equal(snapshot.get(recorded.pid).stopped, false)
  assert.throws(() => processStates([1]), /Invalid fixture PID/)
})

test("the process table finds a real grandchild below this process and nothing above it", async (t) => {
  // The installed containment fixture finds its shell child this way. On
  // Linux that child is confined in a PID namespace (#3140) and announces
  // pid 2; dry run 37862357655 took that for the host's pid 2 and signalled it.
  const child = spawn(process.execPath, ["--eval", `
    const { spawn } = require("node:child_process")
    const grandchild = spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    process.send({ pid: process.pid, grandchild: grandchild.pid })
    process.on("message", () => {})
  `], { stdio: ["ignore", "ignore", "inherit", "ipc"] })
  const [recorded] = await once(child, "message")
  t.after(async () => {
    try { process.kill(recorded.grandchild, "SIGKILL") } catch (error) { if (error.code !== "ESRCH") throw error }
    if (child.exitCode !== null || child.signalCode !== null) return
    const exited = once(child, "exit")
    child.kill("SIGKILL")
    await exited
  })
  const table = processTable()
  assert.deepEqual(table.get(recorded.pid), processStates([recorded.pid]).get(recorded.pid))
  assert.equal(table.get(recorded.grandchild)?.parent, recorded.pid)
  const below = descendantsOf(table, process.pid)
  assert.ok(below.indexOf(recorded.pid) >= 0 && below.indexOf(recorded.pid) < below.indexOf(recorded.grandchild),
    "a child is listed before its own child")
  assert.deepEqual(descendantsOf(table, recorded.pid), [recorded.grandchild])
  assert.deepEqual(descendantsOf(table, recorded.grandchild), [])
  assert.equal(descendantsOf(table, recorded.pid).includes(process.pid), false)
})

test("a process's own view of its pid is the innermost NSpid entry on Linux and its pid elsewhere", () => {
  const status = (line) => (path) => {
    assert.equal(path, "/proc/4242/status")
    return `Name:\tnode\n${line}Pid:\t4242\n`
  }
  // bubblewrap's first sandboxed command, seen from the host.
  assert.equal(selfReportedPid(4242, "linux", status("NSpid:\t4242\t2\n")), 2)
  assert.equal(selfReportedPid(4242, "linux", status("NSpid:\t4242\t17\t2\n")), 2)
  // Not in a nested namespace, and a kernel that reports no NSpid line.
  assert.equal(selfReportedPid(4242, "linux", status("NSpid:\t4242\n")), 4242)
  assert.equal(selfReportedPid(4242, "linux", status("")), 4242)
  // The process exited between the table and the read.
  assert.equal(selfReportedPid(4242, "linux", () => { throw new Error("ENOENT") }), undefined)
  assert.equal(selfReportedPid(4242, "darwin", () => { throw new Error("never read off Linux") }), 4242)
  assert.equal(selfReportedPid(process.pid), process.pid)
})
