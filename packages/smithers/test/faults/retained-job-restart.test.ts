/** #3367: real public native host, SIGKILL, SQLite and a keyed external worker. */
import { type ChildProcess, spawn } from "node:child_process"
import {
  cpSync,
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
import { basename, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const fixture = fileURLToPath(new URL("./fixtures/burndown", import.meta.url))
const script = join(fixture, "restart-host.ts")
const preload = join(fixture, "preload.mjs")
const modules = fileURLToPath(new URL("../../node_modules", import.meta.url))
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const poll = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 120_000
  while (!predicate()) {
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`)
    await delay(100)
  }
}
const lines = (path: string): Array<Record<string, any>> =>
  existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : []
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    return false
  }
}
const state = (root: string) => {
  const db = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
  try {
    return {
      runs: db.prepare("select run_id, status, waiting_reason, state_json from flows_runs order by run_id").all(),
      attempts: db.prepare(
        "select run_id, step_key_digest, attempt, state from flows_attempts order by run_id, step_key_digest, attempt"
      ).all(),
      journal: db.prepare(
        "select run_id, seq, emitted_at_ms, event_type, payload_json from flows_journal_events order by run_id, seq"
      ).all()
    }
  } finally {
    db.close()
  }
}
for (const edit of [false, true]) {
  it(
    `#3367 host SIGKILL automatically rejoins one retained worker${edit ? " using pinned code after edits" : ""}`,
    async () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "fault-3367-restart-")))
      mkdirSync(join(root, "flows", "retained"), { recursive: true })
      cpSync(join(fixture, "flows", "retained"), join(root, "flows", "retained"), { recursive: true })
      cpSync(join(fixture, "retained-worker.mjs"), join(root, "retained-worker.mjs"))
      symlinkSync(modules, join(root, "node_modules"), "dir")
      writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
      const hosts: Array<{ child: ChildProcess; done: Promise<void>; output: () => string }> = []
      const launch = (mode: string) => {
        const child = spawn(process.execPath, ["--no-warnings", "--import", preload, script, mode, root], {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(root, "config"),
            NODE_OPTIONS: "",
            AI_GATEWAY_API_KEY: "",
            SMITHERS_REMOTE: ""
          }
        })
        let output = ""
        child.stdout!.on("data", (chunk) => {
          output += chunk
        })
        child.stderr!.on("data", (chunk) => {
          output += chunk
        })
        const done = new Promise<void>((resolve) =>
          child.once("close", () => {
            writeFileSync(join(root, `host-${mode}.log`), output)
            writeFileSync(
              join(root, `host-${mode}.exit.json`),
              JSON.stringify({ code: child.exitCode, signal: child.signalCode })
            )
            resolve()
          })
        )
        const host = { child, done, output: () => output }
        hosts.push(host)
        writeFileSync(join(root, `command-${mode}.json`), JSON.stringify({ args: child.spawnargs, at: Date.now() }))
        return host
      }
      let original: ReturnType<typeof launch> | undefined
      let worker: number | undefined
      const workerPids = new Set<number>()
      const trackWorkers = () => {
        for (const row of lines(join(root, "workers.jsonl"))) {
          if (row.event === "start" && Number.isSafeInteger(row.pid) && row.pid > 0) {
            workerPids.add(row.pid)
            worker ??= row.pid
          }
        }
      }
      const stages: Array<{ stage: string; at: number }> = []
      const mark = (stage: string) => stages.push({ stage, at: Date.now() })
      try {
        mark("start-host-requested")
        original = launch("start")
        await poll(() => {
          trackWorkers() // Register the start receipt before progress or host failure.
          if (original!.child.exitCode !== null) throw Error(original!.output())
          return existsSync(join(root, "run-id")) &&
            lines(join(root, "workers.jsonl")).some((row) => row.event === "progress")
        }, "accepted run and external worker progress")
        trackWorkers()
        expect(workerPids.size).toBe(1)
        expect(worker).toBeDefined()
        mark("external-worker-progress")
        await poll(
          () => state(root).runs.every((row) => row.status === "completed" || row.status === "suspended"),
          "all owners parked on durable waits"
        )
        const before = state(root)
        expect(before.runs.some((row) => row.waiting_reason === "timer")).toBe(true)
        expect(before.runs.some((row) => row.waiting_reason === "released")).toBe(false)
        expect(alive(worker!)).toBe(true)
        if (edit) {
          for (const file of ["flow.ts", "helper.ts"]) {
            const path = join(root, "flows", "retained", file)
            writeFileSync(path, readFileSync(path, "utf8").replaceAll("approved-", "unapproved-"))
          }
        }
        original.child.kill("SIGKILL")
        await original.done
        mark("original-host-killed")
        expect(original.child.signalCode).toBe("SIGKILL")
        expect(alive(worker!), "external process must survive host death").toBe(true)
        await delay(2_000)
        expect(lines(join(root, "workers.jsonl")).filter((row) => row.event === "start")).toHaveLength(1)
        const replacement = launch("restart")
        mark("replacement-host-requested")
        await poll(() => {
          if (replacement.child.exitCode !== null) throw Error(replacement.output())
          return existsSync(join(root, "host-restart-ready"))
            && lines(join(root, "operations.jsonl")).some((row) =>
              row.operation === "status" && row.host === replacement.child.pid
            )
        }, "replacement host automatically probes the existing job")
        mark("replacement-status-probe")
        expect(alive(worker!)).toBe(true)
        expect(lines(join(root, "workers.jsonl")).filter((row) => row.event === "start")).toHaveLength(1)
        writeFileSync(join(root, "release"), "complete")
        mark("worker-released-to-complete")
        await poll(() => state(root).runs.every((row) => row.status === "completed"), "automatic terminal completion")
        mark("all-runs-completed")
        await poll(() => !alive(worker!), "original external worker exit")
        const after = state(root)
        expect(after.runs.length).toBeGreaterThanOrEqual(before.runs.length)
        expect(after.runs.some((row) => row.run_id === readFileSync(join(root, "run-id"), "utf8"))).toBe(true)
        expect(after.runs.every((row) => row.status === "completed")).toBe(true)
        expect(readFileSync(join(root, "collected"), "utf8")).toBe("approved-layer/approved-helper/preserved-work")
        expect(readFileSync(join(root, "finished"), "utf8")).toBe("approved-entry")
        const workers = lines(join(root, "workers.jsonl"))
        expect(workers.map((row) => row.event)).toEqual(["start", "progress", "done"])
        expect(new Set(workers.map((row) => row.pid)).size).toBe(1)
        expect(new Set(workers.map((row) => row.key)).size).toBe(1)
        const operations = lines(join(root, "operations.jsonl"))
        for (const operation of ["start", "collect", "finish"]) {
          expect(operations.filter((row) => row.operation === operation)).toHaveLength(1)
        }
        expect(operations.some((row) => row.operation === "cancel")).toBe(false)
        const receipt = {
          edit,
          passed: true,
          manualResumes: 0,
          originalPid: original.child.pid,
          replacementPid: replacement.child.pid,
          workerPid: worker,
          stages,
          before,
          after,
          workers,
          operations
        }
        writeFileSync(join(root, "restart-receipt.json"), JSON.stringify(receipt, null, 2))
        console.log(
          "FAULT_3367_RESTART",
          JSON.stringify({ root, edit, passed: true, manualResumes: 0, workerPid: worker, runs: after.runs.length })
        )
      } catch (error) {
        writeFileSync(
          join(root, "restart-failure.json"),
          JSON.stringify(
            {
              edit,
              passed: false,
              stages,
              error: String(error),
              state: existsSync(join(root, ".flows", "engine.db")) ? state(root) : null
            },
            null,
            2
          )
        )
        throw error
      } finally {
        trackWorkers() // Also catch a start that raced the first failure.
        for (const host of hosts) {
          if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill("SIGTERM")
        }
        for (const host of hosts) {
          await Promise.race([host.done, delay(5_000)])
          if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill("SIGKILL")
          await host.done
        }
        trackWorkers() // A host may have launched a worker during graceful shutdown.
        for (const pid of workerPids) {
          if (alive(pid)) process.kill(pid, "SIGKILL")
        }
        await poll(() => [...workerPids].every((pid) => !alive(pid)), "worker cleanup")
        const cleanup = {
          hosts: hosts.map((host) => ({ pid: host.child.pid, alive: alive(host.child.pid!) })),
          worker: worker ? { pid: worker, alive: alive(worker) } : null,
          workers: [...workerPids].map((pid) => ({ pid, alive: alive(pid) }))
        }
        writeFileSync(join(root, "cleanup.json"), JSON.stringify(cleanup, null, 2))
        expect(cleanup.hosts.every((host) => !host.alive)).toBe(true)
        expect(cleanup.workers.every((worker) => !worker.alive)).toBe(true)
        if (process.env.FAULT_3367_RECEIPTS) {
          cpSync(root, join(process.env.FAULT_3367_RECEIPTS, basename(root)), {
            recursive: true,
            filter: (path) => !["node_modules", "config"].includes(basename(path))
          })
        }
        rmSync(root, { recursive: true, force: true })
      }
    },
    300_000
  )
}
