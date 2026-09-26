/**
 * One private temporary root per test process, removed when the process ends.
 *
 * `claim()` makes `tui-run-<pid>-XXXXXX` under the current temporary
 * directory and points `TMPDIR` at it, so every `mkdtemp(tmpdir())` in a case,
 * every child the case spawns, and every `zmuxd` socket land inside it.
 * Release kills any `zmuxd` whose socket is under the root, then deletes the
 * root. A test run calls it from a global `afterAll`, which Bun still runs
 * after a timed-out case; `bun test` never emits `exit`, so that hook only
 * serves plain scripts. SIGINT, SIGTERM and SIGHUP release it too.
 *
 * A SIGKILLed run cannot clean up after itself, so `claim()` first sweeps
 * sibling roots whose owning pid is gone, daemons included.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PREFIX = "tui-run-"

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Every `zmuxd` serving a socket under `root`, and the processes it runs. */
export const daemons = (root: string): ReadonlyArray<number> => {
  const listing = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" }).stdout ?? ""
  const rows = listing.split("\n").map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter((row) =>
    row !== null
  )
  const owned = new Set(
    rows
      .filter((row) => /(^|\/)zmuxd\s/.test(row[3]!) && row[3]!.includes(`--socket ${root}/`))
      .map((row) => Number(row[1]))
  )
  for (const row of rows) if (owned.has(Number(row[2]))) owned.add(Number(row[1]))
  return [...owned]
}

const kill = (root: string) => {
  for (const pid of daemons(root)) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Already gone.
    }
  }
}

/** Removes sibling roots whose run died without releasing them. */
export const sweep = (base: string) => {
  let entries: Array<string>
  try {
    entries = readdirSync(base)
  } catch {
    return
  }
  for (const entry of entries) {
    const owner = entry.startsWith(PREFIX) ? Number(entry.slice(PREFIX.length).split("-")[0]) : NaN
    if (!Number.isInteger(owner) || owner === process.pid || alive(owner)) continue
    const root = join(base, entry)
    kill(root)
    rmSync(root, { recursive: true, force: true })
  }
}

/** Points `TMPDIR` at a fresh private root; the returned function releases it. */
export const claim = (): () => void => {
  const base = tmpdir()
  sweep(base)
  const root = mkdtempSync(join(base, `${PREFIX}${process.pid}-`))
  const previous = process.env.TMPDIR
  process.env.TMPDIR = root
  let released = false
  const release = () => {
    if (released) return
    released = true
    kill(root)
    rmSync(root, { recursive: true, force: true })
    if (previous === undefined) delete process.env.TMPDIR
    else process.env.TMPDIR = previous
  }
  process.once("exit", release)
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
    process.once(signal, () => {
      release()
      process.exit(code)
    })
  }
  return release
}
