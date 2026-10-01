/**
 * #3342: an explicit `runs resume` of a run whose live detached host parked it
 * over lease-lapsed releases. The CLI hands the resume, with the operator's
 * per-release consent (#2982), to the host that parked the run, and returns
 * with the run's new status. It neither refuses (`ClaimLost`) nor takes the
 * run from the live host and drives it in the foreground.
 *
 * Real CLI processes over one project: a `flow start --detached` host runs a
 * module flow whose child spawns an external worker. The host stalls past its
 * lease (SIGSTOP) while its store is too busy to reconfirm ownership, as on a
 * loaded machine, so on SIGCONT it releases that child. The test only holds
 * the store's write lock; it writes no durable row.
 */
import { spawn } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it } from "vitest"

const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))
const judge = new URL("./fixtures/scripted-native-host.ts", import.meta.url).href
const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-detached-resume-")))
const home = join(root, "isolated-home")
mkdirSync(join(root, "flows", "external-peer"), { recursive: true })
mkdirSync(join(root, ".flows"), { recursive: true })
mkdirSync(home, { recursive: true })
symlinkSync(fileURLToPath(new URL("../../../node_modules", import.meta.url)), join(root, "node_modules"), "dir")
for (
  const [fixture, target] of [
    ["detached-resume-flow.ts", "flow.ts"],
    ["external-peer-flow.ts", "external-peer-flow.ts"]
  ] as const
) {
  copyFileSync(
    fileURLToPath(new URL(`./fixtures/${fixture}`, import.meta.url)),
    join(root, "flows", "external-peer", target)
  )
}

interface Invocation {
  readonly status: number | null
  readonly stdout: string
  readonly stderr: string
  readonly elapsedMs: number
}

const smithers = (...args: ReadonlyArray<string>): Promise<Invocation> =>
  new Promise((resolve, reject) => {
    const started = Date.now()
    const child = spawn(process.execPath, ["--import", judge, "--no-warnings", executable, ...args, "--json"], {
      cwd: root,
      env: { ...process.env, SMITHERS_HOME: home },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr.on("data", (chunk) => (stderr += String(chunk)))
    // The #3342 symptom was a resume that held the terminal for minutes.
    const limit = setTimeout(() => child.kill("SIGKILL"), 120_000)
    child.once("error", reject)
    child.once("exit", (status) => {
      clearTimeout(limit)
      resolve({ status, stdout, stderr, elapsedMs: Date.now() - started })
    })
  })

const poll = async (predicate: () => boolean, label: string, timeoutMs = 90_000) => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}; rows=${JSON.stringify(rows())}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
const workers = (): Array<{ readonly pid: number; readonly owner: number }> =>
  existsSync(join(root, "spawns"))
    ? readFileSync(join(root, "spawns"), "utf8").split("\n").slice(0, -1).filter(Boolean).map((line) =>
      JSON.parse(line)
    )
    : []
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const rows = () => {
  if (!existsSync(join(root, ".flows", "engine.db"))) return []
  // The live host writes this file; wait out its write lock rather than fail the read.
  const db = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true, timeout: 10_000 })
  try {
    return db.prepare("SELECT run_id, status, waiting_reason FROM flows_runs").all() as unknown as Array<
      { readonly run_id: string; readonly status: string; readonly waiting_reason: string | null }
    >
  } finally {
    db.close()
  }
}
const released = () => rows().some((row) => row.run_id.endsWith("/worker") && row.waiting_reason === "released")

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Stalls the host past its lease while its store stays busy, and waits for it
 * to release its worker. A live owner reconfirms a lease after a stall alone
 * (#3372). Holding the write lock past SIGCONT makes that reconfirmation miss
 * its one-heartbeat bound, so the lease lapses. The host's other writes retry
 * and land once the lock is gone.
 */
const stall = async (host: number, worker: number) => {
  const lock = new DatabaseSync(join(root, ".flows", "engine.db"), { timeout: 10_000 })
  try {
    lock.exec("BEGIN IMMEDIATE")
    process.kill(host, "SIGSTOP")
    await sleep(20_000)
    process.kill(host, "SIGCONT")
    await sleep(4_000)
  } finally {
    if (lock.isTransaction) lock.exec("ROLLBACK")
    lock.close()
  }
  await poll(() => !alive(worker), "lease-lapsed worker stopped")
  await poll(released, "worker released")
}

/** No restart without an explicit resume, and none from consent given for an earlier release. */
const staysParked = async (count: number) => {
  for (let tick = 0; tick < 6; tick++) {
    expect(workers()).toHaveLength(count)
    expect(released()).toBe(true)
    await sleep(500)
  }
}

const resume = async (runId: string, host: number) => {
  const resumed = await smithers("runs", "resume", runId)
  // Before #3342 this refused with `claim_lost` while the parking host lived.
  expect(resumed.stdout + resumed.stderr).not.toMatch(/claim_lost|ClaimLost|All fibers interrupted/)
  expect({ status: resumed.status, stdout: resumed.stdout, stderr: resumed.stderr }).toMatchObject({ status: 0 })
  // The CLI hands the run over and returns; it does not wait for the run.
  expect(resumed.elapsedMs).toBeLessThan(60_000)
  const receipt = JSON.parse(resumed.stdout)
  process.stdout.write(`runs resume (${resumed.elapsedMs} ms): ${JSON.stringify(receipt)}\n`)
  expect(receipt).toMatchObject({ _tag: "Accepted", runId, handedTo: { pid: host } })
  expect(["accepted", "running", "parked"]).toContain(receipt.status)
  // Reported after the host re-admitted the released worker, so it does not ask for another resume.
  expect(receipt.waitingReason).not.toBe("released")
  return receipt
}

let host: number | undefined
afterAll(() => {
  for (const pid of [host, ...workers().map((worker) => worker.pid)]) {
    if (pid === undefined) continue
    try {
      process.kill(pid, "SIGCONT")
      process.kill(pid, "SIGKILL")
    } catch {}
  }
  rmSync(root, { recursive: true, force: true })
})

describe("explicit resume of a live detached host's lease-lapsed park", { timeout: 420_000 }, () => {
  it("hands each explicit resume to the live host, which retries only that release", async () => {
    const started = await smithers("flow", "start", "external-peer", "--detached", "--data", JSON.stringify({ root }))
    expect({ status: started.status, stderr: started.stderr }).toMatchObject({ status: 0 })
    const { runId } = JSON.parse(started.stdout) as { readonly runId: string }
    await poll(() => workers().length === 1, "external worker started")
    const first = workers()[0]!
    // The external worker is a child of the process that executes it.
    host = first.owner
    await poll(() => rows().find((row) => row.run_id === runId)?.status === "suspended", "root parked")

    await stall(host, first.pid)
    await staysParked(1)
    await resume(runId, host)
    await poll(() => workers().length === 2, "the live host retries the released worker")
    // The live host executed it; the resuming CLI did not take the run.
    expect(workers()[1]!.owner).toBe(host)
    expect(alive(host)).toBe(true)

    // A later lapse is a new release. The first consent does not cover it,
    // and a second explicit resume is a new request, not a replay.
    await stall(host, workers()[1]!.pid)
    await staysParked(2)
    await resume(runId, host)
    await poll(() => workers().length === 3, "the second resume retries the second release")
    expect(workers()[2]!.owner).toBe(host)

    writeFileSync(join(root, "release"), "finish")
    await poll(() => rows().every((row) => row.status === "completed"), "run completes on its host")
    expect(workers()).toHaveLength(3)
  })
})
