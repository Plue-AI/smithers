/**
 * What survives a host that was KILLED, and what the next one does about it.
 *
 * The signal test next door proves the graceful half: a host that is asked to
 * stop runs its finalizers and takes its children with it. This is the other
 * half, and the one A31 exists for. A `SIGKILL`ed host runs no finalizer, so
 * the agents it started keep running with nobody holding a handle to them, and
 * the only thing that can ever reach them again is the record it wrote to the
 * journal before it died.
 *
 * Everything here is real: a real child process running the real `layerHost`
 * composition over a real SQLite file, a real `SIGKILL`, a real orphaned
 * process group, and a second incarnation of the same `hostId` over the same
 * database. A double at any of those points would prove nothing, because the
 * subject is precisely what is left when no code of ours got to run.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import { ProcessLedger } from "@smthrs/kernel"
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import * as NodeRuntime from "../src/NodeRuntime.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-reap-host-"))
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "reap-host.ts")
const previousJj = process.env.SMITHERS_JJ_PATH

beforeAll(() => {
  // These hosts exercise containment, without needing an installed jj or a repository.
  const binary = join(directory, "jj")
  writeFileSync(binary, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"jj 0.39.0\"; fi\n", { mode: 0o755 })
  process.env.SMITHERS_JJ_PATH = binary
})

afterAll(() => {
  if (previousJj === undefined) delete process.env.SMITHERS_JJ_PATH
  else process.env.SMITHERS_JJ_PATH = previousJj
  rmSync(directory, { recursive: true, force: true })
})

const groupIsAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Runs the host until it reports the group it started, then `SIGKILL`s it and
 * waits for the operating system to reap it, so its pid reads as gone.
 */
const killHost = (filename: string, hostId: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture, filename, hostId, "reap-run"], {
      stdio: ["ignore", "pipe", "pipe"]
    })
    let announced = ""
    let stderr = ""
    let pgid: number | undefined
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`the host never announced a spawned group: ${stderr}`))
    }, 60_000)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      announced += chunk
      if (pgid === undefined && announced.includes("\n")) {
        pgid = Number(announced.split("\n")[0])
        // No handler runs for this. Whatever the host had open stays open.
        child.kill("SIGKILL")
      }
    })
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("exit", () => {
      clearTimeout(timer)
      if (pgid === undefined) reject(new Error(`the host exited before announcing: ${stderr}`))
      else resolve(pgid)
    })
  })

/**
 * A journal-backed ledger over one runtime file, with NO reaper attached.
 *
 * `layerHost` reaps while it is being built, so a test that only stands a host
 * up can never see what the sweep was handed. This composes the same ledger
 * over the same storage the host uses and stops there, which is the only way
 * to observe `orphans` before anything acts on it.
 */
const ledgerOver = (filename: string, hostId: string) =>
  ProcessLedger.layer({ hostId, ownerPid: process.pid }).pipe(
    Layer.provide(NodeRuntime.storage(filename)),
    Layer.provide(Layer.merge(NodeHost.layer, NodeHost.NodeCrypto.layer))
  )

const readBack = <A>(filename: string, query: (database: DatabaseSync) => A): A => {
  const database = new DatabaseSync(filename, { readOnly: true })
  try {
    return query(database)
  } finally {
    database.close()
  }
}

