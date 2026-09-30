import { Control } from "@smthrs/control"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { host } from "./native-control-external-peer.ts"

const fixture = fileURLToPath(new URL("./native-control-external-peer.ts", import.meta.url))
const poll = async (predicate: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 90_000
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const workers = async (root: string): Promise<Array<{ pid: number; owner: number }>> =>
  readFile(join(root, "spawns"), "utf8").then(
    (text) => text.trim().split("\n").map((line) => JSON.parse(line)),
    () => []
  )
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const rows = (root: string) => {
  const db = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
  try {
    return db.prepare("SELECT run_id, status, waiting_reason, owner_pid, cancel_requested_at_ms FROM flows_runs")
      .all() as unknown as Array<
        {
          run_id: string
          status: string
          waiting_reason: string | null
          owner_pid: number | null
          cancel_requested_at_ms: number | null
        }
      >
  } finally {
    db.close()
  }
}

if (process.argv[2] === "observe") {
  const root = await mkdtemp(join(tmpdir(), "smithers-external-peer-"))
  await mkdir(join(root, "flows", "external-peer"), { recursive: true })
  await copyFile(
    fileURLToPath(new URL("./external-peer-flow.ts", import.meta.url)),
    join(root, "flows", "external-peer", "flow.ts")
  )
  const original = spawn(process.execPath, ["--experimental-strip-types", fixture, "original", root], {
    stdio: ["ignore", "ignore", "pipe"]
  })
  let stderr = ""
  original.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const exited = new Promise<void>((resolve) => original.on("exit", () => resolve()))
  try {
    await poll(async () => (await workers(root)).length > 0, `external worker entered: ${stderr}`)
    const runId = await readFile(join(root, "run-id"), "utf8")
    const first = (await workers(root))[0]!
    await poll(() => rows(root).some((row) => row.status === "suspended"), "real engine parent park")
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        // Real registration and public observations span more than the engine's
        // lease timeout. No durable rows or ownership timestamps are injected.
        for (let tick = 0; tick < 40; tick++) {
          yield* control.list({ _tag: "runs", filters: { runId } })
          assert.deepEqual(yield* Effect.promise(() => workers(root)), [first])
          assert.equal(alive(first.pid), true)
          assert.equal(rows(root).every((row) => row.cancel_requested_at_ms === null), true)
          yield* Effect.sleep("1 second")
        }
        yield* Effect.promise(() => writeFile(join(root, "release"), "finish"))
        yield* Effect.promise(() =>
          poll(() => rows(root).every((row) => row.status === "completed"), "parked parent completion")
        )
        const page = yield* control.list({ _tag: "runs", filters: { runId } })
        assert.equal(page._tag === "runs" && page.items[0]?.status, "completed")
        assert.deepEqual(yield* Effect.promise(() => workers(root)), [first])
      }).pipe(Effect.provide(host(root)), Effect.scoped)
    )
  } finally {
    original.kill("SIGKILL")
    await exited
    for (const worker of await workers(root)) {
      try {
        process.kill(worker.pid, "SIGKILL")
      } catch {}
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
  process.stdout.write(JSON.stringify({ passed: true }) + "\n")
}
