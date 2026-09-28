/**
 * The contained Bun host, driven over real processes.
 *
 * `BunHost.layerContained` is the reason this bundle is worth having under a
 * supervisor: it hands out the same five host services `BunHost.layer` does,
 * spawns every child through `@smthrs/kernel`'s `ContainedSpawner` so the child
 * leads a recorded group with a `SIGTERM`-then-`SIGKILL` deadline, builds `jj`
 * over that same spawner rather than letting it start children out the side,
 * and sweeps what a dead incarnation abandoned on the way up. The barrel suite
 * only proves the layers exist; these cases drive them.
 *
 * `it.live` throughout: every wait below is real elapsed time.
 */
import { describe, expect, it } from "@effect/vitest"
import { Jj } from "@smthrs/jj"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { spawn } from "node:child_process"
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as BunHost from "../src/BunHost.ts"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Waits for a pid to disappear, or gives up after `budgetMs`. */
const waitForExit = async (pid: number, budgetMs: number): Promise<boolean> => {
  const deadline = Date.now() + budgetMs
  for (;;) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    if (Date.now() > deadline) return false
    await sleep(10)
  }
}

/** Waits for a shim to report through a file that it is running. */
const waitForFile = async (path: string): Promise<string> => {
  for (let attempt = 0; attempt < 1_500; attempt += 1) {
    try {
      const text = readFileSync(path, "utf8").trim()
      if (text !== "") return text
    } catch {
      // not written yet
    }
    await sleep(10)
  }
  throw new Error(`the shim never wrote ${path}`)
}

/**
 * A detached shell that leads its own group and has a background child.
 *
 * The leader pid comes back immediately rather than after the background pid
 * is readable: the reaper re-checks a record's `startedAtMs` against the pid's
 * real start instant within `identityToleranceMs`, so the caller must be free
 * to write the record before waiting on anything.
 */
const startOrphanGroup = (directory: string): { follower: Promise<number>; leader: number } => {
  const pidFile = join(directory, "follower.pid")
  // The path rides in as `$1`, never spliced into the script: a TMPDIR with a
  // space or a shell metacharacter must not change what `sh` parses.
  const child = spawn("sh", ["-c", "sleep 30 & echo $! > \"$1\"; sleep 30", "sh", pidFile], {
    detached: true,
    stdio: "ignore"
  })
  child.unref()
  return { follower: waitForFile(pidFile).then(Number), leader: child.pid as number }
}

/**
 * Ends a group the reaper was supposed to end.
 *
 * The fixture starts a DETACHED group precisely so nothing holds a handle for
 * it. When the assertions pass, the reaper has already killed it and this is a
 * no-op; when they fail, this is the only thing standing between a failing run
 * and two `sleep 30` processes nobody is accountable for.
 */
const killGroup = (leader: number): void => {
  try {
    process.kill(-leader, "SIGKILL")
  } catch {
    // already gone, which is the passing case
  }
}

/** A pid that is certainly not a running process any more. */
const exitedPid = async (): Promise<number> => {
  const child = spawn("sh", ["-c", "exit 0"], { stdio: "ignore" })
  const pid = child.pid as number
  await new Promise<void>((resolve) => child.on("close", () => resolve()))
  return pid
}

const temporaryDirectory = () => mkdtempSync(join(tmpdir(), "flows-bun-contained-"))

/** Installs `script` as an executable named `jj`, first on `PATH`. */
const installJjShim = (directory: string, script: string): void => {
  writeFileSync(
    join(directory, "jj"),
    script.replace(
      "#!/bin/sh",
      "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$0.invocations\"\nif [ \"$1\" = \"--version\" ]; then echo \"jj 0.39.0\"; exit 0; fi"
    )
  )
  chmodSync(join(directory, "jj"), 0o755)
  // Prepended, not replaced: the shim wins while `sh` and `sleep` stay reachable.
  process.env["PATH"] = `${directory}:${process.env["PATH"] ?? ""}`
}

