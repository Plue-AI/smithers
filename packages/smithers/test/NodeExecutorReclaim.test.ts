/**
 * What the local CLI answers when it finds a run owned by somebody else.
 *
 * `layerExecutor` declares `isAlive: Ownership.sameHostPidProbe`, so the
 * arbitration is a real question about a real process: a `running` row whose
 * lease expired is reclaimed only when the recorded pid is gone from this
 * host's process table. That answer is only observable through the engine's
 * stale-running sweep, so these cases seed rows directly into the execution
 * database and watch what the sweep does with them.
 *
 * The probe can only tell two owners apart when the recorded `hostId` names
 * the machine rather than a constant, which is why `layerExecutor` stamps
 * `hostname()`. The paired case below is what pins that: one row owned by a
 * live pid on this host and one owned by a dead pid on this host go into the
 * same database, and the live one must survive the sweep that reclaims the
 * dead one. Under a constant `hostId` every row read as foreign, the probe
 * declined to answer, and BOTH were stolen.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Control } from "@smthrs/control"
import { Effect, Layer } from "effect"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { describe, expect, it } from "vitest"
import * as Application from "../src/Application.ts"
import * as NodeControl from "../src/NodeControl.ts"

const runId = "stale-run"

interface RunRow {
  readonly status: string
  readonly owner_host_id: string | null
  readonly owner_pid: number | null
}

const readRun = (file: string, id: string = runId): RunRow => {
  const database = new DatabaseSync(file, { readOnly: true })
  try {
    return database.prepare(
      "SELECT status, owner_host_id, owner_pid FROM flows_runs WHERE run_id = ?"
    ).get(id) as unknown as RunRow
  } finally {
    database.close()
  }
}

interface SeedOptions {
  readonly runId: string
  readonly hostId: string
  readonly pid: number
  readonly frozenAtMs: number
}

/** Writes the row a SIGKILLed owner leaves behind: running, heartbeat frozen. */
const seedHardKilledRun = (file: string, options: SeedOptions): void => {
  const database = new DatabaseSync(file)
  try {
    database.prepare(
      `INSERT INTO flows_runs (
        run_id, status, created_at_ms, started_at_ms, owner_host_id, owner_pid, owner_nonce,
        heartbeat_at_ms, state_json
      ) VALUES (?, 'running', ?, ?, ?, ?, 'seeded-nonce', ?, ?)`
    ).run(
      options.runId,
      options.frozenAtMs,
      options.frozenAtMs,
      options.hostId,
      options.pid,
      options.frozenAtMs,
      JSON.stringify({
        version: 1,
        flowName: "agent/run",
        payload: { runId: options.runId, planId: "plan-1" }
      })
    )
    database.prepare(
      `INSERT INTO flows_consensus_leases (
        run_id, owner_host_id, owner_pid, owner_nonce, granted_at_ms, heartbeat_at_ms
      ) VALUES (?, ?, ?, 'seeded-nonce', ?, ?)`
    ).run(options.runId, options.hostId, options.pid, options.frozenAtMs, options.frozenAtMs)
  } finally {
    database.close()
  }
}

/**
 * A pid this host has already reaped.
 *
 * Spawning and waiting is the only honest way to name one: a literal integer
 * is a guess about somebody else's process table. The pid is free the instant
 * the synchronous spawn returns, and the operating system will not hand it out
 * again inside the seconds this case runs.
 */
const reapedPid = (): number => {
  const exited = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" })
  const pid = exited.pid
  if (pid === undefined) throw new Error("could not spawn a child to reap")
  return pid
}

/** A process that stays alive until the case kills it, standing in for a peer CLI. */
const livePeer = (): ChildProcess => {
  const peer = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { stdio: "ignore" })
  if (peer.pid === undefined) throw new Error("could not spawn a live peer")
  return peer
}

