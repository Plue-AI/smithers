/** #3409: genuine provider create-or-get through public NodeControl recovery. */
import { type ChildProcess, spawn } from "node:child_process"
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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
import { expect, it } from "vitest"

const fixtures = fileURLToPath(new URL("./fixtures/keyed-release", import.meta.url))
const modules = fileURLToPath(new URL("../node_modules", import.meta.url))
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const poll = async (predicate: () => boolean, label: string) => {
  const deadline = Date.now() + 120_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw Error(`Timed out: ${label}`)
    await delay(50)
  }
}
const records = (path: string): Array<Record<string, any>> =>
  existsSync(path)
    ? readFileSync(path, "utf8").split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line)) :
    []
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    return false
  }
}
interface NativeRow {
  run_id: string
  status: string
  waiting_reason: string | null
  state_json: string
}
interface AttemptRow {
  run_id: string
  state: string
  meta_json: string
}
interface JournalRow {
  run_id: string
  event_type: string
  payload_json: string
}
const snapshot = (root: string) => {
  const db = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
  const control = new DatabaseSync(join(root, ".flows", "control.db"), { readOnly: true })
  try {
    return {
      runs: (db.prepare("SELECT run_id, status, waiting_reason, state_json FROM flows_runs ORDER BY run_id")
        .all() as unknown as Array<NativeRow>)
        .map((row) => ({ ...row, state: JSON.parse(row.state_json) })),
      attempts:
        (db.prepare("SELECT run_id, state, meta_json FROM flows_attempts ORDER BY run_id, step_key_digest, attempt")
          .all() as unknown as Array<AttemptRow>)
          .map((row) => ({ ...row, meta: JSON.parse(row.meta_json) })),
      journal: (db.prepare("SELECT run_id, event_type, payload_json FROM flows_journal_events ORDER BY run_id, seq")
        .all() as unknown as Array<JournalRow>)
        .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) })),
      control: (control.prepare("SELECT run_id, event_type, payload_json FROM flows_journal_events ORDER BY seq")
        .all() as unknown as Array<JournalRow>)
        .map((row) => ({ ...row, payload: JSON.parse(row.payload_json) }))
    }
  } finally {
    db.close()
    control.close()
  }
}

