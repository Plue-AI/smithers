import { describe, expect, it } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Logger } from "effect"
import * as RunCoordinator from "../src/internal/RunCoordinator.ts"

const effect = <E>(name: string, body: () => Effect.Effect<void, E>) => it.effect(name, () => body())

describe("RunCoordinator", () => {
  effect(
    "reserves idle ownership before checking readiness and skips work that already parked",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const checking = yield* Deferred.make<void>()
        const release = yield* Deferred.make<void>()
        let pending = true
        let drains = 0
        const coordinator = yield* RunCoordinator.make({
          drain: () =>
            Effect.sync(() => {
              drains++
            })
        })
        yield* coordinator.scheduleIf(
          "run",
          Deferred.succeed(checking, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.map(() => pending)
          )
        )
        yield* Deferred.await(checking)
        yield* coordinator.schedule("run")
        pending = false
        yield* Deferred.succeed(release, undefined)
        yield* coordinator.join("run")
        expect(drains).toBe(0)
        expect((yield* coordinator.active).size).toBe(0)
        yield* coordinator.scheduleIf("run", Effect.succeed(true))
        yield* coordinator.join("run")
        expect(drains).toBe(1)
      }))
  )

  effect(
    "a follower never checks stale pending state while an active child is finishing",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const parked = yield* Deferred.make<void>()
        let drives = 0
        let reads = 0
        const coordinator = yield* RunCoordinator.make({
          drain: () =>
            Effect.sync(() => {
              drives++
            }).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(parked))
            )
        })
        yield* coordinator.schedule("child")
        yield* Deferred.await(started)
        // A read-before-schedule implementation would retain pending=true,
        // let the original drive park, then start another drain on the idle row.
        const staleRead = Effect.sync(() => {
          reads++
          return true
        }).pipe(
          Effect.tap(() => Deferred.succeed(parked, undefined)),
          Effect.tap(() => coordinator.join("child"))
        )
        yield* coordinator.scheduleIf("child", staleRead)
        yield* Deferred.succeed(parked, undefined)
        yield* coordinator.join("child")
        expect(reads).toBe(0)
        expect(drives).toBe(1)
      }))
  )

  effect("schedules idle admission without replaying an active drain", () =>
    Effect.scoped(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const gate = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Effect.sync(() => runs++).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(gate))
          )
      })
      yield* coordinator.schedule("run")
      yield* Deferred.await(started)
      yield* coordinator.schedule("run")
      yield* coordinator.schedule("run")
      expect(runs).toBe(1)
      yield* Deferred.succeed(gate, undefined)
      yield* coordinator.join("run")
      expect(runs).toBe(1)
      expect((yield* coordinator.active).size).toBe(0)
      yield* coordinator.schedule("run")
      yield* coordinator.join("run")
      expect(runs).toBe(2)
    })))

  effect(
    "an event wake still replays work after admission joins an active drain",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* RunCoordinator.make({
          drain: () =>
            Effect.sync(() => runs++).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Deferred.await(gate))
            )
        })
        yield* coordinator.schedule("run")
        yield* Deferred.await(started)
        yield* coordinator.wake("run")
        yield* coordinator.schedule("run")
        yield* Deferred.succeed(gate, undefined)
        yield* coordinator.join("run")
        expect(runs).toBe(2)
      }))
  )

  effect(
    "admission during interruption does not resurrect the stopping owner",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const cleanupStarted = yield* Deferred.make<void>()
        const cleanupGate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* RunCoordinator.make({
          drain: () =>
            Effect.sync(() => runs++).pipe(
              Effect.andThen(Deferred.succeed(started, undefined)),
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Deferred.succeed(cleanupStarted, undefined).pipe(Effect.andThen(Deferred.await(cleanupGate)))
              )
            )
        })
        yield* coordinator.schedule("run")
        yield* Deferred.await(started)
        const stopping = yield* coordinator.interrupt("run").pipe(Effect.forkChild)
        yield* Deferred.await(cleanupStarted)
        yield* coordinator.schedule("run")
        yield* Deferred.succeed(cleanupGate, undefined)
        yield* Fiber.join(stopping)
        expect(runs).toBe(1)
        expect((yield* coordinator.active).size).toBe(0)
      }))
  )

  effect("joins a second run for the same key", () =>
    Effect.scoped(Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate)))
      })

      const first = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const second = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(runs).toBe(1)
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
      expect(runs).toBe(1)
    })))

  effect("join waits for the active drain and starts none while idle", () =>
    Effect.scoped(Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate)))
      })

      yield* coordinator.join("run")
      expect(runs).toBe(0)
      const first = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      const joined = yield* coordinator.join("run").pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(joined.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.all([Fiber.join(first), Fiber.join(joined)])
      expect(runs).toBe(1)
    })))

  effect("runs different keys concurrently", () =>
    Effect.scoped(Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const bothStarted = yield* Deferred.make<void>()
      let active = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Effect.sync(() => ++active).pipe(
            Effect.tap(() => active === 2 ? Deferred.succeed(bothStarted, undefined) : Effect.void),
            Effect.andThen(Deferred.await(gate))
          )
      })

      const first = yield* coordinator.run("first").pipe(Effect.forkChild)
      const second = yield* coordinator.run("second").pipe(Effect.forkChild)
      yield* Deferred.await(bothStarted)
      yield* Deferred.succeed(gate, undefined)
      yield* Effect.all([Fiber.join(first), Fiber.join(second)])
    })))

  effect("runs exactly one follow-up for wakes during an active drain", () =>
    Effect.scoped(Effect.gen(function*() {
      const firstStarted = yield* Deferred.make<void>()
      const firstGate = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Effect.sync(() => ++runs).pipe(Effect.flatMap((run) =>
            run === 1
              ? Deferred.succeed(firstStarted, undefined).pipe(Effect.andThen(Deferred.await(firstGate)))
              : Deferred.succeed(secondStarted, undefined)
          ))
      })

      const running = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      yield* Effect.all([coordinator.wake("run"), coordinator.wake("run"), coordinator.wake("run")], {
        concurrency: "unbounded"
      })
      yield* Deferred.succeed(firstGate, undefined)
      yield* Deferred.await(secondStarted)
      yield* Fiber.join(running)
      expect(runs).toBe(2)
    })))

  effect("schedules another wake received during the follow-up", () =>
    Effect.scoped(Effect.gen(function*() {
      const firstGate = yield* Deferred.make<void>()
      const secondStarted = yield* Deferred.make<void>()
      const secondGate = yield* Deferred.make<void>()
      const thirdStarted = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Effect.sync(() => ++runs).pipe(Effect.flatMap((run) =>
            run === 1 ?
              Deferred.await(firstGate)
              : run === 2 ?
              Deferred.succeed(secondStarted, undefined).pipe(Effect.andThen(Deferred.await(secondGate)))
              : Deferred.succeed(thirdStarted, undefined)
          ))
      })

      const running = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* coordinator.wake("run")
      yield* Deferred.succeed(firstGate, undefined)
      yield* Deferred.await(secondStarted)
      yield* coordinator.wake("run")
      yield* Deferred.succeed(secondGate, undefined)
      yield* Deferred.await(thirdStarted)
      yield* Fiber.join(running)
      expect(runs).toBe(3)
    })))

  effect("trampolines synchronous self-wakes", () =>
    Effect.scoped(Effect.gen(function*() {
      const completed = yield* Deferred.make<void>()
      const limit = 1_000
      let runs = 0
      let wake: (key: string) => Effect.Effect<void> = () => Effect.void
      const coordinator = yield* RunCoordinator.make<string, never, never>({
        drain: (key) =>
          Effect.sync(() => ++runs).pipe(
            Effect.tap((run) => run < limit ? wake(key) : Deferred.succeed(completed, undefined)),
            Effect.asVoid
          )
      })
      wake = coordinator.wake

      yield* coordinator.wake("run")
      yield* Deferred.await(completed)
      expect(runs).toBe(limit)
    })))

  effect("starts a drain when waking an idle key", () =>
    Effect.scoped(Effect.gen(function*() {
      const drained = yield* Deferred.make<void>()
      const coordinator = yield* RunCoordinator.make({ drain: () => Deferred.succeed(drained, undefined) })
      yield* coordinator.wake("run")
      yield* Deferred.await(drained)
    })))

  effect("logs a wake-initiated drain failure", () => {
    const logs: Array<{ readonly level: string; readonly message: unknown }> = []
    const capture = Logger.make((entry) => {
      logs.push({ level: entry.logLevel, message: entry.message })
    })
    return Effect.scoped(
      Effect.gen(function*() {
        const coordinator = yield* RunCoordinator.make<string, string, never>({
          drain: () => Effect.fail("boom")
        })
        yield* coordinator.wake("run")
        yield* Effect.yieldNow
        expect(
          logs.some((entry) =>
            entry.level === "Warn" && String(entry.message).includes("coordinated drain failed for run")
          )
        ).toBe(true)
      }).pipe(Effect.provide(Logger.layer([capture])))
    )
  })

  effect("passes only the key to direct and wake-initiated drains", () =>
    Effect.scoped(Effect.gen(function*() {
      const woke = yield* Deferred.make<void>()
      const arities: Array<number> = []
      const coordinator = yield* RunCoordinator.make<string, never, never>({
        drain: function() {
          const call = arities.length
          return Effect.sync(() => {
            arities.push(arguments.length)
          }).pipe(Effect.andThen(call === 0 ? Effect.void : Deferred.succeed(woke, undefined)))
        }
      })

      yield* coordinator.run("run")
      yield* coordinator.wake("run")
      yield* Deferred.await(woke)
      expect(arities).toEqual([1, 1])
    })))

  effect("cleans entries after a failure or defect", () =>
    Effect.scoped(Effect.gen(function*() {
      const failure = new Error("failure")
      const coordinator = yield* RunCoordinator.make<string, Error, never>({
        drain: (key) => key === "failure" ? Effect.fail(failure) : Effect.die("defect")
      })

      const failed = yield* coordinator.run("failure").pipe(Effect.exit)
      expect(Exit.isFailure(failed) && Cause.hasFails(failed.cause)).toBe(true)
      expect(Array.from(yield* coordinator.active)).toEqual([])
      const died = yield* coordinator.run("defect").pipe(Effect.exit)
      expect(Exit.isFailure(died) && Cause.hasDies(died.cause)).toBe(true)
      expect(Array.from(yield* coordinator.active)).toEqual([])
    })))

  effect("preserves a pending wake after an active drain fails", () =>
    Effect.scoped(Effect.gen(function*() {
      const firstStarted = yield* Deferred.make<void>()
      const firstGate = yield* Deferred.make<void>()
      const successorStarted = yield* Deferred.make<void>()
      const failure = new Error("failure")
      let runs = 0
      const coordinator = yield* RunCoordinator.make<string, Error, never>({
        drain: () =>
          Effect.sync(() => ++runs).pipe(
            Effect.flatMap((run) =>
              run === 1
                ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Deferred.await(firstGate)),
                  Effect.andThen(Effect.fail(failure))
                )
                : Deferred.succeed(successorStarted, undefined)
            )
          )
      })

      const running = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      yield* coordinator.wake("run")
      yield* Deferred.succeed(firstGate, undefined)
      yield* Deferred.await(successorStarted)
      const exit = yield* Fiber.await(running)
      expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause)).toBe(true)
      expect(runs).toBe(2)
    })))

  effect(
    "does not interrupt the owner when a joined waiter is interrupted",
    () =>
      Effect.scoped(Effect.gen(function*() {
        const gate = yield* Deferred.make<void>()
        let runs = 0
        const coordinator = yield* RunCoordinator.make({
          drain: () => Effect.sync(() => runs++).pipe(Effect.andThen(Deferred.await(gate)))
        })
        const owner = yield* coordinator.run("run").pipe(Effect.forkChild)
        yield* Effect.yieldNow
        const waiter = yield* coordinator.run("run").pipe(Effect.forkChild)
        yield* Fiber.interrupt(waiter)
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(owner)
        expect(runs).toBe(1)
      }))
  )

  effect("interrupts an active drain and waits for cleanup", () =>
    Effect.scoped(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const cleaned = yield* Deferred.make<void>()
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(cleaned, undefined))
          )
      })
      const running = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Deferred.await(started)
      yield* coordinator.interrupt("run")
      yield* Deferred.await(cleaned)
      const exit = yield* Fiber.await(running)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(Array.from(yield* coordinator.active)).toEqual([])
    })))

  effect("waits for a stopping entry before starting a replacement", () =>
    Effect.scoped(Effect.gen(function*() {
      const firstStarted = yield* Deferred.make<void>()
      const cleanupStarted = yield* Deferred.make<void>()
      const cleanupGate = yield* Deferred.make<void>()
      const replacementStarted = yield* Deferred.make<void>()
      let runs = 0
      const coordinator = yield* RunCoordinator.make({
        drain: () =>
          Effect.sync(() => ++runs).pipe(
            Effect.flatMap((run) =>
              run === 1
                ? Deferred.succeed(firstStarted, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() =>
                    Deferred.succeed(cleanupStarted, undefined).pipe(
                      Effect.andThen(Deferred.await(cleanupGate))
                    )
                  )
                )
                : Deferred.succeed(replacementStarted, undefined)
            )
          )
      })

      const first = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Deferred.await(firstStarted)
      const interrupting = yield* coordinator.interrupt("run").pipe(Effect.forkChild)
      yield* Deferred.await(cleanupStarted)
      const replacement = yield* coordinator.run("run").pipe(Effect.forkChild)
      expect(replacement.pollUnsafe()).toBeUndefined()
      yield* Deferred.succeed(cleanupGate, undefined)
      yield* Fiber.join(interrupting)
      yield* Deferred.await(replacementStarted)
      yield* Fiber.join(replacement)
      const exit = yield* Fiber.await(first)
      expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(runs).toBe(2)
    })))

  effect("ignores interruption for an idle key", () =>
    Effect.scoped(Effect.gen(function*() {
      const coordinator = yield* RunCoordinator.make({ drain: () => Effect.void })
      yield* coordinator.interrupt("missing")
      expect(Array.from(yield* coordinator.active)).toEqual([])
    })))

  effect("cleans active drains when its scope closes", () =>
    Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const coordinator = yield* Effect.scoped(Effect.gen(function*() {
        const coordinator = yield* RunCoordinator.make({
          drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        })
        yield* coordinator.wake("run")
        yield* Deferred.await(started)
        expect(Array.from(yield* coordinator.active)).toEqual(["run"])
        return coordinator
      }))
      expect(Array.from(yield* coordinator.active)).toEqual([])
    }))

  effect("reports active keys", () =>
    Effect.scoped(Effect.gen(function*() {
      const gate = yield* Deferred.make<void>()
      const started = yield* Deferred.make<void>()
      const coordinator = yield* RunCoordinator.make({
        drain: () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate)))
      })
      expect(Array.from(yield* coordinator.active)).toEqual([])
      const running = yield* coordinator.run("run").pipe(Effect.forkChild)
      yield* Deferred.await(started)
      expect(Array.from(yield* coordinator.active)).toEqual(["run"])
      yield* Deferred.succeed(gate, undefined)
      yield* Fiber.join(running)
      expect(Array.from(yield* coordinator.active)).toEqual([])
    })))
})
