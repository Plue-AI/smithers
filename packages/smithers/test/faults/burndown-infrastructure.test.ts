/** #3367: real public CLI, SQLite, durable children, DNS, sockets and external agents. */
import { AssertionError } from "node:assert"
import { type ChildProcess, execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createSocket } from "node:dgram"
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statfsSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { assertRecovery } from "./fixtures/burndown/recovery.ts"

const fixture = fileURLToPath(new URL("./fixtures/burndown", import.meta.url))
const bin = fileURLToPath(new URL("../../src/bin.ts", import.meta.url))
const preload = join(fixture, "preload.mjs") // Only installs the repository's Effect resolution loader.
const modules = fileURLToPath(new URL("../../node_modules", import.meta.url))
const owner = fileURLToPath(new URL("../../../../flows/issue-sweep/", import.meta.url))
const roots: string[] = []
const reaped = new Set<string>()
const assertionTests = new Set<string>()
const compileCache = realpathSync(mkdtempSync(join(tmpdir(), "fault-3367-compile-")))
const hosts: Array<{ root: string; host: ChildProcess; done: Promise<Exit> }> = []
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const json = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value, null, 2))
const lines = <A = Record<string, unknown>>(path: string): A[] =>
  existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) :
    []
interface RecordRow {
  event: string
  index: string
  pid: number
  at: number
  code?: number
}
interface RunRow {
  run_id: string
  status: string
  waiting_reason: string | null
  state_json: string
}
interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}
const records = (root: string) => lines<RecordRow>(join(root, "processes.jsonl"))
const ids = (count: number) => Array.from({ length: count }, (_, n) => String(n + 1))
const wait = async (predicate: () => boolean, label: string, ms = 180_000) => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw Error(`Harness deadline: ${label}`)
    await delay(100)
  }
}
const copyOwner = (root: string, name: string, destination: string) => {
  const original = readFileSync(join(owner, name))
  cpSync(join(owner, name), destination)
  expect(readFileSync(destination).equals(original), `exact original bytes: ${name}`).toBe(true)
  appendFileSync(
    join(root, "source-receipts.jsonl"),
    JSON.stringify({
      source: `flows/issue-sweep/${name}`,
      bytes: original.length,
      sha256: createHash("sha256").update(original).digest("hex")
    }) + "\n"
  )
}
const make = (name: string) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `fault-3367-${name}-`)))
  roots.push(root)
  cpSync(fixture, root, { recursive: true })
  json(join(root, "runtime.json"), { node: process.version, platform: process.platform, arch: process.arch })
  const keep = new Set(["burndown", ...(name === "identity" ? ["reuse"] : name === "source" ? ["live"] : [])])
  for (const name of readdirSync(join(root, "flows"))) {
    if (!keep.has(name)) rmSync(join(root, "flows", name), { recursive: true })
  }
  copyOwner(root, "host.ts", join(root, "flows", "burndown", "host.ts"))
  mkdirSync(join(root, ".flows"))
  mkdirSync(join(root, "node_modules"))
  for (const name of readdirSync(modules).filter((name) => !name.startsWith("."))) {
    symlinkSync(join(modules, name), join(root, "node_modules", name), "dir")
  }
  // All explicit jj commands are under vcs_lock.py. CI uses the portable test fallback.
  const lock = join(homedir(), "Smithers-Ops", "dispatch", "vcs_lock.py")
  const script = join(root, "init-jj.sh")
  writeFileSync(script, `#!/bin/sh\nexec jj git init '${root.replaceAll("'", "'\\''")}'\n`, { mode: 0o755 })
  execFileSync("python3", [existsSync(lock) ? lock : join(root, "vcs_lock.py"), "smithers", script], {
    stdio: "pipe",
    timeout: 60_000
  })
  writeFileSync(
    join(root, ".gitignore"),
    ".flows/\nprocesses.jsonl\nnetwork*.jsonl\nchange-*\nlanded\n*.log\nrecovery.json\n"
  )
  return root
}
const launch = (root: string, seconds = 2, count = 2, flow = "burndown") => {
  expect(Number.isInteger(count) && count >= 2).toBe(true)
  const args = [
    "--no-warnings",
    "--import",
    preload,
    bin,
    "flow",
    "start",
    flow,
    "--data",
    JSON.stringify({ root, seconds, count, modelProbe: existsSync(join(root, "model-network.json")) }),
    "--wait",
    "--json"
  ]
  appendFileSync(join(root, "commands.jsonl"), JSON.stringify({ args, at: Date.now() }) + "\n")
  reaped.delete(root)
  const host = spawn(process.execPath, args, {
    cwd: root,
    detached: true,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "config"),
      NODE_OPTIONS: "",
      NODE_COMPILE_CACHE: compileCache,
      SMITHERS_FLOW_LOAD_TIMEOUT_MS: "30000",
      SMITHERS_REMOTE: "",
      AI_GATEWAY_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  const number = hosts.length + 1
  let stdout = "", stderr = "", timedOut = false
  host.stdout!.on("data", (chunk) => {
    stdout += chunk
  })
  host.stderr!.on("data", (chunk) => {
    stderr += chunk
  })
  const timer = setTimeout(() => {
    timedOut = true
    if (host.pid) {
      try {
        process.kill(-host.pid, "SIGCONT")
      } catch {}
      try {
        process.kill(-host.pid, "SIGKILL")
      } catch {}
    }
  }, 240_000)
  const done = new Promise<Exit>((resolve, reject) => {
    host.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    host.once("close", (code, signal) => {
      clearTimeout(timer)
      writeFileSync(join(root, `cli-${number}.stdout.log`), stdout)
      writeFileSync(join(root, `cli-${number}.stderr.log`), stderr)
      json(join(root, `cli-${number}.exit.json`), { code, signal, timedOut })
      resolve({ code, signal, timedOut })
    })
  })
  hosts.push({ root, host, done })
  return { host, done, output: () => ({ stdout, stderr }) }
}
const completed = async (run: ReturnType<typeof launch>, code: number) => {
  const exit = await run.done
  expect(exit, JSON.stringify(run.output())).toEqual({ code, signal: null, timedOut: false })
}
const rows = (root: string): RunRow[] => {
  const path = join(root, ".flows", "engine.db")
  if (!existsSync(path)) return []
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    return db.prepare("select run_id, status, waiting_reason, state_json from flows_runs order by run_id")
      .all() as unknown as RunRow[]
  } finally {
    db.close()
  }
}
interface AttemptRow {
  step_key_digest: string
  attempt: number
  state: string
  outcome_json: string | null
  error_json: string | null
}
const attempts = (root: string): AttemptRow[] => {
  const db = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
  try {
    return db.prepare(
      "select step_key_digest, attempt, state, outcome_json, error_json from flows_attempts order by step_key_digest, attempt"
    )
      .all() as unknown as AttemptRow[]
  } finally {
    db.close()
  }
}
const processTable = () =>
  execFileSync("ps", ["-axo", "pid=,ppid=,stat=,command="], { encoding: "utf8", timeout: 15_000 })
    .split("\n").flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), state: match[3]!, command: match[4]! }] : []
    })
