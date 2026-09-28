/**
 * Reaping real abandoned process groups.
 *
 * The reaper's whole subject is a process nobody holds a handle for, so a
 * double proves nothing here: these cases start real detached groups, record
 * them in a real journal-backed ledger under a pid that has genuinely exited,
 * and then assert the pids are gone from the operating system.
 *
 * `it.live` throughout: the waits below are real elapsed time.
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalError } from "@smthrs/journal/Journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { ProcessLedger } from "@smthrs/kernel"
import { Clock, Effect } from "effect"
import type * as Scope from "effect/Scope"
import NativeMutable, { spawn } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join, parse, win32 } from "node:path"
import { afterAll, vi } from "vitest"
import * as ProcessReaper from "../src/ProcessReaper.ts"
import { waitForExit } from "./helpers/waitForExit.ts"

const directory = mkdtempSync(join(tmpdir(), "flows-reaper-"))

const run = <A, E>(effect: Effect.Effect<A, E, Journal | Scope.Scope>) =>
  effect.pipe(Effect.provide(TestJournal.layer()), Effect.scoped)

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Reads a pid a child wrote to a file. */
const readPid = async (path: string): Promise<number> => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      const text = readFileSync(path, "utf8").trim()
      if (text !== "") return Number(text)
    } catch {
      // not written yet
    }
    await sleep(10)
  }
  throw new Error(`child never wrote ${path}`)
}

const nativeSystem = ProcessReaper.systemFor(process.platform)
const spawnedTrees: Array<ReturnType<typeof spawn>> = []
const treeGroup = (pid: number): number | null => process.platform === "win32" ? null : pid

/** A real leader and child, with an IPC readiness barrier before the pid file. */
const startOrphanGroup = async (name: string): Promise<{ leader: number; follower: number; pgid: number | null }> => {
  const pidFile = join(directory, `${name}.pid`)
  const followerProgram = "process.send('ready');setInterval(()=>{},1000)"
  const program = `const child=require('node:child_process').spawn(process.execPath,['-e',${
    JSON.stringify(followerProgram)
  }],{stdio:['ignore','ignore','ignore','ipc']});
    child.once('message',()=>require('node:fs').writeFileSync(${JSON.stringify(pidFile)},String(child.pid)));
    setInterval(()=>{},1000);`
  const child = spawn(process.execPath, ["-e", program], { detached: true, windowsHide: true, stdio: "ignore" })
  spawnedTrees.push(child)
  child.unref()
  const follower = await readPid(pidFile)
  return { leader: child.pid!, follower, pgid: treeGroup(child.pid!) }
}

/** Replay the old owner's record at the creation time the OS actually observed. */
const recordTree = (ledger: ProcessLedger.Service, group: { leader: number; pgid: number | null }) => {
  const observed = nativeSystem.startedAtMs(group.leader)
  expect(observed._tag).toBe("started")
  if (observed._tag !== "started") throw new Error("fixture process identity was not observed")
  const clock = Clock.Clock.defaultValue()
  return ledger.record({ pid: group.leader, pgid: group.pgid, commandDigest: "node process tree" }).pipe(
    Effect.provideService(Clock.Clock, {
      currentTimeMillisUnsafe: () => observed.startedAtMs,
      currentTimeMillis: Effect.succeed(observed.startedAtMs),
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
      currentTimeNanos: clock.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos,
      sleep: (duration) => clock.sleep(duration)
    })
  )
}

/** A pid that exited before it is returned to the ledger test. */
const exitedPid = async (): Promise<number> => {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore", windowsHide: true })
  const pid = child.pid!
  await new Promise<void>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", () => resolve())
  })
  return pid
}

const stopTree = (pid: number) =>
  nativeSystem.killTree({
    pid,
    pgid: treeGroup(pid),
    hostId: "fixture-cleanup",
    ownerPid: process.pid,
    startedAtMs: 0,
    commandDigest: "fixture"
  })
const cleanup = () => {
  for (const child of spawnedTrees) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) stopTree(child.pid)
  }
  rmSync(directory, { recursive: true, force: true })
}

/** The record the Windows cases signal, which never names a real process. */
const windowsRecord = {
  pid: 4321,
  pgid: null,
  hostId: "windows",
  ownerPid: 4320,
  startedAtMs: 0,
  commandDigest: "agent.exe"
} as const

/**
 * A `ps` stand-in at an absolute path that prints `printed` and exits `status`.
 *
 * The probe resolves `ps` as an absolute path and never through `PATH`, so a
 * shim on `PATH` can no longer reach it — which is the point of the guard. The
 * parsing branches are driven through the configured executable instead.
 */
const psAnswers = new Map<string, { readonly stdout: string; readonly status: number }>()
const psShim = (name: string, printed: string, status = 0): string => {
  const bin = join(directory, `ps-${name}`)
  mkdirSync(bin, { recursive: true })
  const executable = join(bin, "ps")
  psAnswers.set(executable, { stdout: printed, status })
  writeFileSync(executable, `#!/bin/sh\nprintf '%s' '${printed}'\nexit ${status}\n`)
  chmodSync(executable, 0o755)
  return executable
}

