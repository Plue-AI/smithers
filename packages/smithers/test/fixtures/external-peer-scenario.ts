import { Control } from "@smthrs/control"
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Layer, Stream } from "effect"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { access, copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import * as RunActivity from "../../src/cli/RunActivity.ts"
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
    // appendFileSync creates the file before its first write. Read only newline-
    // terminated records so readiness cannot parse an empty or partial tail.
    (text) => text.split("\n").slice(0, -1).filter(Boolean).map((line) => JSON.parse(line)),
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

const decisions = (root: string) => {
  const db = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
  try {
    return (db.prepare(
      "SELECT run_id, payload_json FROM flows_journal_events WHERE event_type = 'flows.engine.run-decision'"
    )
      .all() as Array<{ run_id: string; payload_json: string }>).map((row) => ({
        runId: row.run_id,
        ...JSON.parse(row.payload_json) as { decision: string; detail?: { unconfirmedMs: number } }
      }))
  } finally {
    db.close()
  }
}

const mode = process.argv[2]
// A graceful owner exit must release, not fail, a root that is still running (#3073).
const releasing = mode === "recover-released" || mode === "recover-running"
if (mode === "recover-running" || mode === "stall") process.env.EXTERNAL_PEER_ROOT = "running"
if (mode === "detached-stall") process.env.EXTERNAL_PEER_ROOT = "detached"
if (
  ["observe", "stall", "stolen", "cancel", "recover", "recover-released", "recover-running", "detached-stall"].includes(
    mode!
  )
) {
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
  let owner: ReturnType<typeof spawn> | undefined
  let exited: Promise<void> = Promise.resolve()
  let stderr = ""
  let resumeTimer: ReturnType<typeof setTimeout> | undefined
  let phase = "observer registration"
  const enter = (value: string) => {
    phase = value
    process.stderr.write(`[external-peer ${mode} ${new Date().toISOString()}] ${phase}\n`)
  }
  const diagnose = () => {
    process.stderr.write(
      `Phase: ${phase}; fixture ${process.pid}; original ${owner?.pid}; observer ${observer.pid}; root ${root}\n`
    )
    try {
      process.stderr.write(
        `Workers: ${readFileSync(join(root, "spawns"), "utf8")}\nEngine: ${JSON.stringify(rows(root))}\n`
      )
    } catch (error) {
      process.stderr.write(`Diagnostic read failed: ${String(error)}\n`)
    }
  }
  const terminate = () => {
    diagnose()
    observer.kill("SIGKILL")
    owner?.kill("SIGCONT")
    owner?.kill("SIGKILL")
    // External workers capture their owner PID and exit when this process dies.
    // Kill both native hosts before execFile's timeout terminates the fixture.
    process.exit(143)
  }
  process.once("SIGTERM", terminate)
  try {
    await poll(async () => {
      if (observer.exitCode !== null) throw new Error(`Observer exited: ${observerOutput}`)
      return access(join(root, "observer-ready")).then(() => true, () => false)
    }, "peer registration before launch")
    enter("original host launch and public run admission")
    const original = spawn(process.execPath, ["--experimental-strip-types", fixture, "original", root], {
      stdio: ["ignore", "pipe", "pipe"]
    })
    original.stdout?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    original.stderr?.on("data", (chunk) => {
      stderr += String(chunk)
    })
    owner = original
    exited = new Promise<void>((resolve) => original.on("exit", () => resolve()))
    await poll(async () => {
      if (original.exitCode !== null) throw new Error(`Owner exited: ${stderr}`)
      if (rows(root).some((row) => row.status === "failed")) {
        throw new Error(`Execution failed before external spawn: ${stderr}`)
      }
      return (await workers(root)).length > 0
    }, "external worker entered")
    await poll(() => access(join(root, "run-id")).then(() => true, () => false), "accepted root receipt")
    const runId = await readFile(join(root, "run-id"), "utf8")
    const first = (await workers(root))[0]!
    const workerId = rows(root).find((row) => row.run_id.endsWith("/worker"))!.run_id
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    enter("observation host scope closure")
    await writeFile(join(root, "observer-close"), "close")
    await poll(() => observer.exitCode !== null || observer.signalCode !== null, "observation host scope closure")
    await observerExited
    assert.equal(observer.exitCode, 0, observerOutput)
    await new Promise((resolve) => setTimeout(resolve, 1_000))
    assert.equal(alive(first.pid), true, "Closing an observation host must not terminate the worker")
    assert.deepEqual(await workers(root), [first])
    if (mode === "recover-running" || mode === "stall") {
      enter("control root still running")
      const running = rows(root).find((row) => row.run_id === runId)
      assert.equal(running?.status, "running", JSON.stringify(rows(root)))
      assert.equal(running?.owner_pid, original.pid)
    } else if (mode === "detached-stall") {
      enter("control root completed with its detached worker running")
      await poll(
        () => rows(root).find((row) => row.run_id === runId)?.status === "completed",
        "control root completion"
      )
      assert.equal(alive(first.pid), true)
    } else {
      enter("real engine root park")
      await poll(() => rows(root).find((row) => row.run_id === runId)?.status === "suspended", "real engine root park")
    }
    if (mode === "recover" || releasing) {
      enter(`original owner exit (${mode})`)
      original.kill(releasing ? "SIGTERM" : "SIGKILL")
      await exited
      await poll(() => !alive(first.pid), "dead owner external worker exit")
      if (mode === "recover-running") {
        // Durable state after graceful exit: the running root is released for reclaim, never failed.
        const durable = rows(root)
        process.stderr.write(`Durable state after graceful exit: ${JSON.stringify(durable)}\n`)
        assert.equal(durable.some((row) => row.status === "failed"), false, JSON.stringify(durable))
        const released = durable.find((row) => row.run_id === runId)
        assert.equal(released?.status, "suspended", JSON.stringify(durable))
        assert.equal(released?.waiting_reason, "released", JSON.stringify(durable))
        assert.equal(released?.owner_pid, null, JSON.stringify(durable))
      }
      if (releasing) {
        assert.equal(original.signalCode, null, "NodeRuntime must handle SIGTERM and finish native scope teardown")
        // Shutdown releases the root; it never re-drives it into a launch failure (#3210).
        assert.doesNotMatch(stderr, /could not start on the engine|terminal control status could not be written/)
        assert.equal(
          rows(root).some((row) =>
            row.run_id.endsWith("/worker") && row.status === "suspended" && row.waiting_reason === "released"
          ),
          true
        )
        assert.deepEqual(await workers(root), [first])
        assert.equal(rows(root).every((row) => row.cancel_requested_at_ms === null), true)
      }
      // Expire the real lease by elapsed time; neither store is mutated.
      enter("real lease expiry")
      await new Promise((resolve) => setTimeout(resolve, 31_000))
    }
    enter("peer host registration")
    await Effect.runPromise(
      Effect.gen(function*() {
        const control = yield* Control.Control
        enter("peer host registered")
        if (mode === "recover-running") {
          // The public control status after the graceful exit, before any recovery settles it.
          const page = yield* control.list({ _tag: "runs", filters: { runId } })
          const status = page._tag === "runs" ? page.items[0]?.status : undefined
          process.stderr.write(`Control status after graceful exit: ${status}\n`)
          assert.notEqual(status, "failed", stderr)
        }
        if (mode === "stall" || mode === "detached-stall") {
          enter("original stopped for 25 seconds")
          original.kill("SIGSTOP")
          resumeTimer = setTimeout(() => {
            original.kill("SIGCONT")
            enter("original resumed; parked observation")
          }, 25_000)
        }
        if (mode === "stolen") {
          enter("original stopped until its persisted worker lease is stale")
          original.kill("SIGSTOP")
          yield* Effect.sleep("31 seconds")
          // This is a different host identity with an unreachable-stale probe.
          // Use the production CAS: RunStore atomically steals and activates
          // Consensus ownership and mirrors it to the execution row.
          const peerOwner = { hostId: "external-peer-other-host", pid: process.pid, nonce: "takeover" }
          const peerStore = RunStore.layer.pipe(Layer.provide(
            DurableWriter.layer().pipe(
              Layer.provideMerge(NodeDatabase.layer({ filename: join(root, ".flows", "engine.db") }))
            )
          ))
          yield* Effect.gen(function*() {
            const store = yield* RunStore.RunStore
            const row = yield* store.get(workerId)
            assert.ok(row?.owner)
            const nowMs = Date.now()
            const result = yield* store.claimAndOwn(workerId, row!, peerOwner, nowMs, {
              expectedOwner: row!.owner!,
              checkedAtMs: nowMs,
              kind: "cross-host-unreachable-stale"
            })
            assert.equal(result._tag, "Activated", JSON.stringify(result))
          }).pipe(Effect.provide(peerStore), Effect.scoped)
          enter("cross-host takeover committed; original resumed")
          original.kill("SIGCONT")
          yield* Effect.promise(() => poll(() => !alive(first.pid), "displaced owner stops external work"))
          for (let tick = 0; tick < 5; tick++) {
            yield* control.list({ _tag: "runs", filters: { runId } })
            assert.deepEqual(yield* Effect.promise(() => workers(root)), [first])
            yield* Effect.sleep("1 second")
          }
          assert.equal(rows(root).find((row) => row.run_id === workerId)?.owner_pid, process.pid)
          assert.equal(
            decisions(root).some((entry) => entry.runId === workerId && entry.decision === "lease-reconfirmed"),
            false
          )
          return
        }
        if (mode === "cancel") {
          enter("public cancellation")
          yield* control.cancel({ runId, idempotencyKey: "cancel-peer" })
          yield* Effect.promise(() =>
            poll(() => rows(root).every((row) => row.status === "cancelled"), "public cancellation convergence")
          )
          assert.deepEqual(yield* Effect.promise(() => workers(root)), [first])
          yield* Effect.promise(() => poll(() => !alive(first.pid), "external worker cancellation"))
          return
        }
        if (mode === "recover" || releasing) {
          enter("dead-owner replacement")
          yield* Effect.promise(() => poll(async () => (await workers(root)).length === 2, "real dead-owner recovery"))
          yield* Effect.promise(() => writeFile(join(root, "release"), "recover"))
          yield* Effect.promise(() =>
            poll(() => rows(root).every((row) => row.status === "completed"), "recovered parent settlement")
          )
          assert.equal((yield* Effect.promise(() => workers(root))).length, 2)
          assert.equal(rows(root).every((row) => row.cancel_requested_at_ms === null), true)
          const completed = yield* control.list({ _tag: "runs", filters: { runId } })
          assert.equal(completed._tag === "runs" && completed.items[0]?.status, "completed")
          return
        }
        // Real registration and public observations span more than the engine's
        // lease timeout. No durable rows or ownership timestamps are injected.
        for (let tick = 0; tick < 40; tick++) {
          yield* control.list({ _tag: "runs", filters: { runId } })
          assert.deepEqual(yield* Effect.promise(() => workers(root)), [first])
          assert.equal(
            alive(first.pid),
            true,
            "A live owner must reconfirm its unchanged lease without killing external work"
          )
          assert.equal(rows(root).every((row) => row.cancel_requested_at_ms === null), true)
          yield* Effect.sleep("1 second")
        }
        if (mode === "stall" || mode === "detached-stall") {
          enter("lease reconfirmation receipts")
          const recorded = decisions(root)
          assert.equal(
            recorded.some((entry) => entry.decision === "interrupt-released"),
            false,
            JSON.stringify(recorded)
          )
          const expected = mode === "stall"
            ? rows(root).filter((row) => row.status === "running").map((row) => row.run_id)
            : [workerId]
          for (const id of expected) {
            const reconfirmed = recorded.filter((entry) => entry.runId === id && entry.decision === "lease-reconfirmed")
            assert.ok(reconfirmed.length > 0, `Missing lease-reconfirmed for ${id}: ${JSON.stringify(recorded)}`)
            assert.ok(
              reconfirmed.every((entry) => (entry.detail?.unconfirmedMs ?? 0) >= 19_000),
              JSON.stringify(reconfirmed)
            )
            assert.equal(rows(root).find((row) => row.run_id === id)?.owner_pid, original.pid)
          }
          if (mode === "stall") {
            assert.equal(rows(root).find((row) => row.run_id === runId)?.status, "running")
            const page = yield* control.list({ _tag: "runs", filters: { runId } })
            assert.equal(page._tag === "runs" && page.items[0]?.status, "running")
            assert.ok(page._tag === "runs" && page.items[0] !== undefined)
            const events = yield* control.watch({ runId, follow: false }).pipe(Stream.runCollect)
            const shown = RunActivity.show(page.items[0], events)
            assert.equal(shown.status, "running")
            assert.notEqual(shown.health.attention, "needs-resume")
            for (const id of expected) {
              assert.ok(
                shown.warnings?.some((warning) =>
                  warning.code === "lease-reconfirmed" && warning.executionId === id && warning.unconfirmedMs >= 19_000
                ),
                JSON.stringify(shown)
              )
            }
          } else {
            assert.equal(rows(root).find((row) => row.run_id === runId)?.status, "completed")
          }
        }
        enter("release gate; parent settlement")
        yield* Effect.promise(() => writeFile(join(root, "release"), "finish"))
        yield* Effect.promise(() =>
          poll(() => rows(root).every((row) => row.status === "completed"), "parked parent completion")
        )
        const page = yield* control.list({ _tag: "runs", filters: { runId } })
        assert.equal(page._tag === "runs" && page.items[0]?.status, "completed")
        assert.deepEqual(yield* Effect.promise(() => workers(root)), [first])
        if (mode === "stall" || mode === "detached-stall") {
          assert.equal(decisions(root).some((entry) => entry.decision === "interrupt-released"), false)
        }
      }).pipe(Effect.provide(host(root)), Effect.scoped)
    )
  } catch (error) {
    diagnose()
    process.stderr.write(`Original host:\n${stderr}\nObserver host:\n${observerOutput}\n`)
    throw error
  } finally {
    process.removeListener("SIGTERM", terminate)
    observer.kill("SIGKILL")
    await observerExited
    clearTimeout(resumeTimer)
    owner?.kill("SIGCONT")
    owner?.kill("SIGKILL")
    await exited
    for (const worker of await workers(root)) {
      try {
        process.kill(worker.pid, "SIGKILL")
      } catch {}
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
  process.stdout.write(`Original host:\n${stderr}\nObserver host:\n${observerOutput}\n`)
  process.stdout.write(JSON.stringify({ mode, passed: true }) + "\n")
}