const owned = (root: string) => {
  const table = processTable()
  const hostPids = new Set(hosts.filter((item) => item.root === root).map((item) => item.host.pid))
  const selected = table.filter((row) =>
    (hostPids.has(row.pid) && row.command.includes(bin) && row.command.includes(root)) ||
    row.command.includes(`${root}/agent.mjs`) || row.command.includes(`${root}/network.mjs`) ||
    row.command.includes(`${root}/init-jj.sh`) || row.command.endsWith(`jj git init ${root}`)
  )
  // Retain and reap descendants even if the external agent has not written its start receipt.
  for (let n = 0; n < table.length; n++) {
    const descendants = table.filter((row) =>
      selected.some((parent) => parent.pid === row.ppid) && !selected.some((item) => item.pid === row.pid)
    )
    if (!descendants.length) break
    selected.push(...descendants)
  }
  return selected
}
const reap = async (root: string) => {
  if (reaped.has(root)) return
  const before = owned(root)
  const signal = (pid: number, name: NodeJS.Signals) => {
    try {
      process.kill(pid, name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
  // Always continue stopped hosts AND descendants before graceful shutdown.
  for (const row of before) signal(row.pid, "SIGCONT")
  for (const row of before) signal(row.pid, "SIGTERM")
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
      return false
    }
  }
  const deadline = Date.now() + 3000
  while (before.some((row) => alive(row.pid)) && Date.now() < deadline) await delay(100)
  const hardKilled = before.some((row) => alive(row.pid)) ? owned(root) : []
  for (const row of hardKilled) signal(row.pid, "SIGKILL")
  await wait(() => !hardKilled.some((row) => alive(row.pid)), "all owned host/agent/descendant exits", 5000)
  await Promise.all(hosts.filter((item) => item.root === root).map((item) => item.done))
  const remaining = before.length ? owned(root) : []
  expect(remaining, "all owned host/agent/descendant exits").toEqual([])
  const cleanup = { before, hardKilled, remaining }
  json(join(root, "cleanup.json"), cleanup)
  appendFileSync(join(root, "cleanup.jsonl"), JSON.stringify(cleanup) + "\n")
  reaped.add(root)
}
const observe = (root: string, count: number, invocations = 1) => {
  const log = records(root)
  const runRows = rows(root)
  const children = runRows.filter((row) => JSON.parse(row.state_json).flowName === "burndown/Child")
  const indices = ids(count)
  const landOrder = existsSync(join(root, "landed"))
    ? readFileSync(join(root, "landed"), "utf8").trim().split("\n")
    : []
  const perIndex = (index: string) => ({
    events: log.filter((row) => row.index === index).map((row) => row.event),
    starts: log.filter((row) => row.index === index && row.event === "start").length,
    progress: log.filter((row) => row.index === index && row.event === "progress").length,
    dones: log.filter((row) => row.index === index && row.event === "done").length,
    exitCodes: log.filter((row) => row.index === index && row.event === "exit").map((row) => row.code),
    pids: new Set(log.filter((row) => row.index === index).map((row) => row.pid)).size
  })
  let active = 0, ordered = landOrder.length === count
  for (const row of log) {
    if (row.event === "lock") {
      active++
      if (active !== 1) ordered = false
    }
    if (row.event === "unlock") {
      active--
      if (active !== 0) ordered = false
    }
    if (row.event === "start" && row.index.startsWith("land-")) {
      if (
        !indices.every((index) =>
          log.findIndex((item) => item.index === index && item.event === "done") >= 0
          && log.findIndex((item) => item.index === index && item.event === "done") < log.indexOf(row)
        )
      ) ordered = false
    }
  }
  return {
    count,
    invocations,
    runCount: runRows.length,
    runStatuses: runRows.map((row) => row.status).sort(),
    childIds: children.map((row) => String(JSON.parse(row.state_json).payload.index)).sort(),
    childStatuses: children.map((row) => row.status).sort(),
    work: indices.map((index) => ({
      index,
      ...perIndex(index),
      content: existsSync(join(root, `change-${index}`)) ? readFileSync(join(root, `change-${index}`), "utf8") : null
    })),
    landing: indices.map((index) => ({ index, ...perIndex(`land-${index}`) })),
    landOrder,
    serialLandingAfterAllDone: ordered && active === 0,
    distinctAgentPids: new Set(log.filter((row) => row.event === "start").map((row) => row.pid)).size,
    unexpectedIds: log.filter((row) => ![...indices, ...indices.map((index) => `land-${index}`)].includes(row.index))
      .map((row) => row.index),
    manualResumes:
      lines<{ args: string[] }>(join(root, "commands.jsonl")).filter((row) => row.args.includes("resume")).length
  }
}
const desired = (count: number, invocations = 1) => ({
  count,
  invocations,
  runCount: count + 2 * invocations,
  runStatuses: Array(count + 2 * invocations).fill("completed"),
  childIds: ids(count).sort(),
  childStatuses: Array(count).fill("completed"),
  work: ids(count).map((index) => ({
    index,
    events: ["start", "progress", "work-done", "done", "exit"],
    starts: 1,
    progress: 1,
    dones: 1,
    exitCodes: [0],
    pids: 1,
    content: `work-${index}`
  })),
  landing: ids(count).map((index) => ({
    index,
    events: ["start", "lock", "unlock", "done", "exit"],
    starts: 1,
    progress: 0,
    dones: 1,
    exitCodes: [0],
    pids: 1
  })),
  landOrder: ids(count),
  serialLandingAfterAllDone: true,
  distinctAgentPids: count * 2,
  unexpectedIds: [],
  manualResumes: 0
})
// Every fault also validates exact current work/uniqueness/order outside the expected-red assertion.
const integrity = (
  root: string,
  count: number,
  started: boolean,
  done: boolean | string[],
  landed: boolean,
  interrupted = false
) => {
  const actual = observe(root, count)
  const finished = (index: string) => Array.isArray(done) ? done.includes(index) : done
  expect(actual.unexpectedIds).toEqual([])
  expect(actual.manualResumes).toBe(0)
  expect(actual.work).toEqual(
    ids(count).map((index) => ({
      index,
      events: !started
        ? []
        : finished(index)
        ? ["start", "progress", "work-done", "done", "exit"]
        : interrupted
        ? ["start", "progress", "cancel", "exit"]
        : ["start", "progress", "work-done", "exit"],
      starts: Number(started),
      progress: Number(started),
      dones: Number(finished(index)),
      exitCodes: !started ? [] : finished(index) ? [0] : interrupted ? [143] : [1],
      pids: Number(started),
      content: started ? `work-${index}` : null
    }))
  )
  expect(actual.work.every((row) => row.exitCodes.length === Number(started))).toBe(true)
  expect(actual.landing).toEqual(
    ids(count).map((index) => ({
      index,
      events: landed ? ["start", "lock", "unlock", "done", "exit"] : [],
      starts: Number(landed),
      progress: 0,
      dones: Number(landed),
      exitCodes: landed ? [0] : [],
      pids: Number(landed)
    }))
  )
  expect(actual.landOrder).toEqual(landed ? ids(count) : [])
  expect(actual.distinctAgentPids).toBe((Number(started) + Number(landed)) * count)
  if (landed) expect(actual.serialLandingAfterAllDone).toBe(true)
}
const receipt = (root: string, count: number, invocations = 1) => {
  const value = { actual: observe(root, count, invocations), desired: desired(count, invocations) }
  json(join(root, "recovery.json"), value)
  json(join(root, "runs.json"), rows(root))
  console.log("FAULT_3367_RECEIPT", JSON.stringify({ root, ...value }))
  // Raw diagnostic writes belong to this ordinary setup test, outside it.fails.
  try {
    assertRecovery(value)
  } catch (error) {
    // Only a desired-assertion mismatch is recorded; any other error fails setup.
    if (!(error instanceof AssertionError)) throw error
    writeFileSync(join(root, "desired-assertion.log"), error.stack ?? error.message)
    console.log("FAULT_3367_DESIRED_ASSERTION", error.message)
  }
  return value
}
// Registered it.fails pins are explained in scripts/test-pins.md. RAW executes identical assertions normally.
const knownRed = (title: string, assertion: () => void) => {
  assertionTests.add(title)
  if (process.env.FAULT_3367_RAW === "1") it(title, assertion)
  else it.fails(title, assertion)
}

afterEach(async (context) => {
  // Never invert a cleanup/hook failure with a desired-assertion pin.
  if (assertionTests.has(context.task.name)) return
  for (const root of roots) await reap(root)
})
afterAll(async () => {
  const failures: unknown[] = []
  for (const root of roots) {
    try {
      await reap(root)
      if (process.env.FAULT_3367_RECEIPTS) {
        const destination = join(process.env.FAULT_3367_RECEIPTS, basename(root))
        cpSync(root, destination, {
          recursive: true,
          filter: (source) => !["node_modules", ".jj", "volume", "pressure.dmg", "config"].includes(basename(source))
        })
        console.log("FAULT_3367_PRESERVED", destination)
      }
    } catch (error) {
      failures.push(error)
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    }
  }
  rmSync(compileCache, { recursive: true, force: true })
  if (failures.length) throw new AggregateError(failures, "fault cleanup/receipt preservation failed")
})

it("positive control finishes N=3 durable children exactly once and lands in order", async () => {
  const root = make("control")
  const run = launch(root, 2, 3)
  await completed(run, 0)
  await reap(root)
  integrity(root, 3, true, true, true)
  assertRecovery(receipt(root, 3))
}, 360_000)

describe("host stall", () => {
  it("#3328 #3372 host stall reconfirms ownership and completes N=2 without manual resume", async () => {
    const root = make("host")
    const run = launch(root, 45)
    await wait(() => records(root).filter((row) => row.event === "progress").length === 2, "N=2 children running")
    expect(rows(root).filter((row) => row.status === "running")).toHaveLength(4)
    try {
      process.kill(run.host.pid!, "SIGSTOP")
      await wait(
        () => processTable().some((row) => row.pid === run.host.pid && row.state.includes("T")),
        "host actually stopped"
      )
      await delay(23_000) // Real wall-clock >19-second ownership lease tolerance.
    } finally {
      process.kill(run.host.pid!, "SIGCONT")
    }
    await completed(run, 0)
    await reap(root)
    integrity(root, 2, true, true, true)
    assertRecovery(receipt(root, 2))
    const db = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
    try {
      const frames = (db.prepare("select run_id, payload_json from flows_journal_events").all() as unknown as Array<
        { run_id: string; payload_json: string }
      >)
        .map((row) => ({ runId: row.run_id, payload: JSON.parse(row.payload_json) }))
      const reconfirmed = frames.filter((row) => row.payload.decision === "lease-reconfirmed")
      expect(reconfirmed.map((row) => row.runId).sort()).toEqual(rows(root).map((row) => row.run_id).sort())
      expect(reconfirmed.every((row) => row.payload.detail.unconfirmedMs >= 19000)).toBe(true)
      expect(frames.filter((row) => row.payload.decision === "interrupt-released")).toEqual([])
      json(join(root, "lease-receipt.json"), reconfirmed)
    } finally {
      db.close()
    }
  }, 360_000)
})

describe("slow body load", () => {
  it("#3359 a 31-second real module load retries catalog admission and completes N=2", async () => {
    const root = make("load")
    const source = join(root, "flows", "burndown", "flow.ts")
    const evaluations = JSON.stringify(join(root, "load-evaluations.jsonl"))
    writeFileSync(
      source,
      readFileSync(source, "utf8").replace(
        "// A real module evaluation delay;",
        `appendFileSync(${evaluations}, JSON.stringify({ event: "start", at: Date.now() }) + "\\n")\n`
          + "await new Promise(resolve => setTimeout(resolve, 31000))\n"
          + `appendFileSync(${evaluations}, JSON.stringify({ event: "end", at: Date.now() }) + "\\n")\n`
          + "// A real module evaluation delay;"
      )
    )
    const run = launch(root, 1)
    await completed(run, 0)
    const loads = lines<{ event: string; at: number }>(join(root, "load-evaluations.jsonl"))
    expect(loads.filter((row) => row.event === "start")).toHaveLength(2)
    expect(loads.filter((row) => row.event === "end")).toHaveLength(2)
    const starts = loads.filter((row) => row.event === "start")
    const ends = loads.filter((row) => row.event === "end")
    expect(starts[1]!.at - starts[0]!.at).toBeGreaterThanOrEqual(30000)
    expect(ends.every((row, n) => row.at - starts[n]!.at >= 31000)).toBe(true)
    expect(records(root).every((row) => row.at >= ends[1]!.at)).toBe(true)
    await reap(root)
    integrity(root, 2, true, true, true)
    assertRecovery(receipt(root, 2))
  }, 360_000)
})

for (const boundary of ["model", "landing"] as const) {
  describe(`${boundary} external action DNS loss`, () => {
    it("restores SAME hostname URL after actual DNS failure and automatically completes once-only work", async () => {
      const root = make(boundary)
      const queries: unknown[] = [], requests: unknown[] = []
      let available = true
      const dns = createSocket("udp4")
      const http = createServer((request, response) => {
        requests.push({ host: request.headers.host, url: request.url, at: Date.now() })
        response.end("available")
      })
      // Minimal authoritative A responder: real c-ares Resolver traffic, zero host DNS changes.
      dns.on("message", (query, remote) => {
        let end = 12
        const labels: string[] = []
        while (query[end]) {
          const length = query[end]!
          labels.push(query.subarray(end + 1, end + 1 + length).toString())
          end += length + 1
        }
        end += 5
        queries.push({ hostname: labels.join("."), available, at: Date.now(), type: query.readUInt16BE(end - 4) })
        const header = Buffer.from(query.subarray(0, 12))
        header.writeUInt16BE(available ? 0x8180 : 0x8183, 2) // NXDOMAIN during outage, A=127.0.0.1 after restoration.
        header.writeUInt16BE(1, 4)
        header.writeUInt16BE(available ? 1 : 0, 6)
        header.writeUInt32BE(0, 8)
        const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, 127, 0, 0, 1])
        dns.send(
          Buffer.concat([header, query.subarray(12, end), ...(available ? [answer] : [])]),
          remote.port,
          remote.address
        )
      })
      try {
        await new Promise<void>((resolve, reject) => {
          dns.once("error", reject)
          dns.bind(0, "127.0.0.1", resolve)
        })
        await new Promise<void>((resolve, reject) => {
          http.once("error", reject)
          http.listen(0, "127.0.0.1", resolve)
        })
        const url = `http://fault-3367-${boundary}.test:${(http.address() as AddressInfo).port}/${boundary}`
        const configuration = JSON.stringify({ url, server: `127.0.0.1:${(dns.address() as AddressInfo).port}` })
        writeFileSync(join(root, `${boundary}-network.json`), configuration)
        const probe = async () => {
          const child = spawn(process.execPath, [join(root, "network.mjs"), root, boundary], {
            stdio: ["ignore", "pipe", "pipe"]
          })
          let stdout = "", stderr = ""
          child.stdout!.on("data", (data) => {
            stdout += data
          })
          child.stderr!.on("data", (data) => {
            stderr += data
          })
          const timer = setTimeout(() => child.kill("SIGKILL"), 15_000)
          const code = await new Promise<number | null>((resolve, reject) => {
            child.once("error", reject)
            child.once("close", resolve)
          })
          clearTimeout(timer)
          expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
          expect(stdout.trim()).toBe("available")
        }
        await probe() // Healthy same operation before fault.
        available = false
        const down = Date.now()
        const run = launch(root, 1)
        await wait(
          () => lines<{ event: string }>(join(root, "network.jsonl")).some((row) => row.event === "failure"),
          "actual DNS failure before service restoration"
        )
        await wait(
          () => records(root).filter((row) => row.event === "exit" && row.code === 0).length === 2,
          "both long-lived workers successfully exited before network recovery"
        )
        expect(rows(root).some((row) => row.status === "running")).toBe(true)
        expect(rows(root).some((row) => row.status === "failed")).toBe(false)
        expect(records(root).filter((row) => row.event === "done").map((row) => row.index).sort()).toEqual(ids(2))
        expect(records(root).some((row) => row.index.startsWith("land-"))).toBe(false)
        let workBefore: AttemptRow[] = []
        if (boundary === "model") {
          await wait(
            () => attempts(root).some((row) => row.error_json?.includes("@smthrs/kernel/Unreachable")),
            "real typed DNS failure persisted in durable probe attempt"
          )
          workBefore = attempts(root).filter((row) => ["\"1\"", "\"2\""].includes(row.outcome_json ?? ""))
          expect(
            workBefore.map(({ attempt, state, outcome_json }) => ({ attempt, state, outcome_json }))
              .sort((a, b) => a.outcome_json!.localeCompare(b.outcome_json!))
          )
            .toEqual(["\"1\"", "\"2\""].map((outcome_json) => ({ attempt: 1, state: "succeeded", outcome_json })))
        }
        const failures = lines<{ event: string; code?: string; url: string }>(join(root, "network.jsonl")).filter(
          (row) => row.event === "failure"
        )
        expect(failures.length).toBeGreaterThanOrEqual(1)
        expect(failures.every((row) => row.code === "ENOTFOUND" && row.url === url)).toBe(true)
        available = true
        expect(readFileSync(join(root, `${boundary}-network.json`), "utf8")).toBe(configuration)
        await probe() // Same Resolver -> socket code, same hostname and URL now succeeds standalone.
        await completed(run, 0)
        await delay(2000)
        if (boundary === "landing") {
          // Actual owning Fault.retryTransient remains active and retries after real service restoration.
          expect(readFileSync(join(root, "landing-attempts"), "utf8").trim().split("\n")).toEqual([
            ...Array(failures.length + 1).fill("1"),
            "2"
          ])
        }
        const successes = boundary === "model" ? 3 : 4
        expect(requests).toHaveLength(successes)
        expect(queries).toHaveLength(failures.length + successes)
        expect(
          (queries as Array<{ hostname: string; type: number }>).every((query) =>
            query.hostname === new URL(url).hostname && query.type === 1
          )
        ).toBe(true)
        expect(requests).toEqual(
          Array.from(
            { length: successes },
            () => ({ host: new URL(url).host, url: `/${boundary}`, at: expect.any(Number) })
          )
        )
        const network = lines<{ event: string; url: string }>(join(root, "network.jsonl"))
        expect(network.every((row) => row.url === url)).toBe(true)
        expect(network.map((row) => row.event)).toEqual([
          "query",
          "resolved",
          "response",
          ...Array.from({ length: failures.length }, () => ["query", "failure"]).flat(),
          "query",
          "resolved",
          "response",
          ...Array.from({ length: successes - 2 }, () => ["query", "resolved", "response"]).flat()
        ])
        const networkProcesses = lines<{ event: string; pid: number; code?: number }>(join(root, "network-pids.jsonl"))
        const requestPids = networkProcesses.filter((row) => row.event === "start").map((row) => row.pid)
        expect(new Set(requestPids).size).toBe(failures.length + successes)
        expect(requestPids).toHaveLength(failures.length + successes)
        for (const pid of requestPids) {
          expect(networkProcesses.filter((row) => row.pid === pid).map((row) => row.event)).toEqual(["start", "exit"])
        }
        expect(networkProcesses.filter((row) => row.event === "exit").map((row) => row.code).sort())
          .toEqual([...Array(successes).fill(0), ...Array(failures.length).fill(1)])
        if (boundary === "model") {
          expect(attempts(root).filter((row) => ["\"1\"", "\"2\""].includes(row.outcome_json ?? ""))).toEqual(
            workBefore
          )
          const faultRows = lines(join(root, "network-faults.jsonl"))
          expect(faultRows).toEqual(Array.from({ length: failures.length }, () => ({
            index: 1,
            class: "infra",
            tag: "@smthrs/kernel/Unreachable",
            _tag: "@smthrs/kernel/Unreachable"
          })))
          const failed = attempts(root).filter((row) => row.error_json?.includes("@smthrs/kernel/Unreachable"))
          expect(failed).toHaveLength(failures.length)
          const probeAttempts = attempts(root).filter((row) => row.step_key_digest === failed[0]!.step_key_digest)
          expect(probeAttempts.map((row) => row.attempt)).toEqual(
            Array.from({ length: failures.length + 1 }, (_, n) => n + 1)
          )
          expect(probeAttempts.map((row) => row.state)).toEqual([...Array(failures.length).fill("failed"), "succeeded"])
          expect(probeAttempts.at(-1)!.outcome_json).toBe("\"available\"")
          json(join(root, "probe-receipt.json"), { workBefore, probeAttempts, faultRows })
        }
        json(join(root, "dns-receipt.json"), {
          url,
          queries,
          requests,
          outageMs: Date.now() - down,
          configurationUnchanged: true
        })
        await reap(root)
        integrity(root, 2, true, true, true)
        assertRecovery(receipt(root, 2))
      } finally {
        http.closeAllConnections()
        if (http.listening) await new Promise<void>((resolve) => http.close(() => resolve()))
        try {
          dns.close()
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ERR_SOCKET_DGRAM_NOT_RUNNING") throw error
        }
        await reap(root)
      }
    }, 360_000)
  })
}