describe("a host that was killed", () => {
  it("journals and retires the jj probe before recording its live child", async () => {
    const filename = join(directory, "probe", "runtime.sqlite")
    const pgid = await killHost(filename, "probe-host")
    try {
      expect(
        readBack(
          filename,
          (database) =>
            database.prepare("SELECT event_type FROM flows_journal_events WHERE run_id = ? ORDER BY seq")
              .all("flows.host:probe-host")
        )
      ).toEqual([
        { event_type: "flows.host.process-spawned.v1" },
        { event_type: "flows.host.process-exited.v1" },
        { event_type: "flows.host.process-spawned.v1" }
      ])
    } finally {
      process.kill(-pgid, "SIGKILL")
    }
  }, 120_000)

  it("leaves its children for the next incarnation of the same host to reap", async () => {
    const filename = join(directory, "reap", "runtime.sqlite")

    const pgid = await killHost(filename, "reap-host")

    // The host is gone and its children are not: this is the state a crash
    // actually produces, and the state scope closure can do nothing about.
    expect(groupIsAlive(pgid)).toBe(true)
    expect(
      readBack(filename, (database) =>
        database
          .prepare(
            "SELECT event_type FROM flows_journal_events WHERE run_id = ? ORDER BY seq"
          )
          .all("flows.host:reap-host"))
    ).toEqual([
      { event_type: "flows.host.process-spawned.v1" },
      { event_type: "flows.host.process-exited.v1" },
      { event_type: "flows.host.process-spawned.v1" }
    ])

    // A second incarnation of the SAME host over the SAME database. It is
    // handed nothing about the dead one but its id.
    await Effect.runPromise(
      Effect.void.pipe(
        Effect.provide(
          NodeRuntime.layerHost(
            { filename, workspaceRoot: directory, owner: { hostId: "reap-host" }, signals: [] },
            Layer.empty
          )
        ),
        Effect.scoped
      )
    )

    const deadline = Date.now() + 10_000
    while (groupIsAlive(pgid) && Date.now() < deadline) await sleep(50)
    expect(groupIsAlive(pgid)).toBe(false)

    // And it said so durably, so a third incarnation does not try the same kill
    // against a pid the operating system has since handed to somebody else.
    expect(
      readBack(filename, (database) =>
        database
          .prepare(
            "SELECT event_type FROM flows_journal_events WHERE run_id = ? ORDER BY seq"
          )
          .all("flows.host:reap-host"))
    ).toEqual([
      { event_type: "flows.host.process-spawned.v1" },
      { event_type: "flows.host.process-exited.v1" },
      { event_type: "flows.host.process-spawned.v1" },
      { event_type: "flows.host.process-reaped.v1" },
      { event_type: "flows.host.process-spawned.v1" },
      { event_type: "flows.host.process-exited.v1" }
    ])
  }, 120_000)

  it("names the abandoned group in `orphans` before anything signals it", async () => {
    const filename = join(directory, "orphans", "runtime.sqlite")

    const pgid = await killHost(filename, "orphan-host")
    expect(groupIsAlive(pgid)).toBe(true)

    // The next incarnation is handed nothing but the host id, and what it
    // inherits through the journal is the process GROUP the dead one led. A
    // record naming a pid with no group would be one the reaper must refuse,
    // so this is the half of the contract the kill assertion cannot show.
    const orphans = await Effect.runPromise(
      Effect.flatMap(ProcessLedger.ProcessLedger, (ledger) => ledger.orphans).pipe(
        Effect.provide(ledgerOver(filename, "orphan-host")),
        Effect.scoped
      )
    )

    expect(orphans).toEqual([
      expect.objectContaining({
        pid: pgid,
        pgid,
        hostId: "orphan-host"
      })
    ])
    // The record names the program it started and none of its arguments. The
    // host confines every spawn (#3140), so that program is the sandbox
    // launcher wherever one exists, not the `sh` the action asked for.
    expect(orphans[0]?.commandDigest).toMatch(/^\S+$/)
    expect(orphans[0]?.commandDigest).not.toContain("sleep")
    expect(orphans[0]?.ownerPid).not.toBe(process.pid)

    // And the reaper, given exactly that, ends the group.
    const reaped = await Effect.runPromise(
      ProcessReaper.reap().pipe(Effect.provide(ledgerOver(filename, "orphan-host")), Effect.scoped)
    )

    expect(reaped).toEqual([{ record: expect.objectContaining({ pid: pgid, pgid }), killed: true }])
    const deadline = Date.now() + 10_000
    while (groupIsAlive(pgid) && Date.now() < deadline) await sleep(50)
    expect(groupIsAlive(pgid)).toBe(false)
  }, 120_000)
})
