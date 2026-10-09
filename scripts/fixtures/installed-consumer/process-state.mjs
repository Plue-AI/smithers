/** One targeted kernel snapshot for a fixture's parent, group and stop assertions. */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"

const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/

/**
 * Every process the host reports, keyed by host pid.
 *
 * A fixture process can only say what pid it has in its own PID namespace. On
 * Linux an approved command is confined in one (bubblewrap, #3140), so the pid
 * it writes down is 2, and the host's pid 2 is a kernel thread. This table is
 * how a fixture finds its processes from the host side instead.
 */
export const processTable = () => {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,stat="], {
    encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024
  })
  assert.equal(result.error, undefined, `Process table failed: ${result.error?.message ?? ""}\n${result.stderr}`)
  assert.equal(result.status, 0, result.stderr)
  const table = new Map()
  for (const line of result.stdout.split("\n").filter((entry) => entry.trim() !== "")) {
    const match = row.exec(line)
    assert.ok(match, `Invalid process table row: ${line}`)
    const [, pid, parent, group, state] = match
    table.set(Number(pid), { parent: Number(parent), group: Number(group), stopped: state.startsWith("T") })
  }
  return table
}

/** The host pids below `root` in one table, nearest generation first. */
export const descendantsOf = (table, root) => {
  const found = []
  let generation = [root]
  while (generation.length > 0) {
    const next = []
    for (const [pid, { parent }] of table) if (generation.includes(parent)) next.push(pid)
    found.push(...next)
    generation = next
  }
  return found
}

/**
 * The pid the process with host pid `pid` sees as its own.
 *
 * Linux lists a process's pid in every nested PID namespace on the `NSpid`
 * line of its status file, outermost first, so the last entry is what
 * `process.pid` returns inside. Other platforms have one pid per process.
 * `undefined` means the process is gone.
 */
export const selfReportedPid = (pid, platform = process.platform, read = readFileSync) => {
  if (platform !== "linux") return pid
  let status
  try { status = read(`/proc/${pid}/status`, "utf8") } catch { return undefined }
  const line = /^NSpid:\s+(\d+(?:\s+\d+)*)\s*$/m.exec(status)
  return line === null ? pid : Number(line[1].split(/\s+/).at(-1))
}

export const processStates = (pids) => {
  const selected = new Set(pids)
  assert.ok(selected.size > 0)
  for (const pid of selected) assert.ok(Number.isSafeInteger(pid) && pid > 1, `Invalid fixture PID: ${pid}`)
  // A mixed shell/MCP assertion replaces at least four separate ps calls.
  // Use the production identity probe's 5 s allowance for their one snapshot;
  // never turn an execution failure into an apparently missing parent PID.
  const result = spawnSync("/bin/ps", ["-o", "pid=,ppid=,pgid=,stat=", "-p", [...selected].join(",")], {
    encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL"
  })
  assert.equal(result.error, undefined, `Process snapshot failed: ${result.error?.message ?? ""}\n${result.stderr}`)
  if (result.status === 1 && result.stdout.trim() === "" && result.stderr.trim() === "") return new Map()
  assert.equal(result.status, 0, result.stderr)
  const states = new Map()
  for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
    const match = row.exec(line)
    assert.ok(match, `Invalid process snapshot row: ${line}`)
    const [, pid, parent, group, state] = match
    assert.ok(selected.has(Number(pid)), `Unrequested process in snapshot: ${pid}`)
    states.set(Number(pid), { parent: Number(parent), group: Number(group), stopped: state.startsWith("T") })
  }
  return states
}