describe("changed capability ceiling with reused child attempt", () => {
  let root: string, value: ReturnType<typeof receipt> | undefined
  it("validates completed exact work, reused N=2 identity and precise ceiling conflict", async () => {
    root = make("identity")
    const first = launch(root, 1, 2, "reuse")
    await completed(first, 0)
    await reap(root)
    integrity(root, 2, true, true, true)
    assertRecovery(receipt(root, 2))
    const source = join(root, "flows", "reuse", "flow.ts")
    writeFileSync(source, readFileSync(source, "utf8").replace("capabilities: [\"fs:read:**\"]", "capabilities: []"))
    const second = launch(root, 1, 2, "reuse")
    await completed(second, 1)
    expect(JSON.parse(second.output().stdout)).toMatchObject({ _tag: "Accepted", status: "failed" })
    const refusals = lines(join(root, "identity-refusals.jsonl"))
    expect(refusals.length).toBeGreaterThanOrEqual(1)
    expect(refusals.length).toBeLessThanOrEqual(2)
    expect(refusals).toEqual(Array.from({ length: refusals.length }, () => ({
      reason: "Fail",
      tag: "@smthrs/engine/ExecutionIdentityConflict",
      field: "capabilities",
      status: "completed"
    })))
    json(join(root, "identity-diagnostic.json"), { refusals, cause: JSON.parse(second.output().stdout).cause })
    expect(rows(root).filter((row) => row.status === "failed")).toHaveLength(2)
    await reap(root)
    integrity(root, 2, true, true, true)
    value = receipt(root, 2, 2)
  }, 360_000)
  knownRed("#3367 capability ceiling changes refresh conflicted child identity without failing parent", () => {
    if (value) assertRecovery(value)
  })
})