it(
  "automatically retries a released keyed module beneath a released public root with one retained job and collection",
  async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-keyed-release-")))
    mkdirSync(join(root, "flows", "keyed-release"), { recursive: true })
    copyFileSync(join(fixtures, "flow.ts"), join(root, "flows", "keyed-release", "flow.ts"))
    copyFileSync(join(fixtures, "worker.mjs"), join(root, "worker.mjs"))
    symlinkSync(modules, join(root, "node_modules"), "dir")
    writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
    const hosts: Array<{ child: ChildProcess; done: Promise<void>; output: () => string }> = []
    const launch = (mode: string) => {
      const child = spawn(process.execPath, ["--experimental-strip-types", join(fixtures, "host.ts"), mode, root], {
        cwd: root,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, XDG_CONFIG_HOME: join(root, "config"), AI_GATEWAY_API_KEY: "", SMITHERS_REMOTE: "" }
      })
      let output = ""
      child.stdout!.on("data", (chunk) => {
        output += String(chunk)
      })
      child.stderr!.on("data", (chunk) => {
        output += String(chunk)
      })
      const done = new Promise<void>((resolve) =>
        child.once("close", () => {
          writeFileSync(join(root, `host-${mode}.log`), output)
          resolve()
        })
      )
      const host = { child, done, output: () => output }
      hosts.push(host)
      return host
    }
    let worker: number | undefined
    let phase = "original admission"
    const mark = (value: string) => {
      phase = value
      console.log("KEYED_RELEASE_STAGE", value)
    }
    try {
      const original = launch("original")
      await poll(() => {
        if (original.child.exitCode !== null) throw Error(original.output())
        return existsSync(join(root, "pending-start")) && existsSync(join(root, "run-id")) &&
          records(join(root, "workers.jsonl")).length === 1
      }, "public admission and pending keyed provider start")
      worker = Number(records(join(root, "workers.jsonl"))[0]!.pid)
      const runId = readFileSync(join(root, "run-id"), "utf8")
      const before = snapshot(root)
      const module = before.runs.find((row) =>
        row.state.flowName.startsWith("registry/entry/") && row.state.flowName.endsWith("/keyed-release")
      )!
      expect(module).toBeDefined()
      expect(module.run_id).not.toBe(runId)
      expect(module.status).toBe("running")
      expect(before.runs.find((row) => row.run_id === runId)?.status).toBe("running")
      const unfinished = before.attempts.filter((row) => row.state === "running")
      expect(unfinished.length).toBeGreaterThan(0)
      expect(unfinished.every((row) => row.meta.keyed === true)).toBe(true)
      expect(unfinished.some((row) => row.run_id === module.run_id)).toBe(true)
      expect(alive(worker)).toBe(true)

      mark("real graceful release of root and module")
      original.child.kill("SIGTERM")
      await original.done
      expect(original.child.signalCode).toBeNull()
      const released = snapshot(root)
      for (const id of [runId, module.run_id]) {
        expect(released.runs.find((row) => row.run_id === id)).toMatchObject({
          status: "suspended",
          waiting_reason: "released"
        })
        expect(released.journal.some((entry) => entry.run_id === id && entry.payload.decision === "interrupt-released"))
          .toBe(true)
      }
      expect(released.attempts.filter((row) => row.state === "running").every((row) => row.meta.keyed === true)).toBe(
        true
      )
      expect(alive(worker)).toBe(true)
      // Retain the ordinary stale-owner boundary: elapsed wall time, no SQL
      // timestamps, forged ownership or explicit resume grants.
      mark("actual stale-owner boundary")
      await delay(31_000)
      expect(alive(worker)).toBe(true)

      mark("replacement public host automatically attaches")
      const replacement = launch("replacement")
      await poll(() => {
        if (replacement.child.exitCode !== null) throw Error(replacement.output())
        return records(join(root, "operations.jsonl")).some((row) =>
          row.operation === "attach" && row.host === replacement.child.pid
        )
      }, "automatic keyed retry attaches to the original provider job")
      expect(records(join(root, "workers.jsonl"))).toHaveLength(1)
      expect(alive(worker)).toBe(true)
      expect(snapshot(root).control.some((entry) => entry.event_type === "control.engine.released-children-resume"))
        .toBe(false)

      mark("one retained job completes and collects once")
      writeFileSync(join(root, "release"), "complete")
      await poll(
        () => snapshot(root).runs.every((row) => row.status === "completed"),
        "root and module automatic settlement"
      )
      await poll(() => !alive(worker!), "retained worker exit")
      const after = snapshot(root)
      expect(JSON.stringify(after.runs.find((row) => row.run_id === module.run_id)?.state.result))
        .toContain(`retained/${worker}/preserved-work`)
      const workers = records(join(root, "workers.jsonl"))
      const operations = records(join(root, "operations.jsonl"))
      expect(workers.map((row) => row.event)).toEqual(["start", "done"])
      expect(new Set(workers.map((row) => row.pid)).size).toBe(1)
      expect(new Set(workers.map((row) => row.key)).size).toBe(1)
      for (const operation of ["start", "attach", "collect"]) {
        expect(
          operations.filter((row) => row.operation === operation)
        ).toHaveLength(1)
      }
      expect(new Set(operations.map((row) => row.key)).size).toBe(1)
      expect(
        after.control.some((entry) =>
          ["control.run.resume", "control.run.resumed", "control.engine.released-children-resume"].includes(
            entry.event_type
          )
        )
      ).toBe(false)
      const receipt = {
        passed: true,
        manualResumes: 0,
        runId,
        moduleId: module.run_id,
        workerPid: worker,
        before,
        released,
        after,
        workers,
        operations
      }
      writeFileSync(join(root, "receipt.json"), JSON.stringify(receipt, null, 2))
      console.log(
        "KEYED_RELEASE_RECEIPT",
        JSON.stringify({ passed: true, manualResumes: 0, workerPid: worker, providerJobs: 1, collections: 1 })
      )
    } catch (error) {
      let state: unknown = null
      try {
        if (existsSync(join(root, ".flows", "control.db"))) {
          state = snapshot(root)
        }
      } catch (snapshotError) {
        state = { snapshotError: String(snapshotError) }
      }
      writeFileSync(
        join(root, "failure.json"),
        JSON.stringify(
          {
            phase,
            error: String(error),
            hosts: hosts.map((host) => host.output()),
            state
          },
          null,
          2
        )
      )
      throw error
    } finally {
      for (const host of hosts) {
        if (host.child.exitCode === null && host.child.signalCode === null) {
          host.child.kill("SIGTERM")
        }
      }
      for (const host of hosts) {
        await Promise.race([host.done, delay(5_000)])
        if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill("SIGKILL")
        await host.done
      }
      // Clean every owned process, including duplicate-work and failed-startup
      // paths before the first readiness poll assigned the expected worker.
      const ownedPids = new Set<number>(
        records(join(root, "workers.jsonl"))
          .filter((row) => row.event === "start").map((row) => Number(row.pid))
      )
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith("job-")) continue
        for (const file of ["accepted-pid", "pid"]) {
          const path = join(root, entry.name, file)
          if (existsSync(path)) ownedPids.add(Number(readFileSync(path, "utf8")))
        }
      }
      const ownedWorkers = [...ownedPids].filter((pid) => Number.isSafeInteger(pid) && pid > 0)
      for (const pid of ownedWorkers) {
        if (!alive(pid)) continue
        try {
          process.kill(pid, "SIGKILL")
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
        }
      }
      await poll(() => ownedWorkers.every((pid) => !alive(pid)), "all owned worker cleanup")
      const cleanup = {
        hosts: hosts.map((host) => ({ pid: host.child.pid, alive: alive(host.child.pid!) })),
        workers: ownedWorkers.map((pid) => ({ pid, alive: alive(pid) }))
      }
      expect(cleanup.hosts.every((host) => !host.alive)).toBe(true)
      expect(cleanup.workers.every((entry) => !entry.alive)).toBe(true)
      writeFileSync(join(root, "cleanup.json"), JSON.stringify(cleanup, null, 2))
      if (process.env.KEYED_RELEASE_RECEIPTS) {
        const { cpSync } = await import("node:fs")
        cpSync(root, join(process.env.KEYED_RELEASE_RECEIPTS, root.split("/").at(-1)!), {
          recursive: true,
          filter: (path) => !["node_modules", "config"].includes(path.split("/").at(-1)!)
        })
      }
      rmSync(root, { recursive: true, force: true })
    }
  },
  240_000
)