const projectRoot = (root: string) => {
  const registry = NodeControl.layerRegistry(root)
  const engine = NodeControl.engineDurable(root, registry)
  const executor = NodeControl.layerExecutor(registry, engine, root, {
    evaluator: ScriptedJudge.layer,
    environment: {}
  })
  const composition = Application.layer({}, registry, engine, executor) as Layer.Layer<Control.Control>
  return <A, E>(use: Effect.Effect<A, E, Control.Control>) =>
    Effect.runPromise(use.pipe(Effect.provide(composition), Effect.scoped, Effect.orDie))
}

describe("NodeControl.layerExecutor liveness", () => {
  it("reclaims a run whose recorded owner stopped heartbeating", async () => {
    const root = await mkdtemp(join(tmpdir(), "flows-cli-reclaim-"))
    try {
      const open = projectRoot(root)

      // One process's worth of lifetime: enough to migrate the execution
      // database, then gone.
      await open(Effect.flatMap(Control.Control, (control) => control.list({ _tag: "runs" })))

      const file = NodeControl.executionDatabasePath(root)
      // Two minutes is well past the 30 s staleness cutoff, so the sweep sees
      // the row on its first tick.
      seedHardKilledRun(file, { runId, hostId: "dead-host", pid: 4242, frozenAtMs: Date.now() - 120_000 })
      expect(readRun(file)).toMatchObject({ status: "running", owner_host_id: "dead-host" })

      // A second process opens the same directory and its sweeper ticks once a
      // second. Poll rather than sleep a fixed span so a slow host cannot turn
      // the reclaim into a flake.
      const reclaimed = await open(
        Effect.gen(function*() {
          yield* Control.Control
          let owner = readRun(file).owner_host_id
          for (let attempt = 0; attempt < 40 && owner === "dead-host"; attempt++) {
            yield* Effect.sleep("250 millis")
            owner = readRun(file).owner_host_id
          }
          return owner
        })
      )

      // A pid on another host is never probed, so the expired lease is the
      // whole case for the steal and the sweep takes the row.
      expect(reclaimed).not.toBe("dead-host")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)

  it("leaves a live owner's run alone while reclaiming a dead owner's on the same host", async () => {
    const root = await mkdtemp(join(tmpdir(), "flows-cli-reclaim-peer-"))
    const peer = livePeer()
    try {
      const open = projectRoot(root)
      await open(Effect.flatMap(Control.Control, (control) => control.list({ _tag: "runs" })))

      const file = NodeControl.executionDatabasePath(root)
      const frozenAtMs = Date.now() - 120_000
      const host = hostname()
      const dead = reapedPid()
      // Both leases expired at the same instant, so the only thing separating
      // the two rows is whether their pid still answers on this host.
      seedHardKilledRun(file, { runId: "live-owner-run", hostId: host, pid: peer.pid!, frozenAtMs })
      seedHardKilledRun(file, { runId: "dead-owner-run", hostId: host, pid: dead, frozenAtMs })
      expect(readRun(file, "live-owner-run")).toMatchObject({ owner_host_id: host, owner_pid: peer.pid })

      // The dead row's reclaim is the clock: once the sweep has taken the row
      // it was allowed to take, it has also already declined the other one.
      const outcome = await open(
        Effect.gen(function*() {
          yield* Control.Control
          let deadOwner = readRun(file, "dead-owner-run").owner_pid
          for (let attempt = 0; attempt < 60 && deadOwner === dead; attempt++) {
            yield* Effect.sleep("250 millis")
            deadOwner = readRun(file, "dead-owner-run").owner_pid
          }
          return { deadOwner, live: readRun(file, "live-owner-run") }
        })
      )

      expect(outcome.deadOwner).not.toBe(dead)
      // The live peer still holds its run: the probe found its pid in the
      // process table and the driver recorded `steal-refused-owner-alive`
      // rather than taking the row.
      expect(outcome.live).toMatchObject({ status: "running", owner_host_id: host, owner_pid: peer.pid })
    } finally {
      peer.kill("SIGKILL")
      await rm(root, { recursive: true, force: true })
    }
  }, 120_000)
})