describe.skipIf(process.platform === "win32")("BunHost.layerContained", () => {
  it.live("kills the group a dead incarnation abandoned, while the layer is built", () =>
    Effect.gen(function*() {
      const directory = temporaryDirectory()
      let abandonedLeader: number | undefined
      try {
        const deadOwner = yield* Effect.promise(exitedPid)
        const group = startOrphanGroup(directory)
        abandonedLeader = group.leader

        // The incarnation that started the process, and then died. Recording
        // through a real ledger is what stamps the record with the pid's real
        // start instant, which is the identity the reaper re-checks.
        const previous = yield* ProcessLedger.makeMemory({ hostId: "bun-reaped", ownerPid: deadOwner })
        const abandoned = yield* previous.record({
          pid: group.leader,
          pgid: group.leader,
          commandDigest: "sh -c sleep"
        })
        // Only now is it safe to wait: the record is already stamped.
        const follower = yield* Effect.promise(() => group.follower)

        // This incarnation inherits that record and nothing else.
        const current = yield* ProcessLedger.makeMemory({ hostId: "bun-reaped", ownerPid: process.pid })
        const retired: Array<ProcessLedger.ProcessRecord> = []
        const inherited = ProcessLedger.ProcessLedger.of({
          ...current,
          orphans: Effect.succeed([abandoned]),
          reaped: (record) => Effect.sync(() => void retired.push(record))
        })

        const options = { graceMs: 300, ownerPid: process.pid }
        const host = BunHost.layerContained(options).pipe(
          Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(inherited))
        )
        // The factory took what it needed when it was called. A caller that
        // mutates the object afterwards cannot change what the reaper trusts:
        // this `ownerPid` would refuse the record as `own-group` if the live
        // object were read at layer-build time instead.
        options.ownerPid = group.leader

        // Building the layer is the whole trigger: no operation is run through it.
        yield* Effect.void.pipe(Effect.provide(host), Effect.scoped)

        expect(retired).toEqual([abandoned])
        expect(yield* Effect.promise(() => waitForExit(group.leader, 5_000))).toBe(true)
        // The background process nothing ever held a handle for died with it.
        expect(yield* Effect.promise(() => waitForExit(follower, 5_000))).toBe(true)
      } finally {
        if (abandonedLeader !== undefined) killGroup(abandonedLeader)
        rmSync(directory, { recursive: true, force: true })
      }
    }), 30_000)

  /**
   * `ContainedSpawner.Options.platform` decides only whether a child gets a
   * process group of its own, and Effect's spawner decides that from the REAL
   * `process.platform` whatever the ledger was told. A caller-supplied
   * `"win32"` winning the spread would record `pgid: null` for a child that
   * genuinely leads a group, and `ProcessReaper.reap` retires such a record as
   * `no-group` without signalling anything, so the orphan outlives every
   * incarnation. The option is not part of `ContainedOptions`, and this pins
   * that a cast cannot put it back.
   */
  it.live("records the real process group even when a caller claims another platform", () =>
    Effect.gen(function*() {
      const spoofed = { graceMs: 300, platform: "win32" } as BunHost.ContainedOptions
      for (
        const build of [
          () => BunHost.layerContained(spoofed),
          () => BunHost.layerContainedAt(realpathSync(tmpdir()), spoofed)
        ]
      ) {
        const ledger = yield* ProcessLedger.makeMemory({ hostId: "bun-spoofed", ownerPid: process.pid })
        const host = build().pipe(Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger)))
        const observed = yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const handle = yield* spawner.spawn(ChildProcess.make("sleep", ["30"]))
          return { live: yield* ledger.live, pid: handle.pid as number }
        }).pipe(Effect.provide(host), Effect.scoped)

        expect(observed.live).toEqual([expect.objectContaining({ pgid: observed.pid, pid: observed.pid })])
        expect(yield* Effect.promise(() => waitForExit(observed.pid, 5_000))).toBe(true)
      }
    }), 30_000)

  it.live("escalates to SIGKILL when a child ignores SIGTERM", () =>
    Effect.gen(function*() {
      const directory = temporaryDirectory()
      // A child that ignores `SIGTERM` is exactly the child a failed assertion
      // would leave running, so its group is ended unconditionally on the way out.
      let trapped: number | undefined
      try {
        const graceMs = 400
        const marker = join(directory, "trapped.ready")
        const ledger = yield* ProcessLedger.makeMemory({ hostId: "bun-escalation", ownerPid: process.pid })
        // No root: `layerContained()` is the process-working-directory form, and
        // this is the one case that runs a real operation through it.
        const host = BunHost.layerContained({ graceMs }).pipe(
          Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
        )

        const pidReady = Deferred.makeUnsafe<number>()
        const fiber = yield* Effect.forkChild(
          Effect.gen(function*() {
            const spawner = yield* ChildProcessSpawner
            const handle = yield* spawner.spawn(
              // The marker path rides in as `$1` for the same reason as in `startOrphanGroup`.
              ChildProcess.make("sh", [
                "-c",
                "trap \"\" TERM; echo ready > \"$1\"; while true; do sleep 0.2; done",
                "sh",
                marker
              ])
            )
            yield* Deferred.succeed(pidReady, Number(handle.pid))
            yield* handle.exitCode
          }).pipe(Effect.provide(host), Effect.scoped),
          { startImmediately: true }
        )

        const pid = yield* Deferred.await(pidReady)
        trapped = pid
        // Interrupting before the trap is installed would prove nothing.
        yield* Effect.promise(() => waitForFile(marker))
        expect(yield* ledger.live).toEqual([
          expect.objectContaining({ pid, pgid: pid })
        ])

        const before = Date.now()
        yield* Fiber.interrupt(fiber)

        // `trap "" TERM` means only the escalation could have ended it.
        expect(yield* Effect.promise(() => waitForExit(pid, graceMs + 5_000))).toBe(true)
        expect(Date.now() - before).toBeGreaterThanOrEqual(graceMs)
        expect(yield* ledger.live).toEqual([])
      } finally {
        if (trapped !== undefined) killGroup(trapped)
        rmSync(directory, { recursive: true, force: true })
      }
    }), 30_000)

  it.live("records and retires both the jj version probe and repository command", () =>
    Effect.gen(function*() {
      // `BunJj.layer` spawns through `node:child_process` directly, so a jj
      // child leads no group the host recorded and no reaper can ever find it.
      // Under containment the host builds jj over its OWN spawner, and this is
      // the observable difference: the invocation shows up in the ledger like
      // any other child.
      const directory = temporaryDirectory()
      const previousPath = process.env["PATH"]
      installJjShim(directory, "#!/bin/sh\npwd\n")

      try {
        const ledger = yield* ProcessLedger.makeMemory({ hostId: "bun-contained-jj", ownerPid: process.pid })
        const recorded: Array<string> = []
        const host = BunHost.layerContainedAt(directory, { graceMs: 300 }).pipe(
          Layer.provide(
            Layer.succeed(ProcessLedger.ProcessLedger)({
              ...ledger,
              record: (spawned) =>
                Effect.tap(
                  ledger.record(spawned),
                  (row) => Effect.sync(() => void recorded.push(row.commandDigest))
                )
            })
          )
        )

        const binary = join(directory, "jj")
        const invocations = () => readFileSync(`${binary}.invocations`, "utf8").trim().split("\n")
        const status = yield* Effect.gen(function*() {
          const jj = yield* Jj
          // Construction ran and retired only the startup version probe.
          expect(invocations()).toEqual(["--version"])
          expect(recorded).toEqual([binary])
          expect(yield* ledger.live).toEqual([])
          return yield* jj.status()
        }).pipe(Effect.provide(host), Effect.scoped)

        expect(status.trim()).toBe(realpathSync(directory))
        // NodeJj pins the signing and fsmonitor settings a repository config could point at a program.
        expect(invocations()).toEqual([
          "--version",
          "status --color=never --config snapshot.max-new-file-size=0 --config signing.behavior=drop " +
          "--config signing.backends.gpg.program=/dev/null --config signing.backends.gpgsm.program=/dev/null " +
          "--config signing.backends.ssh.program=/dev/null --config fsmonitor.backend=none"
        ])
        expect(recorded).toEqual([binary, binary])
        // The invocation finished, so the record was retired with it.
        expect(yield* ledger.live).toEqual([])
      } finally {
        process.env["PATH"] = previousPath
        rmSync(directory, { recursive: true, force: true })
      }
    }), 30_000)
})
