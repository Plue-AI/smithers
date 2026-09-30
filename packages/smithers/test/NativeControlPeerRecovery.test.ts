import { Control } from "@smthrs/control"
import { Effect } from "effect"
import { spawn } from "node:child_process"
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"
import { host, source } from "./fixtures/native-control-peer-recovery.ts"

const fixture = fileURLToPath(new URL("./fixtures/native-control-peer-recovery.ts", import.meta.url))
const poll = async (predicate: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 60_000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const exists = (file: string) => access(file).then(() => true, () => false)
const database = <A>(root: string, name: string, f: (db: DatabaseSync) => A): A => {
  const db = new DatabaseSync(join(root, ".flows", `${name}.db`))
  try {
    return f(db)
  } finally {
    db.close()
  }
}
interface Row {
  run_id: string
  status: string
  owner_pid: number | null
  cancel_requested_at_ms: number | null
}
const rows = (root: string, name = "engine") =>
  database(
    root,
    name,
    (db) =>
      db.prepare("SELECT run_id, status, owner_pid, cancel_requested_at_ms FROM flows_runs ORDER BY run_id")
        .all() as unknown as Row[]
  )

it(
  "a peer leaves a live control owner's released root and native child alone, then recovers the dead owner",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-peer-recovery-"))
    await mkdir(join(root, "flows", "peer"), { recursive: true })
    await writeFile(join(root, "flows", "peer", "flow.ts"), source)
    const original = spawn(process.execPath, ["--experimental-strip-types", fixture, "peer-original", root], {
      stdio: ["ignore", "ignore", "pipe"]
    })
    let stderr = ""
    original.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    const exited = new Promise<void>((resolve) => original.on("exit", () => resolve()))
    try {
      await poll(() => exists(join(root, `entered-${original.pid}`)), `original native child entered: ${stderr}`)
      const runId = await readFile(join(root, "run-id"), "utf8")
      const child = rows(root).find((row) => row.run_id !== runId)
      expect(child).toMatchObject({ status: "running", owner_pid: original.pid })
      expect(rows(root, "control").find((row) => row.run_id === runId)).toMatchObject({
        status: "running",
        owner_pid: original.pid
      })

      // Freeze the live owner while injecting the split so its own recovery
      // cannot reclaim the root before the peer observes it. PID probing still
      // reports this stopped process as alive.
      original.kill("SIGSTOP")
      database(root, "control", (db) =>
        db.prepare(
          "UPDATE flows_runs SET heartbeat_at_ms = ? WHERE run_id = ?"
        ).run(Date.now() - 60_000, runId))

      // Reproduce the durable split from #2958: budget suspension released the
      // engine root while the original control fence and detached child live.
      // SQL injects that inter-store fault; both recoverers are shipped hosts.
      database(root, "engine", (db) =>
        db.prepare(`UPDATE flows_runs SET status = 'suspended',
      waiting_reason = 'released', owner_host_id = NULL, owner_pid = NULL, owner_nonce = NULL,
      heartbeat_at_ms = NULL, claim_host_id = NULL, claim_pid = NULL, claim_nonce = NULL,
      claimed_at_ms = NULL WHERE run_id = ?`).run(runId))
      const before = database(
        root,
        "engine",
        (db) =>
          db.prepare("SELECT count(*) AS n FROM flows_journal_events WHERE run_id = ?").get(runId) as { n: number }
      )
      await Effect.runPromise(
        Effect.gen(function*() {
          yield* Control.Control
          // Registration immediately sweeps released roots. Allow another sweep
          // and verify durable history, not merely the final status.
          yield* Effect.sleep("2 seconds")
          expect(rows(root).find((row) => row.run_id === runId)).toMatchObject({ status: "suspended", owner_pid: null })
          expect(
            rows(root).find((row) => row.run_id === child!.run_id)
          ).toMatchObject({
            status: "running",
            owner_pid: original.pid,
            cancel_requested_at_ms: null
          })
          const after = database(
            root,
            "engine",
            (db) =>
              db.prepare("SELECT count(*) AS n FROM flows_journal_events WHERE run_id = ?").get(runId) as { n: number }
          )
          expect(after.n).toBe(before.n)
          expect(
            yield* Effect.promise(() => exists(join(root, `entered-${process.pid}`)))
          ).toBe(false)
        }).pipe(Effect.provide(host(root)), Effect.scoped)
      )

      original.kill("SIGKILL")
      await exited
      // Genuine dead-owner recovery requires an expired control and child lease.
      for (const name of ["control", "engine"]) {
        database(root, name, (db) =>
          db.prepare(
            "UPDATE flows_runs SET heartbeat_at_ms = ? WHERE status = 'running'"
          ).run(Date.now() - 60_000))
      }
      await writeFile(join(root, "release"), "recover")
      await Effect.runPromise(
        Effect.gen(function*() {
          const control = yield* Control.Control
          yield* Effect.promise(() =>
            poll(
              () => rows(root).find((row) => row.run_id === runId)?.status === "completed",
              "dead original recovery"
            )
          )
          const page = yield* control.list({ _tag: "runs", filters: { runId } })
          expect(page._tag).toBe("runs")
          if (page._tag === "runs") {
            expect(page.items[0]?.status).toBe("completed")
          }
          expect(rows(root).every((row) => row.status === "completed" && row.cancel_requested_at_ms === null)).toBe(
            true
          )
        }).pipe(Effect.provide(host(root)), Effect.scoped)
      )
    } finally {
      original.kill("SIGKILL")
      await exited
      await rm(root, { recursive: true, force: true, maxRetries: 5 })
    }
  },
  180_000
)