/** Real POSIX fixtures; Windows exercises their native command result contract. */
const withPs = (executable: string, nativeResult = process.platform === "win32") => {
  const system = ProcessReaper.posixSystemWith({ psExecutable: executable })
  const answer = psAnswers.get(executable)
  if (!nativeResult || answer === undefined) return system
  // Windows cannot execute a POSIX shebang. Supply the requested ps result
  // while leaving the real kernel liveness probe and parser in production.
  const query = <A>(body: () => A): A => {
    const original = NativeMutable.spawnSync
    const mocked = vi.spyOn(NativeMutable, "spawnSync").mockImplementation((...args: Parameters<typeof original>) => {
      expect(args[0]).toBe(executable)
      return { pid: 0, output: [], stdout: answer.stdout, stderr: "", signal: null, status: answer.status }
    })
    syncBuiltinESMExports()
    try {
      return body()
    } finally {
      mocked.mockRestore()
      syncBuiltinESMExports()
    }
  }
  return {
    ...system,
    startedAtMs: (pid: number) => query(() => system.startedAtMs(pid)),
    ownGroup: () => query(() => system.ownGroup())
  }
}

/** The system taskkill the reaper must name: never a bare, searchable command. */
const taskkill = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe")

/** Exercises the native taskkill result without signalling a real process. */
const withTaskkill = <A>(status: number | Error, body: () => A): A => {
  const original = NativeMutable.spawnSync
  const mocked = vi.spyOn(NativeMutable, "spawnSync").mockImplementation((...args: Parameters<typeof original>) => {
    // A bare "taskkill" is resolved from the cwd first on Windows, where a
    // flow can plant taskkill.exe; the reaper must name System32's.
    if (args[0] !== taskkill) throw new Error(`unexpected executable ${String(args[0])}`)
    expect(args[1]).toEqual(["/pid", "4321", "/T", "/F"])
    expect(args[2]).toMatchObject({ env: { SystemRoot: win32.dirname(win32.dirname(taskkill)) } })
    expect((args[2] as { readonly cwd?: string }).cwd).toBe(parse(process.execPath).root)
    return {
      pid: 0,
      output: [],
      stdout: "",
      stderr: "",
      signal: null,
      status: typeof status === "number" ? status : null,
      ...(status instanceof Error ? { error: status } : {})
    }
  })
  syncBuiltinESMExports()
  try {
    return body()
  } finally {
    mocked.mockRestore()
    syncBuiltinESMExports()
  }
}

/** Writes one scripted executable and returns the directory holding it. */
const shimBin = (name: string, command: string, script: string): string => {
  const bin = join(directory, name)
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, command), script)
  chmodSync(join(bin, command), 0o755)
  return bin
}

/**
 * A record built by hand, standing in for one read out of a durable journal.
 *
 * `ProcessLedger` will not WRITE most of the shapes the reaper has to defend
 * against, which is exactly why the reaper defends against them: the input is a
 * row that outlived the process that produced it.
 */
const target = (pid: number, pgid: number | null, commandDigest: string): ProcessLedger.ProcessRecord => ({
  pid,
  pgid,
  hostId: "targets",
  ownerPid: 2_147_483_646,
  startedAtMs: 0,
  commandDigest
})

/** A ledger that answers with `orphans` and records what the sweep retired. */
const spyLedger = (orphans: ReadonlyArray<ProcessLedger.ProcessRecord>) => {
  const skipped: Array<readonly [number, string]> = []
  const reaped: Array<number> = []
  const service: ProcessLedger.Service = {
    record: () => Effect.die("the sweep never records"),
    release: () => Effect.die("the sweep never releases"),
    reaped: (record) => Effect.sync(() => void reaped.push(record.pid)),
    skipped: (record, reason) => Effect.sync(() => void skipped.push([record.pid, reason])),
    live: Effect.succeed([]),
    orphans: Effect.succeed(orphans)
  }
  return { service, skipped, reaped }
}

/** Runs `body` with one scripted executable shadowing `command` on PATH. */
const withShim = <A>(name: string, command: string, script: string, body: () => A): A => {
  const bin = shimBin(name, command, script)
  const previous = process.env["PATH"]
  process.env["PATH"] = `${bin}:${previous ?? ""}`
  try {
    return body()
  } finally {
    process.env["PATH"] = previous
  }
}

