import { Control } from "@smthrs/control"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
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

const mode = process.argv[2]
if (["observe", "stall", "cancel", "recover"].includes(mode!)) {
  const root = await mkdtemp(join(tmpdir(), "smithers-external-peer-"))
  await symlink(fileURLToPath(new URL("../../../../node_modules", import.meta.url)), join(root, "node_modules"), "dir")
  await mkdir(join(root, "flows", "external-peer"), { recursive: true })
  await copyFile(
    fileURLToPath(new URL("./external-peer-flow.ts", import.meta.url)),
    join(root, "flows", "external-peer", "flow.ts")
  )
  const observer = spawn(process.execPath, ["--experimental-strip-types", fixture, "observer", root], {
    stdio: ["ignore", "pipe", "pipe"]
  })
  let observerOutput = ""
  observer.stdout?.on("data", (chunk) => {
    observerOutput += String(chunk)
  })
  observer.stderr?.on("data", (chunk) => {
    observerOutput += String(chunk)
  })
  const observerExited = new Promise<void>((resolve) => observer.on("exit", () => resolve()))
  await poll(async () => {
    if (observer.exitCode !== null) throw new Error(`Observer exited: ${observerOutput}`)
    return access(join(root, "observer-ready")).then(() => true, () => false)
  }, "peer registration before launch")
  const original = spawn(process.execPath, ["--experimental-strip-types", fixture, "original", root], {
    stdio: ["ignore", "pipe", "pipe"]
  })
  let stderr = ""
  original.stdout?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  original.stderr?.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const exited = new Promise<void>((resolve) => original.on("exit", () => resolve()))
  try {
    await poll(async () => {
      if (original.exitCode !== null) throw new Error(`Owner exited: ${stderr}`)
      if (rows(root).some((row) => row.status === "failed")) {
        throw new Error(`Execution failed before external spawn: ${stderr}`)
      }
      return (await workers(root)).length > 0
    }, "external worker entered")
    const runId = await readFile(join(root, "run-id"), "utf8")
    const first = (await workers(root))[0]!
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    await writeFile(join(root, "observer-close"), "close")
    await observerExited
    assert.equal(observer.exitCode, 0, observerOutput)
    assert.equal(alive(first.pid), true, "Closing an observation host must not terminate the worker")
    assert.deepEqual(await workers(root), [first])
    await poll(() => rows(root).some((row) => row.status === "suspended"), "real engine parent park")
    if (mode === "recover") {
      original.kill("SIGKILL")
      await exited
      // Expire the real lease by elapsed time; neither store is mutated.
      await new Promise((resolve) => setTimeout(resolve, 31_000))
    }
    if (mode === "stall") original.kill("SIGSTOP")
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        if (mode === "cancel") {
          yield* control.cancel({ runId, idempotencyKey: "cancel-peer" })
          yield* Effect.promise(() =>
            poll(() => rows(root).every((row) => row.status === "cancelled"), "public cancellation convergence")
          )
          assert.deepEqual(yield* Effect.promise(() => workers(root)), [first])
          yield* Effect.promise(() => poll(() => !alive(first.pid), "external worker cancellation"))
          return
        }
        if (mode === "recover") {
          yield* Effect.promise(() => poll(async () => (await workers(root)).length === 2, "real dead-owner recovery"))
          yield* Effect.promise(() => writeFile(join(root, "release"), "recover"))
          yield* Effect.promise(() =>
            poll(() => rows(root).every((row) => row.status === "completed"), "recovered parent settlement")
          )
          assert.equal((yield* Effect.promise(() => workers(root))).length, 2)
          assert.equal(rows(root).every((row) => row.cancel_requested_at_ms === null), true)
          return
        }
        // Real registration and public observations span more than the engine's
        // lease timeout. No durable rows or ownership timestamps are injected.
        for (let tick = 0; tick < 40; tick++) {
          yield* control.list({ _tag: "runs", filters: { runId } })
          assert.deepEqual(yield* Effect.promise(() => workers(root)), [first])
          assert.equal(alive(first.pid), true)
          assert.equal(rows(root).every((row) => row.cancel_requested_at_ms === null), true)
          yield* Effect.sleep("1 second")
          if (mode === "stall" && tick === 19) original.kill("SIGCONT")
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
  } catch (error) {
    process.stderr.write(`Original host:\n${stderr}\nObserver host:\n${observerOutput}\n`)
    throw error
  } finally {
    observer.kill("SIGKILL")
    await observerExited
    original.kill("SIGCONT")
    original.kill("SIGKILL")
    await exited
    for (const worker of await workers(root)) {
      try {
        process.kill(worker.pid, "SIGKILL")
      } catch {}
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
  process.stdout.write(JSON.stringify({ mode, passed: true }) + "\n")
}