it("#3320 #3367 live source edit retains admitted bytes for later durable children", async () => {
  const root = make("source")
  const run = launch(root, 6, 2, "live")
  await wait(
    () => records(root).some((row) => row.event === "progress" && row.index === "1"),
    "first live child progress"
  )
  expect(records(root).some((row) => row.index === "2")).toBe(false)
  for (const name of ["live", "burndown"]) {
    const source = join(root, "flows", name, "flow.ts")
    const old = readFileSync(source, "utf8")
    const updated = old.replaceAll("fault-3367/v1", "unapproved-version").replace("Launch later", "Edited later")
    expect(updated).not.toBe(old)
    writeFileSync(source, updated)
  }
  await completed(run, 0)
  await reap(root)
  integrity(root, 2, true, true, true)
  assertRecovery(receipt(root, 2))
}, 360_000)

it("reports the dedicated disk-volume platform capability", () => {
  console.log(
    "FAULT_3367_DISK_CAPABILITY",
    JSON.stringify({
      platform: process.platform,
      supported: process.platform === "darwin",
      reason: "32MiB hdiutil volume; Linux mount isolation is not claimed"
    })
  )
})
it.skipIf(process.platform !== "darwin")(
  "#3367 owning disk guard polls real statfs and resumes N=2 automatically",
  async () => {
    const root = make("disk")
    cpSync(fileURLToPath(new URL("./fixtures/disk-flow", import.meta.url)), join(root, "flows", "disk"), {
      recursive: true
    })
    // Current owning closure: vm-pool is imported by vm; vm-options travels alongside placement.
    for (const name of ["vm.ts", "vm-pool.ts", "vm-options.ts", "msb-nice.sh"]) {
      copyOwner(root, name, join(root, "flows", "disk", name))
    }
    symlinkSync(
      fileURLToPath(new URL("../../../../flows/node_modules/microsandbox", import.meta.url)),
      join(root, "node_modules", "microsandbox"),
      "dir"
    )
    const image = join(root, "pressure.dmg"), volume = join(root, "volume")
    mkdirSync(volume)
    let attached = false
    try {
      writeFileSync(
        join(root, "volume-create.log"),
        execFileSync("hdiutil", [
          "create",
          "-size",
          "32m",
          "-fs",
          "HFS+",
          "-volname",
          "Fault3367",
          "-type",
          "UDIF",
          "-nospotlight",
          image
        ], { timeout: 60_000 })
      )
      execFileSync("hdiutil", ["attach", image, "-mountpoint", volume, "-nobrowse", "-quiet"], { timeout: 60_000 })
      attached = true
      const free = () => {
        const fs = statfsSync(volume)
        return fs.bavail * fs.bsize
      }
      const floor = 8 * 1024 ** 2, before = free()
      expect(before).toBeGreaterThan(floor)
      writeFileSync(join(volume, "pressure"), Buffer.alloc(before - 4 * 1024 ** 2, 1))
      expect(free()).toBeLessThan(floor)
      json(join(root, "disk.json"), { path: volume, floor })
      const run = launch(root, 1, 2, "disk")
      await wait(() => existsSync(join(root, "disk-waiting")), "actual imported awaitDisk entered")
      await wait(() => lines(join(root, "statfs.jsonl")).length >= 3, "multiple real statfs guard polls")
      expect(records(root)).toEqual([])
      expect(existsSync(join(root, "disk-cleared"))).toBe(false)
      expect(lines<{ bytes: number }>(join(root, "statfs.jsonl")).every((row) => row.bytes < floor)).toBe(true)
      unlinkSync(join(volume, "pressure"))
      expect(free()).toBeGreaterThan(floor)
      await completed(run, 0)
      expect(lines<{ bytes: number }>(join(root, "statfs.jsonl")).at(-1)!.bytes).toBeGreaterThanOrEqual(floor)
      json(join(root, "disk-receipt.json"), {
        floor,
        before,
        after: free(),
        source: "flows/issue-sweep/vm.ts",
        sdk: "real installed microsandbox, no VM acquired"
      })
      await reap(root)
      integrity(root, 2, true, true, true)
      assertRecovery(receipt(root, 2))
    } finally {
      try {
        await reap(root)
      } finally {
        if (attached) execFileSync("hdiutil", ["detach", volume, "-quiet", "-force"], { timeout: 30_000 })
      }
    }
  },
  360_000
)