describe("ProcessReaper", () => {
  it.live("kills a group a dead incarnation abandoned and journals the reaping", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("abandoned"))
      const deadOwner = yield* Effect.promise(exitedPid)

      const outcome = yield* run(
        Effect.gen(function*() {
          // The incarnation that started the process, and then died.
          const previous = yield* ProcessLedger.make({ hostId: "reaped-host", ownerPid: deadOwner })
          yield* recordTree(previous, group)

          // This incarnation inherits the record through the journal alone.
          const current = yield* ProcessLedger.make({ hostId: "reaped-host", ownerPid: process.pid })
          const reaped = yield* ProcessReaper.reap().pipe(Effect.provideService(ProcessLedger.ProcessLedger, current))

          const journal = yield* Journal
          const page = yield* journal.entries({
            runId: ProcessLedger.hostRunId("reaped-host"),
            limit: 16
          })
          // A third incarnation must not try the same kill again.
          const third = yield* ProcessLedger.make({ hostId: "reaped-host", ownerPid: process.pid })
          return { reaped, types: page.entries.map((row) => row.eventType), remaining: yield* third.orphans }
        })
      )

      expect(outcome.reaped).toEqual([
        {
          record: expect.objectContaining({ pid: group.leader, pgid: group.pgid, ownerPid: deadOwner }),
          killed: true
        }
      ])
      expect(outcome.types).toEqual(["flows.host.process-spawned.v1", "flows.host.process-reaped.v1"])
      expect(outcome.remaining).toEqual([])

      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
      // The background process nothing ever held a handle for died with it.
      expect(yield* Effect.promise(() => waitForExit(group.follower, 2_000))).toBe(true)
    }))

  it.live("leaves a record alone while the incarnation that owns it is alive", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("owned"))

      const reaped = yield* run(
        Effect.gen(function*() {
          // `ownerPid` is this very process, which is alive by construction.
          const previous = yield* ProcessLedger.make({ hostId: "live-host", ownerPid: process.pid })
          yield* recordTree(previous, group)
          const current = yield* ProcessLedger.make({ hostId: "live-host", ownerPid: 1 })
          return yield* ProcessReaper.reap({ ownerPid: 1 }).pipe(
            Effect.provideService(ProcessLedger.ProcessLedger, current)
          )
        })
      )

      expect(reaped.map((entry) => entry.killed)).toEqual([false])
      expect(reaped.map((entry) => entry.refusal)).toEqual(["owner-alive"])
      // Still running: the reaper refused to touch a live owner's child.
      expect(yield* Effect.promise(() => waitForExit(group.leader, 0))).toBe(false)
      stopTree(group.leader)
      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
    }))

  it.effect("refuses records it must not signal", () =>
    run(
      Effect.gen(function*() {
        const deadOwner = 2_147_483_646
        const previous = yield* ProcessLedger.make({ hostId: "refusals", ownerPid: deadOwner })
        // Shared the dead incarnation's own group, so there is no group to kill.
        yield* previous.record({ pid: 11, pgid: null, commandDigest: "shared-group" })
        // Claims THIS host's group; a record can say anything.
        yield* previous.record({ pid: 12, pgid: 4242, commandDigest: "our-group" })
        // Claims this host's own pid.
        yield* previous.record({ pid: 4242, pgid: 99, commandDigest: "our-pid" })

        const current = yield* ProcessLedger.make({ hostId: "refusals", ownerPid: 1 })
        const killed: Array<number> = []
        const reaped = yield* ProcessReaper.reap({
          ownerPid: 4242,
          system: {
            ...ProcessReaper.posixSystem,
            isAlive: () => "dead",
            ownGroup: () => null,
            killTree: (record) => {
              killed.push(record.pid)
              return "signalled"
            }
          }
        }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, current))

        expect(reaped.map((entry) => entry.killed)).toEqual([false, false, false])
        expect(reaped.map((entry) => entry.refusal)).toEqual(["no-group", "own-group", "own-group"])
        expect(killed).toEqual([])
      })
    ))

  /**
   * The numbers a reaper signals arrive from durable state, so the sweep has to
   * refuse the ones no platform can turn into a target. `pgid: 0` is the one
   * that matters most: `process.kill(-0, "SIGKILL")` is `process.kill(0, ...)`,
   * which POSIX defines as signalling THIS process's entire process group.
   */
  it.effect("refuses a durable record whose numbers name nothing it may signal", () =>
    Effect.gen(function*() {
      // Held by hand rather than through the ledger: `ProcessLedger`'s schema
      // types `pid` as an integer, so the corrupt shapes this guard exists for
      // cannot be written through it. They can still be READ out of a journal
      // an older or foreign writer produced, which is the input under test.
      const orphans = [
        target(0, 0, "own-group-through-zero"),
        target(-5, -5, "negative"),
        target(2.5, 2.5, "fractional"),
        target(4321, 9876, "leads-no-group")
      ]
      const killed: Array<number> = []
      const ledger = spyLedger(orphans)
      const reaped = yield* ProcessReaper.reap({
        ownerPid: 987_653,
        system: {
          ...ProcessReaper.posixSystem,
          isAlive: () => "dead",
          ownGroup: () => null,
          killTree: (record) => {
            killed.push(record.pid)
            return "signalled"
          }
        }
      }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, ledger.service))

      expect(reaped.map((entry) => entry.refusal)).toEqual([
        "invalid-record",
        "invalid-record",
        "invalid-record",
        "invalid-record"
      ])
      expect(killed).toEqual([])
      // Nothing the operating system will revisit, so all four are retired.
      expect(ledger.skipped).toEqual([
        [0, "invalid-record"],
        [-5, "invalid-record"],
        [2.5, "invalid-record"],
        [4321, "invalid-record"]
      ])
    }))

  /**
   * The identity guard is the one that catches pid reuse inside a single boot,
   * so a host that cannot ASK the question must not signal anyway. It is also
   * the one refusal that has to keep its record: a later incarnation, or the
   * same host with `ps` installed, can answer what this one could not.
   */
  it.effect("keeps a record it could not verify instead of killing on no evidence", () =>
    Effect.gen(function*() {
      const ledger = spyLedger([{ ...target(987_654, 987_654, "unverifiable"), startedAtMs: Date.now() }])
      const killed: Array<number> = []
      const reaped = yield* ProcessReaper.reap({
        ownerPid: 1,
        system: {
          ...ProcessReaper.posixSystem,
          isAlive: () => "dead",
          // Resolvable, so the guard this case is about is the one that runs.
          ownGroup: () => 1,
          // A host with no usable `ps`: busybox, distroless, or a probe that
          // timed out.
          startedAtMs: () => ({ _tag: "unavailable" }),
          killTree: (record) => {
            killed.push(record.pid)
            return "signalled"
          }
        }
      }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, ledger.service))

      expect(reaped.map((entry) => entry.refusal)).toEqual(["identity-unverified"])
      expect(killed).toEqual([])
      // Retired nothing: the record is still there for a host that can ask.
      expect(ledger.skipped).toEqual([])
      expect(ledger.reaped).toEqual([])
    }))

  /**
   * The own-group comparison is the guard that stops a stale record naming the
   * shell this host runs in. It is read from `ps` like the start time, so it can
   * be unavailable on its own, and skipping a guard that could not run is not
   * the same as running it and passing.
   */
  it.effect("keeps a record when it could not read its own process group", () =>
    Effect.gen(function*() {
      const ledger = spyLedger([{ ...target(987_654, 987_654, "unknown-group"), startedAtMs: Date.now() }])
      const killed: Array<number> = []
      const reaped = yield* ProcessReaper.reap({
        ownerPid: 1,
        system: {
          ...ProcessReaper.posixSystem,
          isAlive: () => "dead",
          ownGroup: () => null,
          startedAtMs: () => ({ _tag: "started", startedAtMs: Date.now() }),
          killTree: (record) => {
            killed.push(record.pid)
            return "signalled"
          }
        }
      }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, ledger.service))

      expect(reaped.map((entry) => entry.refusal)).toEqual(["own-group-unknown"])
      expect(killed).toEqual([])
      expect(ledger.skipped).toEqual([])
    }))

  it.effect("retires a record whose pid the operating system says is gone", () =>
    Effect.gen(function*() {
      const ledger = spyLedger([{ ...target(987_654, 987_654, "already-exited"), startedAtMs: Date.now() }])
      const killed: Array<number> = []
      const reaped = yield* ProcessReaper.reap({
        ownerPid: 1,
        system: {
          ...ProcessReaper.posixSystem,
          isAlive: () => "dead",
          ownGroup: () => 1,
          startedAtMs: () => ({ _tag: "gone" }),
          killTree: (record) => {
            killed.push(record.pid)
            return "signalled"
          }
        }
      }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, ledger.service))

      expect(reaped.map((entry) => entry.refusal)).toEqual(["process-gone"])
      expect(killed).toEqual([])
      expect(ledger.skipped).toEqual([[987_654, "process-gone"]])
    }))

  /**
   * `identityToleranceMs` decides which side of the boot instant a record falls
   * on, and the cut is deliberately inclusive of the tolerance window: a record
   * written exactly `identityToleranceMs` after the computed boot is the first
   * one the sweep is willing to look at.
   */
  it.effect("pins which side of the boot cut each tolerance boundary falls on", () =>
    Effect.gen(function*() {
      const bootMs = 1_000_000_000_000
      const at = (offset: number) => bootMs + ProcessReaper.identityToleranceMs + offset
      const orphans = [-1, 0, 1].map((offset, index) => ({
        ...target(900_000 + index, 900_000 + index, "boundary"),
        startedAtMs: at(offset)
      }))
      const ledger = spyLedger(orphans)
      const reaped = yield* ProcessReaper.reap({
        ownerPid: 1,
        system: {
          ...ProcessReaper.posixSystem,
          isAlive: () => "dead",
          ownGroup: () => 1,
          bootedAtMs: () => bootMs,
          startedAtMs: () => ({ _tag: "unsupported" }),
          killTree: () => "signalled"
        }
      }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, ledger.service))

      expect(reaped.map((entry) => entry.refusal)).toEqual(["pre-boot", undefined, undefined])
      expect(reaped.map((entry) => entry.killed)).toEqual([false, true, true])
      // A `pre-boot` refusal is RETIRED, not retried: the group it names is
      // never reaped by any later incarnation either.
      expect(ledger.skipped).toEqual([[900_000, "pre-boot"]])
    }))

  /**
   * Windows containment is unsupported best-effort at 1.0.0-rc.0, but it must
   * not be a silent no-op: before the platform-specific target check existed, a
   * win32 record — which always carries `pgid: null` — was refused as
   * `no-group` before `taskkill` was ever consulted, so `windowsSystem` was
   * unreachable through `reap` and every Windows orphan was retired unkilled.
   */
  it.effect("reaches taskkill for a Windows record through the sweep, not only by hand", () =>
    Effect.gen(function*() {
      const record = { ...target(4321, null, "agent.exe"), startedAtMs: Date.now() }
      const ledger = spyLedger([record])
      const query = vi.spyOn(NativeMutable, "spawnSync").mockImplementation((executable, args) => {
        if (args?.[0] === "--process-info") {
          expect(args).toEqual(["--process-info", "4321"])
          return {
            pid: 0,
            output: [],
            stdout: JSON.stringify({ status: "started", startedAtMs: record.startedAtMs }),
            stderr: "",
            status: 0,
            signal: null
          }
        }
        expect(executable).toBe(taskkill)
        expect(args).toEqual(["/pid", "4321", "/T", "/F"])
        return { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null }
      })
      syncBuiltinESMExports()
      try {
        const reaped = yield* ProcessReaper.reap({
          ownerPid: 1,
          system: ProcessReaper.windowsSystemWith({ processExecutable: process.execPath })
        }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, ledger.service))
        expect(reaped).toEqual([{ record, killed: true }])
        expect(ledger.reaped).toEqual([4321])
        expect(query).toHaveBeenCalledTimes(2)
      } finally {
        query.mockRestore()
        syncBuiltinESMExports()
      }
    }))

  it("answers liveness from the operating system, and never confuses EPERM with gone", () => {
    expect(ProcessReaper.posixSystem.isAlive(process.pid)).toBe("alive")
    // ESRCH: nothing has this pid.
    expect(ProcessReaper.posixSystem.isAlive(2_147_483_646)).toBe("dead")
    // pid 1 is `launchd`/`init`, owned by root. Unless this suite runs as
    // root the answer is EPERM, which means the process is THERE. Reading
    // that as "dead" is what would let a reaper kill another user's children.
    expect(nativeSystem.isAlive(process.platform === "win32" ? 4 : 1)).not.toBe("dead")
  })

  it("reads a process start time and this process's own group from the system", () => {
    const started = nativeSystem.startedAtMs(process.pid)
    expect(started._tag).toBe("started")
    const startedAtMs = (started as { readonly startedAtMs: number }).startedAtMs
    // This process started before now and after this machine booted.
    expect(startedAtMs).toBeLessThanOrEqual(Date.now() + 1000)
    expect(startedAtMs).toBeGreaterThanOrEqual(nativeSystem.bootedAtMs() - 60_000)
    // A pid nothing owns is EVIDENCE the record describes nothing, which is a
    // different answer from a probe that could not be run at all.
    expect(nativeSystem.startedAtMs(2_147_483_646)).toEqual({ _tag: "gone" })
    if (process.platform === "win32") expect(nativeSystem.ownGroup()).toBeNull()
    else expect(nativeSystem.ownGroup()).toBeTypeOf("number")
    // The probe is an absolute path, so it is `/bin/ps` and never a `PATH` hit.
    expect(ProcessReaper.defaultPsExecutable).toBe("/bin/ps")

    // A `ps` that answers with something unusable is the same as a `ps` that
    // cannot answer: no evidence, and no evidence never authorizes a kill.
    expect(withPs(psShim("garbage", "not a date"), true).startedAtMs(process.pid)).toEqual({ _tag: "unavailable" })
    expect(withPs(psShim("silent", "")).startedAtMs(process.pid)).toEqual({ _tag: "unavailable" })
    // A `ps` that is not there at all is the same absence of evidence.
    expect(withPs(join(directory, "no-such-ps")).startedAtMs(process.pid)).toEqual({ _tag: "unavailable" })
    expect(withPs(psShim("wordy", "not a number")).ownGroup()).toBeNull()
    expect(withPs(psShim("mute", "")).ownGroup()).toBeNull()
    expect(withPs(psShim("absent", "", 1)).ownGroup()).toBeNull()
    // A PREFIX that parses is the dangerous shape, because it answers with a
    // number that is not this host's group: the own-group comparison then
    // passes on a false identity, and because the answer is not `null` the
    // `own-group-unknown` refusal that reports an unmade comparison never
    // fires either. Every one of these is a group the host does not have.
    expect(withPs(psShim("prefixed", "12 34")).ownGroup()).toBeNull()
    expect(withPs(psShim("suffixed", "12abc")).ownGroup()).toBeNull()
    expect(withPs(psShim("hexadecimal", "0x10")).ownGroup()).toBeNull()
    expect(withPs(psShim("signed", "-1")).ownGroup()).toBeNull()
    // No live process leads group zero, and a group past the safe-integer range
    // is a number the comparison could not be trusted with.
    expect(withPs(psShim("zero", "0")).ownGroup()).toBeNull()
    expect(withPs(psShim("enormous", "9007199254740993")).ownGroup()).toBeNull()

    // A nonzero exit is how `ps` says "no such pid", and also how a `ps` that
    // rejected the column, or is not a `ps` at all, answers about a pid that is
    // very much alive. Retiring a live orphan as `gone` on that is the same
    // fail-open the start-time check exists to close, so the kernel is asked.
    expect(withPs(psShim("refusing", "", 2)).startedAtMs(process.pid)).toEqual({ _tag: "unavailable" })
    expect(withPs(psShim("refusing", "", 2)).startedAtMs(2_147_483_646)).toEqual({ _tag: "gone" })
  })

  /**
   * The probe blocks the event loop while a host is being built, so its
   * deadline has to be one the process it runs cannot decline. `spawnSync`'s
   * `timeout` sends `SIGTERM`, and then keeps waiting for a child that ignores
   * it, which is not a deadline at all: a `ps` that traps `TERM` held layer
   * construction for as long as it liked. The signal is `SIGKILL` instead.
   *
   * The bound covers the process the probe starts, not its descendants: a
   * child of that child inherits the stdout pipe and `spawnSync` waits for the
   * pipe to close. `/bin/ps` starts nothing, so that is the whole of what this
   * has to hold for.
   */
  it("bounds the probe even when the process it runs ignores SIGTERM", () => {
    const stubborn = `process.on("SIGTERM", () => {}); setTimeout(() => {}, 60000);`
    const executable = join(
      shimBin("ps-stubborn", "ps", `#!/bin/sh\nexec '${process.execPath}' -e '${stubborn}'\n`),
      "ps"
    )
    const started = Date.now()
    // No answer, and the absence of one keeps the record rather than killing.
    expect(withPs(executable).startedAtMs(process.pid)).toEqual({ _tag: "unavailable" })
    expect(Date.now() - started).toBeLessThan(30_000)
  }, 90_000)

  it("refuses to signal a durable record whose numbers name nothing it may kill", () => {
    const row = (pid: number, pgid: number | null) => target(pid, pgid, "target")
    // `process.kill(-0, ...)` signals THIS process's group, so zero is the one
    // value that must never reach the negation.
    expect(ProcessReaper.posixSystem.refuseTarget(row(0, 0))).toBe("invalid-record")
    expect(ProcessReaper.posixSystem.refuseTarget(row(-5, -5))).toBe("invalid-record")
    expect(ProcessReaper.posixSystem.refuseTarget(row(2.5, 2.5))).toBe("invalid-record")
    expect(ProcessReaper.posixSystem.refuseTarget(row(1, 1))).toBe("invalid-record")
    // A plausible pid carrying an unsignalable group, which is the half of the
    // record the negation actually reaches.
    expect(ProcessReaper.posixSystem.refuseTarget(row(4321, 0))).toBe("invalid-record")
    expect(ProcessReaper.posixSystem.refuseTarget(row(4321, -5))).toBe("invalid-record")
    expect(ProcessReaper.posixSystem.refuseTarget(row(4321, 2.5))).toBe("invalid-record")
    // A child that does not lead the group it claims.
    expect(ProcessReaper.posixSystem.refuseTarget(row(4321, 9876))).toBe("invalid-record")
    expect(ProcessReaper.posixSystem.refuseTarget(row(4321, null))).toBe("no-group")
    expect(ProcessReaper.posixSystem.refuseTarget(row(4321, 4321))).toBeUndefined()

    // Windows records the absence of a group, so there the numbers invert.
    expect(ProcessReaper.windowsSystem.refuseTarget(row(4321, 4321))).toBe("invalid-record")
    expect(ProcessReaper.windowsSystem.refuseTarget(row(0, null))).toBe("invalid-record")
    expect(ProcessReaper.windowsSystem.refuseTarget(row(0x1_0000_0000, null))).toBe("invalid-record")
    expect(ProcessReaper.windowsSystem.refuseTarget(row(4321, null))).toBeUndefined()

    // The guard is repeated inside the kill itself, because both systems are
    // exported and a caller can reach them without going through `reap`.
    expect(ProcessReaper.posixSystem.killTree(row(0, 0))).toBe("failed")
    expect(ProcessReaper.posixSystem.killTree(row(4321, null))).toBe("failed")
    expect(ProcessReaper.windowsSystem.killTree(row(4321, 4321))).toBe("failed")
    // This process is still here, which is what the zero check exists for.
    expect(ProcessReaper.posixSystem.isAlive(process.pid)).toBe("alive")
  })

  /**
   * `reap` reads this host's identity once and compares every record against
   * it, but both systems are EXPORTED and `killTree` is the one place a stored
   * number becomes a signal. A caller that reaches it directly has made no such
   * comparison, so the function makes its own: `process.kill(-pgid)` does not
   * care which way the number arrived.
   *
   * Every number below is past the range a pid can take, so a regression that
   * removed a guard signals nothing on this machine; it answers `already-gone`
   * instead of `failed`, which is what fails the assertion.
   */
  it("refuses to kill a target naming the host, reached through the exported seam", () => {
    const host = 2_147_483_645
    const claimed = 2_147_483_646
    const row = (pid: number, pgid: number | null) => target(pid, pgid, "seam")
    const posix = ProcessReaper.posixSystemWith({
      ownerPid: host,
      psExecutable: psShim("own-group-seam", String(claimed))
    })

    // The host's own pid, as the record's pid and as the group it claims.
    expect(posix.killTree(row(host, host))).toBe("failed")
    // The group the probe reports for this process.
    expect(posix.killTree(row(claimed, claimed))).toBe("failed")
    // A group the probe cannot read is a comparison that did not happen, which
    // is not the same as one that ran and passed.
    expect(
      ProcessReaper.posixSystemWith({ ownerPid: host, psExecutable: psShim("mute-group-seam", "") })
        .killTree(row(2_147_483_644, 2_147_483_644))
    ).toBe("failed")
    // A probe that answers with something a prefix parse would turn into a
    // number is the same absence of an answer. Reading `"2147483646 x"` as the
    // group would have let the record naming `2_147_483_644` through on a
    // comparison against a group this host does not have.
    expect(
      ProcessReaper.posixSystemWith({
        ownerPid: host,
        psExecutable: psShim("prefixed-group-seam", `${claimed} x`)
      }).killTree(row(2_147_483_644, 2_147_483_644))
    ).toBe("failed")

    // `taskkill /T` walks the tree DOWNWARD from the pid it is handed, so a
    // record naming this host takes the host and everything it started.
    const windows = ProcessReaper.windowsSystemWith({ ownerPid: host })
    expect(windows.refuseTarget(row(host, null))).toBe("own-group")
    expect(withTaskkill(0, () => windows.killTree(row(host, null)))).toBe("failed")
    expect(withTaskkill(0, () => windows.killTree(row(4321, null)))).toBe("signalled")
  })

  it("tells a group that settled apart from a signal that never left the process", () => {
    // ESRCH: nothing is there any more, which is the end state a kill wanted.
    expect(
      nativeSystem.killTree({
        pid: 2_147_483_646,
        pgid: treeGroup(2_147_483_646),
        hostId: "gone",
        ownerPid: 2_147_483_645,
        startedAtMs: 0,
        commandDigest: "gone"
      })
    ).toBe("already-gone")
    // Anything else is a kill that did NOT happen. A group id past the 32-bit
    // range the kernel accepts is the cheapest way to produce one: it passes
    // every record check and is still a number `process.kill` refuses.
    expect(
      nativeSystem.killTree({
        pid: 4_294_967_296,
        pgid: treeGroup(4_294_967_296),
        hostId: "unsignalable",
        ownerPid: 2,
        startedAtMs: 0,
        commandDigest: "unsignalable"
      })
    ).toBe("failed")
  })

  it("ends a Windows process tree with taskkill, and reads the status it reports", () => {
    // A native launch refusal must not count as successful cleanup.
    expect(withTaskkill(new Error("launch refused"), () => ProcessReaper.windowsSystem.killTree(windowsRecord))).toBe(
      "failed"
    )

    // Drive all native result statuses without targeting an unrelated pid.
    expect(withTaskkill(0, () => ProcessReaper.windowsSystem.killTree(windowsRecord))).toBe("signalled")
    expect(withTaskkill(128, () => ProcessReaper.windowsSystem.killTree(windowsRecord))).toBe("already-gone")
    expect(withTaskkill(1, () => ProcessReaper.windowsSystem.killTree(windowsRecord))).toBe("failed")

    expect(ProcessReaper.windowsSystem.startedAtMs(process.pid)).toMatchObject({
      _tag: process.platform === "win32" ? "started" : "unavailable"
    })
    expect(ProcessReaper.windowsSystem.ownGroup()).toBeNull()
    expect(ProcessReaper.systemFor("win32")).toBe(ProcessReaper.windowsSystem)
    expect(ProcessReaper.systemFor("darwin")).toBe(ProcessReaper.posixSystem)
  })

  it.each([
    ["D:\\Win", "D:\\Win\\System32\\taskkill.exe"],
    ["planted", "C:\\Windows\\System32\\taskkill.exe"],
    [undefined, "C:\\Windows\\System32\\taskkill.exe"]
  ])("names System32's taskkill under SystemRoot=%s, never a searchable bare name", (systemRoot, expected) => {
    const original = NativeMutable.spawnSync
    const seen: Array<unknown> = []
    const mocked = vi.spyOn(NativeMutable, "spawnSync").mockImplementation((...args: Parameters<typeof original>) => {
      seen.push(args[0], (args[2] as { readonly env?: unknown }).env)
      return { pid: 0, output: [], stdout: "", stderr: "", signal: null, status: 0 }
    })
    syncBuiltinESMExports()
    vi.stubEnv("SystemRoot", systemRoot)
    try {
      expect(ProcessReaper.windowsSystem.killTree(windowsRecord)).toBe("signalled")
      expect(seen).toEqual([expected, { SystemRoot: win32.dirname(win32.dirname(expected)) }])
    } finally {
      vi.unstubAllEnvs()
      mocked.mockRestore()
      syncBuiltinESMExports()
    }
  })

  it.live("finishes the sweep when the ledger cannot record what it decided", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("unrecorded"))
      const deadOwner = yield* Effect.promise(exitedPid)

      const reaped = yield* run(
        Effect.gen(function*() {
          const previous = yield* ProcessLedger.make({ hostId: "unrecorded-host", ownerPid: deadOwner })
          const record = yield* recordTree(previous, group)
          const refused = new JournalError({ code: "journal_closed", message: "journal is gone" })
          const broken: ProcessLedger.Service = {
            record: () => Effect.fail(refused),
            release: () => Effect.fail(refused),
            reaped: () => Effect.fail(refused),
            skipped: () => Effect.fail(refused),
            live: Effect.succeed([]),
            orphans: Effect.succeed([record])
          }
          return yield* ProcessReaper.reap().pipe(
            Effect.provideService(ProcessLedger.ProcessLedger, broken)
          )
        })
      )

      // The kill still happened; only the bookkeeping about it did not.
      expect(reaped.map((entry) => entry.killed)).toEqual([true])
      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
    }))

  it.live("refuses a record that names this host's REAL process group", () =>
    Effect.gen(function*() {
      // The number a record carries is not checked against the shell that
      // started this host anywhere else: `ownerPid` arithmetic alone would let
      // a stale record kill the group this test process is running in.
      const ours = nativeSystem.ownGroup()
      if (process.platform === "win32") expect(ours).toBeNull()
      else expect(ours).toBeTypeOf("number")
      const deadOwner = yield* Effect.promise(exitedPid)
      const killed: Array<number> = []

      const reaped = yield* run(
        Effect.gen(function*() {
          const previous = yield* ProcessLedger.make({ hostId: "own-group", ownerPid: deadOwner })
          yield* previous.record({
            pid: process.platform === "win32" ? process.pid : 987_654,
            pgid: ours,
            commandDigest: "claims our group"
          })
          const current = yield* ProcessLedger.make({ hostId: "own-group", ownerPid: process.pid })
          return yield* ProcessReaper.reap({
            // A pid this host does NOT have, so only the group check can save it.
            ownerPid: 987_653,
            system: {
              ...nativeSystem,
              killTree: (record) => {
                killed.push(record.pgid as number)
                return "signalled"
              }
            }
          }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, current))
        })
      )

      expect(reaped.map((entry) => entry.refusal)).toEqual(["own-group"])
      expect(killed).toEqual([])
      // This process is still here, which is the point of the check.
      expect(ProcessReaper.posixSystem.isAlive(process.pid)).toBe("alive")
    }))

  it.live("retires a record written before this machine booted without signalling it", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("pre-boot"))
      const deadOwner = yield* Effect.promise(exitedPid)

      const outcome = yield* run(
        Effect.gen(function*() {
          const previous = yield* ProcessLedger.make({ hostId: "pre-boot-host", ownerPid: deadOwner })
          yield* recordTree(previous, group)
          const current = yield* ProcessLedger.make({ hostId: "pre-boot-host", ownerPid: process.pid })
          const reaped = yield* ProcessReaper.reap({
            system: {
              ...nativeSystem,
              // A machine that booted AFTER the record was written: the pid
              // space the record names does not exist any more.
              bootedAtMs: () => Date.now() + 60_000
            }
          }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, current))
          const journal = yield* Journal
          const page = yield* journal.entries({ runId: ProcessLedger.hostRunId("pre-boot-host"), limit: 16 })
          const third = yield* ProcessLedger.make({ hostId: "pre-boot-host", ownerPid: process.pid })
          return { reaped, types: page.entries.map((row) => row.eventType), remaining: yield* third.orphans }
        })
      )

      expect(outcome.reaped.map((entry) => entry.refusal)).toEqual(["pre-boot"])
      // Retired without a kill, and the journal says which of the two happened.
      expect(outcome.types).toEqual([
        "flows.host.process-spawned.v1",
        "flows.host.process-reap-skipped.v1"
      ])
      expect(outcome.remaining).toEqual([])
      // The group was never signalled, so it is still there for this cleanup.
      expect(nativeSystem.isAlive(group.leader)).toBe("alive")
      stopTree(group.leader)
      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
    }))

  it.live("refuses a pid whose process did not start when the record says it did", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("reused"))
      const deadOwner = yield* Effect.promise(exitedPid)
      const killed: Array<number> = []

      const reaped = yield* run(
        Effect.gen(function*() {
          const previous = yield* ProcessLedger.make({ hostId: "reused-host", ownerPid: deadOwner })
          yield* recordTree(previous, group)
          const current = yield* ProcessLedger.make({ hostId: "reused-host", ownerPid: process.pid })
          return yield* ProcessReaper.reap({
            system: {
              ...nativeSystem,
              // The operating system says this pid has been running for an
              // hour, so it is not the process the record describes.
              startedAtMs: () => ({ _tag: "started", startedAtMs: Date.now() - 3_600_000 }),
              killTree: (record) => {
                killed.push(record.pid)
                return "signalled"
              }
            }
          }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, current))
        })
      )

      expect(reaped.map((entry) => entry.refusal)).toEqual(["identity-mismatch"])
      expect(killed).toEqual([])
      stopTree(group.leader)
      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
    }))

  it.live("leaves a record whose kill FAILED for the next incarnation to retry", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("stubborn"))
      const deadOwner = yield* Effect.promise(exitedPid)

      const outcome = yield* run(
        Effect.gen(function*() {
          const previous = yield* ProcessLedger.make({ hostId: "stubborn-host", ownerPid: deadOwner })
          yield* recordTree(previous, group)
          const current = yield* ProcessLedger.make({ hostId: "stubborn-host", ownerPid: process.pid })
          const reaped = yield* ProcessReaper.reap({
            // A platform with no start-time column at all has only the boot
            // check, which this record passes, so the kill is attempted and
            // its refusal is the whole subject of this case.
            system: {
              ...nativeSystem,
              startedAtMs: () => ({ _tag: "unsupported" }),
              killTree: () => "failed"
            }
          }).pipe(Effect.provideService(ProcessLedger.ProcessLedger, current))
          const journal = yield* Journal
          const page = yield* journal.entries({ runId: ProcessLedger.hostRunId("stubborn-host"), limit: 16 })
          const third = yield* ProcessLedger.make({ hostId: "stubborn-host", ownerPid: process.pid })
          return { reaped, types: page.entries.map((row) => row.eventType), remaining: yield* third.orphans }
        })
      )

      expect(outcome.reaped.map((entry) => entry.killed)).toEqual([false])
      expect(outcome.reaped.map((entry) => entry.refusal)).toEqual(["kill-failed"])
      // Nothing claims the orphan was reaped, so it is still inherited.
      expect(outcome.types).toEqual(["flows.host.process-spawned.v1"])
      expect(outcome.remaining.map((row) => row.pid)).toEqual([group.leader])
      stopTree(group.leader)
      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
    }))

  it.live("reaps while a host layer is being built", () =>
    Effect.gen(function*() {
      const group = yield* Effect.promise(() => startOrphanGroup("layered"))
      const deadOwner = yield* Effect.promise(exitedPid)

      yield* run(
        Effect.gen(function*() {
          const previous = yield* ProcessLedger.make({ hostId: "layered-host", ownerPid: deadOwner })
          yield* recordTree(previous, group)
          const current = yield* ProcessLedger.make({ hostId: "layered-host", ownerPid: process.pid })
          yield* Effect.void.pipe(
            Effect.provide(ProcessReaper.layer()),
            Effect.provideService(ProcessLedger.ProcessLedger, current)
          )
        })
      )

      expect(yield* Effect.promise(() => waitForExit(group.leader, 2_000))).toBe(true)
      expect(yield* Effect.promise(() => waitForExit(group.follower, 2_000))).toBe(true)
    }))
})

afterAll(cleanup)
process.on("exit", cleanup)
