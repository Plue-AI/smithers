/**
 * The containment decorator, exercised over a scripted host spawner.
 *
 * Real process containment is a platform concern and is proved against real
 * processes in `@smthrs/platform-node`. What lives here is the part that is
 * platform-independent and therefore testable without one: the command
 * rewriting that gives a release an escalation deadline, the process-group
 * bookkeeping the ledger records, and the finalizer that retires a record when
 * the spawn scope closes.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Permission from "@smthrs/capability/Permission"
import * as JournalModule from "@smthrs/journal/Journal"
import { JournalError } from "@smthrs/journal/Journal"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Deferred, Effect, Fiber, Layer, Path, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import * as GuardedSpawner from "../src/ChildProcessSpawner.ts"
import * as ContainedSpawner from "../src/ContainedSpawner.ts"
import { GrantStore } from "../src/GrantStore.ts"
import * as ProcessLedger from "../src/ProcessLedger.ts"
import * as Workspace from "../src/Workspace.ts"

/**
 * A host spawner that records what it was handed and reports consecutive pids.
 *
 * It registers a finalizer of its own, exactly as Effect's Node spawner does:
 * the ORDER of that finalizer against the ledger's release is behavior this
 * module has to get right, and a fake without one could not show it.
 */
const hostSpawner = (
  spawned: Array<ChildProcess.Command>,
  pid = 4321,
  events?: Array<string>
) =>
  Layer.succeed(ChildProcessSpawner)(
    makeSpawner((command: ChildProcess.Command) =>
      Effect.gen(function*() {
        spawned.push(command)
        yield* Effect.addFinalizer(() => Effect.sync(() => events?.push("signalled")))
        return makeHandle({
          pid: ProcessId(pid + spawned.length - 1),
          exitCode: Effect.succeed(ExitCode(0)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.sync(() => events?.push("killed")),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        })
      })
    )
  )

const refused = new JournalError({ code: "journal_closed", message: "journal is gone" })

/** A real in-memory ledger whose release can expose finalizer retries. */
const ledgerWithRelease = (
  failing: boolean,
  events?: Array<string>
) =>
  Effect.map(ProcessLedger.makeMemory({ hostId: "broken", ownerPid: 1 }), (ledger) =>
    ProcessLedger.ProcessLedger.of({
      ...ledger,
      release: (record) =>
        Effect.suspend(() => {
          events?.push("released")
          return failing ? Effect.fail(refused) : ledger.release(record)
        })
    }))

const options = (command: ChildProcess.Command) => command._tag === "StandardCommand" ? command.options : undefined

describe("ContainedSpawner", () => {
  for (const verified of [true, false]) {
    it.effect(`retires a platform-guarded record only after verified cleanup (${verified})`, () =>
      Effect.gen(function*() {
        const events: Array<string> = []
        const ledger = yield* ledgerWithRelease(false, events)
        const lifecycle: ContainedSpawner.Lifecycle = (command, spawn) =>
          Effect.gen(function*() {
            const handle = yield* spawn(command)
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                events.push("checked")
              })
            )
            return { handle, activate: Effect.void, settled: Effect.succeed(verified) }
          })
        yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          yield* spawner.spawn(ChildProcess.make("agent"))
        }).pipe(
          Effect.provide(ContainedSpawner.layer({}, lifecycle)),
          Effect.provide(hostSpawner([], 4321, events)),
          Effect.provideService(ProcessLedger.ProcessLedger, ledger),
          Effect.scoped
        )
        expect(events).toEqual(verified ? ["checked", "signalled", "released"] : ["checked", "signalled"])
        expect(yield* ledger.live).toHaveLength(verified ? 0 : 1)
      }))
  }

  for (const allowed of [true, false]) {
    it.effect(`authorizes the original command and records its prepared identity before activation (${allowed})`, () =>
      Effect.gen(function*() {
        const events: Array<string> = []
        const spawned: Array<ChildProcess.Command> = []
        const checks: Array<string> = []
        const ledger = yield* ledgerWithRelease(false, events)
        const lifecycle: ContainedSpawner.Lifecycle = (command, spawn) =>
          Effect.gen(function*() {
            expect(command.command).toBe("agent")
            expect(command.args).toEqual(["--run"])
            expect(command.options).toMatchObject({ forceKillAfter: 50, env: { DECLARED: "value" } })
            expect(yield* ledger.live).toEqual([])
            const handle = yield* spawn(ChildProcess.make("prepared-owner"))
            let settled = false
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                events.push("checked")
                settled = true
              })
            )
            return {
              handle,
              activate: Effect.gen(function*() {
                expect(yield* ledger.live).toEqual([
                  expect.objectContaining({ pid: handle.pid, pgid: handle.pid, commandDigest: "agent" })
                ])
                events.push("activated")
              }),
              settled: Effect.sync(() => settled)
            }
          })
        const store = GrantStore.of({
          check: (capability) => {
            checks.push(capability.resource)
            return allowed && capability.resource === "env DECLARED -- agent --run"
              ? Effect.void
              : Effect.fail(Permission.permissionDenied(capability, "original command denied"))
          },
          reply: () => Effect.void,
          list: Effect.succeed([]),
          grantEnvelope: () => Effect.void
        })
        yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const start = spawner.spawn(ChildProcess.make("agent", ["--run"], { env: { DECLARED: "value" } }))
          if (allowed) {
            expect((yield* start).pid).toBe(4321)
          } else {
            expect((yield* Effect.flip(start)).reason._tag).toBe("PermissionDenied")
          }
        }).pipe(
          Effect.provide(GuardedSpawner.layer.pipe(Layer.provide([Workspace.layerNoop, Path.layer]))),
          Effect.provide(ContainedSpawner.layer({ graceMs: 50 }, lifecycle)),
          Effect.provide(hostSpawner(spawned, 4321, events)),
          Effect.provideService(GrantStore, store),
          Effect.provideService(ProcessLedger.ProcessLedger, ledger),
          Effect.scoped
        )
        expect(checks).toEqual(["env DECLARED -- agent --run"])
        expect(spawned.map((command) => command._tag === "StandardCommand" && command.command)).toEqual(
          allowed ? ["prepared-owner"] : []
        )
        expect(events).toEqual(allowed ? ["activated", "checked", "signalled", "released"] : [])
        expect(yield* ledger.live).toEqual([])
      }))
  }

  it.effect("never activates a prepared command whose durable record fails", () =>
    Effect.gen(function*() {
      const events: Array<string> = []
      const ledger = yield* ProcessLedger.make({ hostId: "prepare-broken", ownerPid: 1 }).pipe(
        Effect.provide(JournalModule.layerNoop())
      )
      const lifecycle: ContainedSpawner.Lifecycle = (_command, spawn) =>
        Effect.gen(function*() {
          const handle = yield* spawn(ChildProcess.make("prepared-owner"))
          yield* Effect.addFinalizer(() => Effect.sync(() => events.push("checked")))
          return {
            handle,
            activate: Effect.sync(() => events.push("activated")),
            settled: Effect.succeed(true)
          }
        })
      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const error = yield* Effect.flip(spawner.spawn(ChildProcess.make("agent")))
        expect(String(error)).toContain("could not record this spawn durably")
        // The caller's scope is still open. The failed startup is already closed.
        expect(events).toEqual(["killed", "checked", "signalled"])
        expect(yield* ledger.live).toEqual([])
      }).pipe(
        Effect.provide(ContainedSpawner.layer({}, lifecycle)),
        Effect.provide(hostSpawner([], 4321, events)),
        Effect.provideService(ProcessLedger.ProcessLedger, ledger),
        Effect.scoped
      )
      expect(events).not.toContain("activated")
    }))

  for (const verified of [true, false]) {
    it.effect(`closes caught activation failures immediately and retires only verified cleanup (${verified})`, () =>
      Effect.gen(function*() {
        const events: Array<string> = []
        const ledger = yield* ledgerWithRelease(false, events)
        const failure = PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "target does not exist"
        })
        const lifecycle: ContainedSpawner.Lifecycle = (_command, spawn) =>
          Effect.gen(function*() {
            const handle = yield* spawn(ChildProcess.make("prepared-owner"))
            let settled = false
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                events.push("checked")
                settled = verified
              })
            )
            return { handle, activate: Effect.fail(failure), settled: Effect.sync(() => settled) }
          })
        yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          expect(yield* Effect.flip(spawner.spawn(ChildProcess.make("missing")))).toBe(failure)
          expect(events).toEqual(verified ? ["checked", "signalled", "released"] : ["checked", "signalled"])
          expect(yield* ledger.live).toHaveLength(verified ? 0 : 1)
          events.push("outer-continues")
        }).pipe(
          Effect.provide(ContainedSpawner.layer({}, lifecycle)),
          Effect.provide(hostSpawner([], 4321, events)),
          Effect.provideService(ProcessLedger.ProcessLedger, ledger),
          Effect.scoped
        )
        expect(events.at(-1)).toBe("outer-continues")
      }))
  }

  for (const phase of ["prepare", "activate"] as const) {
    it.effect(`closes an interrupted ${phase} before the caller's scope closes`, () =>
      Effect.gen(function*() {
        const events: Array<string> = []
        const entered = yield* Deferred.make<void>()
        const ledger = yield* ledgerWithRelease(false, events)
        const pause = Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
        const lifecycle: ContainedSpawner.Lifecycle = (_command, spawn) =>
          Effect.gen(function*() {
            const handle = yield* spawn(ChildProcess.make("prepared-owner"))
            let settled = false
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                events.push("checked")
                settled = true
              })
            )
            if (phase === "prepare") yield* pause
            return { handle, activate: pause, settled: Effect.sync(() => settled) }
          })
        yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const fiber = yield* spawner.spawn(ChildProcess.make("agent")).pipe(Effect.forkChild)
          yield* Deferred.await(entered)
          yield* Fiber.interrupt(fiber)
          expect(events).toEqual(
            phase === "prepare"
              ? ["checked", "signalled"]
              : ["checked", "signalled", "released"]
          )
          expect(yield* ledger.live).toEqual([])
          events.push("outer-continues")
        }).pipe(
          Effect.provide(ContainedSpawner.layer({}, lifecycle)),
          Effect.provide(hostSpawner([], 4321, events)),
          Effect.provideService(ProcessLedger.ProcessLedger, ledger),
          Effect.scoped
        )
        expect(events.at(-1)).toBe("outer-continues")
      }))

    it.effect(`a caught right-leg ${phase} failure closes both pipeline legs in reverse order`, () =>
      Effect.gen(function*() {
        const events: Array<string> = []
        const ledger = yield* ledgerWithRelease(false, events)
        const failure = PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "right leg does not exist"
        })
        const lifecycle: ContainedSpawner.Lifecycle = (command, spawn) =>
          Effect.gen(function*() {
            const handle = yield* spawn(ChildProcess.make(`${command.command}-owner`))
            let settled = false
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                events.push(`checked:${command.command}`)
                settled = true
              })
            )
            if (command.command === "right" && phase === "prepare") return yield* Effect.fail(failure)
            return {
              handle,
              activate: command.command === "right" ? Effect.fail(failure) : Effect.void,
              settled: Effect.sync(() => settled)
            }
          })
        yield* Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          expect(
            yield* Effect.flip(spawner.spawn(
              ChildProcess.pipeTo(ChildProcess.make("left"), ChildProcess.make("right"))
            ))
          ).toBe(failure)
          expect(events).toEqual(
            phase === "prepare"
              ? ["checked:right", "signalled", "checked:left", "signalled", "released"]
              : ["checked:right", "signalled", "released", "checked:left", "signalled", "released"]
          )
          expect(yield* ledger.live).toEqual([])
          events.push("outer-continues")
        }).pipe(
          Effect.provide(ContainedSpawner.layer({}, lifecycle)),
          Effect.provide(hostSpawner([], 4321, events)),
          Effect.provideService(ProcessLedger.ProcessLedger, ledger),
          Effect.scoped
        )
        expect(events.at(-1)).toBe("outer-continues")
      }))
  }

  it("gives a command an escalation deadline it did not have", () => {
    const contained = ContainedSpawner.withContainment(ChildProcess.make("sleep", ["30"]))
    expect(options(contained)).toMatchObject({ killSignal: "SIGTERM", forceKillAfter: 2000 })
    expect(ContainedSpawner.defaultGraceMs).toBe(2000)
  })

  it("keeps a kill policy the caller already chose", () => {
    const contained = ContainedSpawner.withContainment(
      ChildProcess.make("sleep", ["30"], { killSignal: "SIGINT", forceKillAfter: 25 })
    )
    expect(options(contained)).toMatchObject({ killSignal: "SIGINT", forceKillAfter: 25 })
  })

  it("gives every leg of a pipeline the same deadline", () => {
    const contained = ContainedSpawner.withContainment(
      ChildProcess.pipeTo(ChildProcess.make("cat", ["a"]), ChildProcess.make("wc", ["-l"])),
      { graceMs: 100 }
    )
    expect(contained._tag).toBe("PipedCommand")
    const legs = contained._tag === "PipedCommand" ? [contained.left, contained.right] : []
    expect(legs.map(options)).toEqual([
      expect.objectContaining({ forceKillAfter: 100 }),
      expect.objectContaining({ forceKillAfter: 100 })
    ])
  })

  it("reads the process group from the rightmost leg's detachment", () => {
    const detached = ChildProcess.make("sleep", ["30"])
    const shared = ChildProcess.make("sleep", ["30"], { detached: false })
    expect(ContainedSpawner.groupOf(detached, 91)).toBe(91)
    expect(ContainedSpawner.groupOf(shared, 91)).toBeNull()
    expect(ContainedSpawner.groupOf(ChildProcess.pipeTo(detached, shared), 91)).toBeNull()
    expect(ContainedSpawner.groupOf(ChildProcess.pipeTo(shared, detached), 91)).toBe(91)
  })

  it("records no POSIX process group on win32, including detached pipeline legs", () => {
    for (const detached of [undefined, false, true]) {
      const command = ChildProcess.make("agent", ["--run"], { detached })
      const peer = ChildProcess.make("agent", ["--peer"], { detached: true })
      expect(ContainedSpawner.groupOf(command, 91, "win32")).toBeNull()
      expect(ContainedSpawner.groupOf(ChildProcess.pipeTo(peer, command), 91, "win32")).toBeNull()
      expect(ContainedSpawner.groupOf(ChildProcess.pipeTo(command, peer), 91, "win32")).toBeNull()
      expect(ContainedSpawner.groupOf(command, 91, "darwin")).toBe(detached === false ? null : 91)
    }
  })

  it.effect("records a spawn against the ledger and retires it on scope close", () =>
    Effect.gen(function*() {
      const spawned: Array<ChildProcess.Command> = []
      const ledger = yield* ProcessLedger.makeMemory({ hostId: "contained", ownerPid: 7 })

      const live = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.spawn(ChildProcess.make("agent", ["--run"]))
        return yield* ledger.live
      }).pipe(
        Effect.provide(
          ContainedSpawner.layer({ graceMs: 50 }).pipe(
            Layer.provide(hostSpawner(spawned)),
            Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
          )
        ),
        Effect.scoped
      )

      // The host spawner saw the rewritten command, and the ledger saw the
      // process the handle reported, named by the executable a grant names.
      expect(options(spawned[0]!)).toMatchObject({ forceKillAfter: 50 })
      expect(live).toEqual([
        expect.objectContaining({ pid: 4321, pgid: 4321, commandDigest: "agent" })
      ])
      // The scope closed, so the record is retired: nothing may reap a pid
      // this host already released.
      expect(yield* ledger.live).toEqual([])
    }))

  it.effect("announces the exit only AFTER the process has been signalled", () =>
    Effect.gen(function*() {
      const spawned: Array<ChildProcess.Command> = []
      const events: Array<string> = []
      const ledger = yield* ledgerWithRelease(false, events)

      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.spawn(ChildProcess.make("agent", ["--run"]))
      }).pipe(
        Effect.provide(
          ContainedSpawner.layer({ graceMs: 50 }).pipe(
            Layer.provide(hostSpawner(spawned, 4321, events)),
            Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
          )
        ),
        Effect.scoped
      )

      // Finalizers run last-registered-first, so the release has to be
      // registered FIRST to run last. A ledger that announced the exit while
      // the kill was still in its grace window would be telling the next
      // incarnation to stop looking for something still alive.
      expect(events).toEqual(["signalled", "released"])
    }))

  it.effect("refuses a spawn whose record did not commit, and signals what it started", () =>
    Effect.gen(function*() {
      const spawned: Array<ChildProcess.Command> = []
      const events: Array<string> = []
      // The public constructor keeps this test on the same in-memory and
      // durable path as production while the journal refuses every append.
      const ledger = yield* ProcessLedger.make({ hostId: "broken", ownerPid: 1 }).pipe(
        Effect.provide(JournalModule.layerNoop())
      )

      const failure = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        return yield* Effect.flip(spawner.spawn(ChildProcess.make("agent", ["--run"])))
      }).pipe(
        Effect.provide(
          ContainedSpawner.layer().pipe(
            Layer.provide(hostSpawner(spawned, 4321, events)),
            Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
          )
        ),
        Effect.scoped
      )

      // A child nothing durable names is the exact hole containment exists to
      // close, so it is killed and the caller is told rather than left with a
      // handle to an undiscoverable process.
      expect(failure.reason._tag).toBe("Unknown")
      expect(failure.reason.method).toBe("spawn")
      expect(String(failure)).toContain("could not record this spawn durably")
      expect(events).toEqual(["killed", "signalled"])
      expect(yield* ledger.live).toEqual([])
    }))

  it.effect("closes the scope when the exit itself cannot be journaled", () =>
    Effect.gen(function*() {
      const spawned: Array<ChildProcess.Command> = []
      const events: Array<string> = []
      const ledger = yield* ledgerWithRelease(true, events)

      yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.spawn(ChildProcess.make("agent", ["--run"]))
      }).pipe(
        Effect.provide(
          ContainedSpawner.layer().pipe(
            Layer.provide(hostSpawner(spawned, 4321, events)),
            Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
          )
        ),
        Effect.scoped
      )

      // Retried, then left alone. The record stays inherited and the next
      // incarnation's reaper finds the pid already gone and retires it there,
      // which is why this one place logs instead of failing the scope close.
      expect(events).toEqual(["signalled", "released", "released", "released"])
    }))

  it.effect("keeps credential-bearing arguments out of the durable record", () =>
    Effect.gen(function*() {
      // A journal entry is permanent and broadly readable, so an argument that
      // holds a password may never reach one. The executable still does: the
      // row has to name the program a reaper may have to signal.
      const ledger = yield* ProcessLedger.make({ hostId: "contained", ownerPid: 7 })
      const live = yield* Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        yield* spawner.spawn(ChildProcess.make("curl", ["-u", "probe-user:probe-password"]))
        yield* spawner.spawn(ChildProcess.make("mysql -phunter2", [], { shell: true }))
        return yield* ledger.live
      }).pipe(
        Effect.provide(
          ContainedSpawner.layer({ graceMs: 50 }).pipe(
            Layer.provide(hostSpawner([])),
            Layer.provide(Layer.succeed(ProcessLedger.ProcessLedger)(ledger))
          )
        ),
        Effect.scoped
      )

      expect(live.map((record) => record.commandDigest)).toEqual(["curl", "mysql"])
      const journal = yield* JournalModule.Journal
      const page = yield* journal.entries({ runId: ProcessLedger.hostRunId("contained"), limit: 16 })
      // Both the spawn and the exit of each process are written, so the whole
      // page is searched rather than the first row.
      expect(page.entries).toHaveLength(4)
      const written = JSON.stringify(page.entries)
      expect(written).not.toContain("probe-password")
      expect(written).not.toContain("hunter2")
    }).pipe(Effect.provide(TestJournal.layer()), Effect.scoped))
})
