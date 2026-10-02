/**
 * The lease is evidence.
 *
 * `steal` used to accept only evidence a caller produced out of band — a pid
 * probe on the owner's host, or an unreachability judgement across hosts — so
 * a process that had nothing but the persisted heartbeat could not reclaim a
 * hard-killed owner at all. The lease itself is the one piece of evidence the
 * store can verify: the steal predicate already refuses any row whose
 * `heartbeat_at_ms` is inside the staleness window, so `lease-expired` evidence
 * is checked by the write that consumes it rather than trusted.
 */
import { describe, expect, it } from "@effect/vitest"
import type { DurableWriter } from "@smthrs/database"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Consensus from "@smthrs/journal/Consensus"
import { Cause, Clock, Deferred, Duration, Effect, Exit, Fiber, Logger, References } from "effect"
import { TestClock } from "effect/testing"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { vi } from "vitest"
import * as Migrations from "../src/Migrations.ts"
import {
  heartbeatInterval,
  heartbeatLoop,
  heartbeatStaleAfter,
  heartbeatWriteTolerance,
  leaseLiveness,
  type LivenessEvidence,
  type OwnerId,
  sameHostIncarnation,
  sameHostPidProbe
} from "../src/Ownership.ts"
import { type RunRow, type RunSnapshot, RunStore } from "../src/RunStore.ts"
import * as RunStoreLive from "../src/RunStore.ts"

const migrated = <A, E>(effect: Effect.Effect<A, E, DurableWriter.DurableWriter | SqlClient.SqlClient | RunStore>) =>
  effect.pipe(
    Effect.provide(RunStoreLive.layer),
    Effect.provide(Migrations.layer),
    Effect.provide(TestDatabase.layer),
    Effect.provide(TestClock.layer())
  )

const ownerA: OwnerId = { hostId: "host-a", pid: 101, nonce: "owner-a" }
const sameHost: OwnerId = { hostId: "host-a", pid: 202, nonce: "owner-b" }
const otherHost: OwnerId = { hostId: "host-b", pid: 303, nonce: "owner-c" }

const staleAfterMs = Duration.toMillis(heartbeatStaleAfter)

const snapshot = (row: RunRow): RunSnapshot => ({
  status: row.status,
  owner: row.owner,
  heartbeatAtMs: row.heartbeatAtMs
})

const activateNew = (store: RunStoreLive.Service, runId: string, owner: OwnerId) =>
  Effect.gen(function*() {
    yield* store.create(runId, "{}")
    const pending = yield* store.get(runId)
    const expected = snapshot(pending)
    const claimedAtMs = yield* Clock.currentTimeMillis
    yield* store.claim(runId, expected, owner, claimedAtMs)
    yield* store.activate(runId, owner, claimedAtMs, expected)
    return yield* store.get(runId)
  })

const leaseExpired = (
  expectedOwner: OwnerId,
  checkedAtMs: number
): LivenessEvidence => ({ expectedOwner, checkedAtMs, kind: "lease-expired" })

describe("leaseLiveness", () => {
  it.effect("reports the owner alive while its lease is inside the staleness window", () =>
    Effect.gen(function*() {
      const isAlive = leaseLiveness(heartbeatStaleAfter)
      // The cutoff matches the store's own steal predicate, which is strict:
      // a lease exactly `heartbeatStaleAfter` old is still fresh.
      expect(yield* isAlive(ownerA, { claimant: sameHost, nowMs: staleAfterMs, heartbeatAtMs: 0 })).toBe(true)
      expect(yield* isAlive(ownerA, { claimant: sameHost, nowMs: staleAfterMs + 1, heartbeatAtMs: 0 })).toBe(false)
    }))

  it.effect("reports an owner with no recorded lease as not alive", () =>
    Effect.gen(function*() {
      const isAlive = leaseLiveness(heartbeatStaleAfter)
      expect(yield* isAlive(ownerA, { claimant: sameHost, nowMs: 5_000, heartbeatAtMs: null })).toBe(false)
    }))

  it.effect("uses the supplied window rather than the default cutoff", () =>
    Effect.gen(function*() {
      const isAlive = leaseLiveness(Duration.seconds(1))
      const context = { claimant: sameHost, nowMs: 5_000 }
      expect(yield* isAlive(ownerA, { ...context, heartbeatAtMs: 4_000 })).toBe(true)
      expect(yield* isAlive(ownerA, { ...context, heartbeatAtMs: 3_999 })).toBe(false)
    }))
})

describe("sameHostIncarnation", () => {
  it("is true only for two incarnations that share a host", () => {
    expect(sameHostIncarnation(ownerA, sameHost)).toBe(true)
    expect(sameHostIncarnation(ownerA, otherHost)).toBe(false)
  })
})

describe("lease-expired evidence", () => {
  it.effect("is accepted from a claimant on any host", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const row = yield* activateNew(store, "lease-expired-cross-host", ownerA)
        yield* TestClock.adjust(staleAfterMs + 1)
        const nowMs = yield* Clock.currentTimeMillis
        return yield* store.steal(
          "lease-expired-cross-host",
          snapshot(row),
          otherHost,
          nowMs,
          leaseExpired(ownerA, nowMs)
        )
      }))

      expect(result._tag).toBe("Claimed")
    }))

  it.effect("is still refused while the persisted lease is fresh", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const row = yield* activateNew(store, "lease-expired-too-early", ownerA)
        yield* TestClock.adjust(staleAfterMs - 1)
        const nowMs = yield* Clock.currentTimeMillis
        return yield* store.steal(
          "lease-expired-too-early",
          snapshot(row),
          sameHost,
          nowMs,
          leaseExpired(ownerA, nowMs)
        )
      }))

      // The write predicate, not the evidence, is what refuses here: the
      // claimant asserted the lease was gone and the row says otherwise.
      expect(result._tag).toBe("HeartbeatFresh")
    }))

  it.effect("still names the owner it was collected against", () =>
    Effect.gen(function*() {
      const result = yield* migrated(Effect.gen(function*() {
        const store = yield* RunStore
        const row = yield* activateNew(store, "lease-expired-wrong-owner", ownerA)
        yield* TestClock.adjust(staleAfterMs + 1)
        const nowMs = yield* Clock.currentTimeMillis
        return yield* store.steal(
          "lease-expired-wrong-owner",
          snapshot(row),
          otherHost,
          nowMs,
          leaseExpired(otherHost, nowMs)
        )
      }))

      expect(result._tag).toBe("LivenessUnconfirmed")
    }))
})

/**
 * B-09: every in-repo composition answered `isAlive: () => Effect.succeed(false)`,
 * so two engine processes over one `.flows/engine.db` steal each other's
 * running rows `heartbeatStaleAfter` after any heartbeat stall — a stop-the-world
 * GC pause, a swapped-out process, a slow disk. Only the evidence SCHEMA for a
 * pid probe existed; nothing in the repository ever called `process.kill`.
 *
 * The probe is the Node hosts' liveness check. It answers about a pid only when
 * the recorded owner and the claimant name the same host, because `owner.pid`
 * names a process in the claimant's own process namespace and nowhere else.
 */
describe("sameHostPidProbe", () => {
  /** This test process's own identity, which is the one live pid a case can count on. */
  const self: OwnerId = { hostId: "probe-host", pid: process.pid, nonce: "self" }
  const claimant: OwnerId = { hostId: "probe-host", pid: process.pid, nonce: "claimant" }

  it.effect("treats ESRCH as the sole proof that a same-host process is gone", () =>
    Effect.gen(function*() {
      const cases = [
        { name: "normal return", thrown: undefined, alive: true },
        { name: "ESRCH", thrown: { code: "ESRCH" }, alive: false },
        { name: "EPERM", thrown: { code: "EPERM" }, alive: true },
        { name: "EACCES", thrown: { code: "EACCES" }, alive: true },
        { name: "EINVAL", thrown: { code: "EINVAL" }, alive: true },
        { name: "unrecognized throw", thrown: "boom", alive: true }
      ] as const

      for (const probeCase of cases) {
        const kill = vi.spyOn(process, "kill").mockImplementation(
          (() => {
            if (probeCase.thrown !== undefined) throw probeCase.thrown
            return true
          }) as typeof process.kill
        )
        try {
          expect(
            yield* sameHostPidProbe(self, { claimant, heartbeatAtMs: 0, nowMs: 1 }),
            probeCase.name
          ).toBe(probeCase.alive)
          expect(kill).toHaveBeenCalledOnce()
        } finally {
          kill.mockRestore()
        }
      }
    }))

  it.effect("does not call process.kill for a cross-host owner", () =>
    Effect.gen(function*() {
      const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill)
      try {
        const elsewhere: OwnerId = { hostId: "other-host", pid: process.pid, nonce: "remote" }
        expect(yield* sameHostPidProbe(elsewhere, { claimant, heartbeatAtMs: 0, nowMs: 1 })).toBe(false)
        expect(kill).not.toHaveBeenCalled()
      } finally {
        kill.mockRestore()
      }
    }))

  it.effect("fails closed without signaling an invalid or synthetic pid", () =>
    Effect.gen(function*() {
      const kill = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill)
      try {
        for (const pid of [0, -1, 1.5, Number.NaN]) {
          const invalid = { hostId: "probe-host", pid, nonce: "invalid" } as OwnerId
          expect(yield* sameHostPidProbe(invalid, { claimant, heartbeatAtMs: 0, nowMs: 1 })).toBe(true)
        }
        expect(kill).not.toHaveBeenCalled()
      } finally {
        kill.mockRestore()
      }
    }))

  it.effect("reports a live pid on the claimant's own host as alive", () =>
    Effect.gen(function*() {
      expect(yield* sameHostPidProbe(self, { claimant, heartbeatAtMs: 0, nowMs: 1 })).toBe(true)
    }))

  /**
   * The documented limit of asking a pid: an owner recorded by a PREVIOUS
   * incarnation of this same process — or by a second engine composed inside
   * it — differs from the claimant only by `nonce`, and the process it names
   * is this one. It is therefore always alive, and its row is never stolen
   * while the process lives. Reading it as dead is not the alternative: two
   * engines in one process are the shape this check exists to arbitrate, and
   * that reading would let each steal the other's live runs. An embedded host
   * that re-creates its engine in place keeps `leaseLiveness`, whose timeout
   * does expire.
   */
  it.effect("cannot tell a previous incarnation in this process from the claimant", () =>
    Effect.gen(function*() {
      const previous: OwnerId = { hostId: "probe-host", pid: process.pid, nonce: "previous-incarnation" }
      expect(yield* sameHostPidProbe(previous, { claimant, heartbeatAtMs: 0, nowMs: 1 })).toBe(true)
    }))

  it.effect("reports a pid that has exited as gone", () =>
    Effect.gen(function*() {
      // A real process, really reaped: `exit` has fired, so the pid names
      // nothing by the time it is probed.
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
      yield* Effect.promise(() => once(child, "exit"))
      const dead: OwnerId = { hostId: "probe-host", pid: child.pid as number, nonce: "dead" }
      expect(yield* sameHostPidProbe(dead, { claimant, heartbeatAtMs: 0, nowMs: 1 })).toBe(false)
    }))

  it.effect("never inspects a pid recorded by another host", () =>
    Effect.gen(function*() {
      // The pid is this very process, so a probe that ignored the host
      // relation would answer `true` about a process on a machine it cannot
      // see. The lease is the only evidence that crosses hosts.
      const elsewhere: OwnerId = { hostId: "other-host", pid: process.pid, nonce: "remote" }
      expect(yield* sameHostPidProbe(elsewhere, { claimant, heartbeatAtMs: 0, nowMs: 1 })).toBe(false)
    }))

  it.effect("treats a refused signal as a live process", () =>
    Effect.gen(function*() {
      // EPERM is the one failure that proves the process EXISTS: the signal
      // was refused, not undeliverable. Stubbed because a pid this user may
      // not signal is not something a test can conjure portably.
      const kill = process.kill
      const refused = Object.assign(new Error("operation not permitted"), { code: "EPERM" })
      process.kill = (() => {
        throw refused
      }) as typeof process.kill
      try {
        expect(yield* sameHostPidProbe(self, { claimant, heartbeatAtMs: 0, nowMs: 1 })).toBe(true)
      } finally {
        process.kill = kill
      }
    }))
})

describe("heartbeatLoop write deadline", () => {
  const toleranceMs = Duration.toMillis(heartbeatWriteTolerance)
  const intervalMs = Duration.toMillis(heartbeatInterval)
  const heartbeatFailure = new RunStoreLive.RunStoreError({
    code: "persistence_failed",
    method: "heartbeat",
    message: "database unavailable",
    cause: new Error("SQLITE_BUSY")
  })

  for (const completion of ["never", "failure", "success"] as const) {
    it.effect(`interrupts owned work while a ${completion} heartbeat is stalled`, () =>
      Effect.gen(function*() {
        let calls = 0
        let writeInterrupted = false
        let workInterruptedAtMs: number | undefined
        let workFinished = false
        const owning = yield* Effect.raceFirst(
          Effect.sleep("40 seconds").pipe(
            Effect.andThen(Effect.sync(() => {
              workFinished = true
            })),
            Effect.onInterrupt(() =>
              Clock.currentTimeMillis.pipe(
                Effect.tap((nowMs) =>
                  Effect.sync(() => {
                    workInterruptedAtMs = nowMs
                  })
                )
              )
            )
          ),
          heartbeatLoop("stalled-heartbeat", ownerA)
        ).pipe(
          Effect.provide(RunStoreLive.layerNoop({
            heartbeat: (_runId, _owner, atMs) => {
              calls++
              const result = completion === "never"
                ? Effect.never
                : Effect.sleep("35 seconds").pipe(Effect.andThen(
                  completion === "failure"
                    ? Effect.fail(heartbeatFailure)
                    : Effect.succeed({ _tag: "Updated" as const, heartbeatAtMs: atMs })
                ))
              return result.pipe(Effect.onInterrupt(() =>
                Effect.sync(() => {
                  writeInterrupted = true
                })
              ))
            }
          })),
          Effect.forkChild({ startImmediately: true })
        )

        yield* TestClock.adjust(toleranceMs - 1)
        expect(calls).toBe(1)
        expect(owning.pollUnsafe()).toBeUndefined()
        yield* TestClock.adjust(1)
        yield* Effect.yieldNow
        const exit = owning.pollUnsafe()
        expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(writeInterrupted).toBe(true)
        expect(workInterruptedAtMs).toBe(toleranceMs)
        expect(toleranceMs).toBeLessThan(staleAfterMs)

        // The review probes observed live work at 31 seconds and a side effect at 40.
        yield* TestClock.adjust(40_000 - toleranceMs)
        expect(workFinished).toBe(false)
        expect(calls).toBe(1)
      }))
  }

  it.effect("warns once per outage when heartbeat writes fail, and again when the lease lapses", () =>
    Effect.gen(function*() {
      const warnings: Array<{ readonly message: string; readonly annotations: Record<string, unknown> }> = []
      const logger = Logger.make<unknown, void>(({ fiber, logLevel, message }) => {
        if (logLevel !== "Warn") return
        warnings.push({
          message: (Array.isArray(message) ? message : [message]).map(String).join(" "),
          annotations: { ...fiber.getRef(References.CurrentLogAnnotations) }
        })
      })
      let calls = 0
      const owning = yield* Effect.raceFirst(Effect.never, heartbeatLoop("failing-heartbeat", ownerA)).pipe(
        Effect.provide(RunStoreLive.layerNoop({
          heartbeat: () => {
            calls++
            return Effect.fail(heartbeatFailure)
          }
        })),
        Effect.provide(Logger.layer([logger])),
        Effect.forkChild({ startImmediately: true })
      )

      yield* TestClock.adjust(intervalMs * 3)
      expect(calls).toBe(3)
      expect(warnings).toEqual([{
        message: "run heartbeat write failed",
        annotations: { runId: "failing-heartbeat", code: "persistence_failed" }
      }])

      yield* TestClock.adjust(toleranceMs - intervalMs * 3)
      yield* Effect.yieldNow
      const exit = owning.pollUnsafe()
      expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(warnings[1]).toEqual({
        message: "run lease lapsed; interrupting owned work",
        annotations: { runId: "failing-heartbeat", unconfirmedMs: toleranceMs }
      })
      expect(warnings).toHaveLength(2)
    }))

  it.effect("reports a lapsed lease's unconfirmed duration, and never a lost fence, to onLapse (#3328)", () =>
    Effect.gen(function*() {
      const lapses: Array<number> = []
      const onLapse = (unconfirmedMs: number) => Effect.sync(() => void lapses.push(unconfirmedMs))
      const lapsing = yield* Effect.raceFirst(Effect.never, heartbeatLoop("lapsing", ownerA, { onLapse })).pipe(
        Effect.provide(RunStoreLive.layerNoop({ heartbeat: () => Effect.fail(heartbeatFailure) })),
        Effect.forkChild({ startImmediately: true })
      )
      yield* TestClock.adjust(toleranceMs)
      yield* Effect.yieldNow
      const lapsed = lapsing.pollUnsafe()
      expect(lapsed !== undefined && Exit.isFailure(lapsed) && Cause.hasInterruptsOnly(lapsed.cause)).toBe(true)
      expect(lapses).toEqual([toleranceMs])

      const fenced = yield* Effect.raceFirst(Effect.never, heartbeatLoop("fenced", ownerA, { onLapse })).pipe(
        Effect.provide(RunStoreLive.layerNoop({ heartbeat: () => Effect.succeed({ _tag: "NotFound" as const }) })),
        Effect.forkChild({ startImmediately: true })
      )
      yield* TestClock.adjust(intervalMs)
      yield* Effect.yieldNow
      const lost = fenced.pollUnsafe()
      expect(lost !== undefined && Exit.isFailure(lost) && Cause.hasInterruptsOnly(lost.cause)).toBe(true)
      expect(lapses).toEqual([toleranceMs])
    }))

  for (
    const [gapMs, expired] of [[toleranceMs - 1, false], [toleranceMs, true], [toleranceMs + intervalMs, true]] as const
  ) {
    it.effect(`checks a pulse delayed ${gapMs}ms before its watchdog resumes`, () =>
      Effect.gen(function*() {
        const baseClock = yield* Clock.Clock
        const pulse = yield* Deferred.make<void>()
        const watchdog = yield* Deferred.make<void>()
        let now = 0
        let waits = 0
        let calls = 0
        const clock: Clock.Clock = {
          ...baseClock,
          currentTimeMillis: Effect.sync(() => now),
          currentTimeMillisUnsafe: () => now,
          sleep: () => Deferred.await(++waits === 1 ? pulse : watchdog)
        }
        const owning = yield* Effect.raceFirst(Effect.never, heartbeatLoop("expired-pulse", ownerA)).pipe(
          Effect.provideService(Clock.Clock, clock),
          Effect.provide(RunStoreLive.layerNoop({
            heartbeat: (_runId, _owner, atMs) => {
              calls++
              return Effect.succeed({ _tag: "Updated" as const, heartbeatAtMs: atMs })
            }
          })),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        expect(waits).toBe(2)
        // Model a stopped host: both timers are overdue, but its pulse executes
        // first. Scheduling the watchdog later must not renew an expired lease.
        now = gapMs
        yield* Deferred.succeed(pulse, undefined)
        yield* Effect.yieldNow
        expect(calls).toBe(expired ? 0 : 1)
        const exit = owning.pollUnsafe()
        expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(expired)
        yield* Fiber.interrupt(owning)
      }))
  }

  it.effect("re-arms a delayed success from its persisted timestamp, not its completion time", () =>
    Effect.gen(function*() {
      let calls = 0
      const owning = yield* Effect.raceFirst(Effect.never, heartbeatLoop("delayed-heartbeat", ownerA)).pipe(
        Effect.provide(RunStoreLive.layerNoop({
          heartbeat: (_runId, _owner, atMs) => {
            calls++
            return calls === 1
              ? Effect.sleep("5 seconds").pipe(
                Effect.as({ _tag: "Updated" as const, heartbeatAtMs: atMs })
              )
              : Effect.never
          }
        })),
        Effect.forkChild({ startImmediately: true })
      )

      yield* TestClock.adjust(toleranceMs)
      expect(owning.pollUnsafe()).toBeUndefined()
      expect(calls).toBe(2)
      yield* TestClock.adjust(intervalMs - 1)
      expect(owning.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      yield* Effect.yieldNow
      const exit = owning.pollUnsafe()
      expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      yield* Fiber.interrupt(owning)
    }))
})

describe("heartbeatLoop lease reconfirm", () => {
  const toleranceMs = Duration.toMillis(heartbeatWriteTolerance)
  const intervalMs = Duration.toMillis(heartbeatInterval)

  for (const state of ["untouched", "pending claim", "foreign owner"] as const) {
    it.effect(`reconfirms an untouched lease and interrupts with ${state}`, () =>
      Effect.gen(function*() {
        const consensus = yield* Consensus.Consensus
        yield* consensus.claim("reconfirm-loop", ownerA, 0)
        yield* consensus.activate("reconfirm-loop", ownerA, 0, 0)
        if (state !== "untouched") {
          const atMs = staleAfterMs + 1
          expect((yield* consensus.steal("reconfirm-loop", otherHost, atMs, leaseExpired(ownerA, atMs)))._tag).toBe(
            "Claimed"
          )
          if (state === "foreign owner") yield* consensus.activate("reconfirm-loop", otherHost, atMs, atMs)
        }
        const reconfirmed: Array<number> = []
        const lapsed: Array<number> = []
        const owning = yield* heartbeatLoop("reconfirm-loop", ownerA, {
          onReconfirm: (ms) =>
            Effect.sync(() => {
              reconfirmed.push(ms)
            }),
          onLapse: (ms) =>
            Effect.sync(() => {
              lapsed.push(ms)
            })
        }).pipe(
          Effect.provide(RunStoreLive.layerNoop({
            heartbeat: () => Effect.never,
            reconfirm: (runId, owner, nowMs) =>
              consensus.reconfirm(runId, owner, nowMs).pipe(
                Effect.orDie,
                Effect.map((result) =>
                  result._tag === "Renewed"
                    ? { _tag: "Updated" as const, heartbeatAtMs: result.heartbeatAtMs }
                    : { _tag: "FenceLost" as const }
                )
              )
          })),
          Effect.forkChild({ startImmediately: true })
        )
        yield* TestClock.adjust(toleranceMs - 1)
        expect(owning.pollUnsafe()).toBeUndefined()
        expect(reconfirmed).toEqual([])
        yield* TestClock.adjust(1)
        yield* Effect.yieldNow
        if (state === "untouched") {
          expect(owning.pollUnsafe()).toBeUndefined()
          expect(reconfirmed).toEqual([toleranceMs])
          expect(lapsed).toEqual([])
          expect(yield* consensus.heartbeat("reconfirm-loop", ownerA, 0)).toEqual({
            _tag: "Renewed",
            heartbeatAtMs: toleranceMs
          })
          // A second outage period can also be reconfirmed; the deadline is
          // reset by the committed lease, rather than ending the supervisor.
          yield* TestClock.adjust(toleranceMs)
          expect(owning.pollUnsafe()).toBeUndefined()
          expect(reconfirmed).toEqual([toleranceMs, toleranceMs])
        } else {
          const exit = owning.pollUnsafe()
          expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
          expect(reconfirmed).toEqual([])
          expect(lapsed).toEqual([toleranceMs])
        }
        yield* Fiber.interrupt(owning)
      }).pipe(Effect.provide(Consensus.layerLocal)))
  }

  it.effect("continues after reconfirm without an optional audit hook", () =>
    Effect.gen(function*() {
      let calls = 0
      const owning = yield* heartbeatLoop("reconfirm-no-hook", ownerA).pipe(
        Effect.provide(RunStoreLive.layerNoop({
          heartbeat: () => Effect.never,
          reconfirm: () =>
            Effect.sync(() => {
              calls++
              return { _tag: "Updated" as const }
            })
        })),
        Effect.forkChild({ startImmediately: true })
      )
      yield* TestClock.adjust(toleranceMs)
      expect(calls).toBe(1)
      expect(owning.pollUnsafe()).toBeUndefined()
      yield* Fiber.interrupt(owning)
    }))

  for (const renewalDelayMs of [0, intervalMs - 1]) {
    it.effect(`keeps owned work through a delayed receipt after a ${renewalDelayMs}ms reconfirm (#3411)`, () =>
      Effect.gen(function*() {
        const receipts: Array<number> = []
        const lapses: Array<number> = []
        const owning = yield* heartbeatLoop("delayed-reconfirm-receipt", ownerA, {
          onReconfirm: (gapMs) =>
            Effect.sleep(intervalMs + 1).pipe(
              Effect.andThen(Effect.sync(() => void receipts.push(gapMs)))
            ),
          onLapse: (gapMs) => Effect.sync(() => void lapses.push(gapMs))
        }).pipe(
          Effect.provide(RunStoreLive.layerNoop({
            heartbeat: () => Effect.never,
            reconfirm: () => Effect.sleep(renewalDelayMs).pipe(Effect.as({ _tag: "Updated" as const }))
          })),
          Effect.forkChild({ startImmediately: true })
        )
        yield* TestClock.adjust(toleranceMs + renewalDelayMs + intervalMs + 1)
        expect(receipts).toEqual([toleranceMs])
        expect(lapses).toEqual([])
        expect(owning.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(owning)
      }))
  }

  it.effect("bounds a stalled receipt from its persisted renewal stamp, not renewal completion (#3411)", () =>
    Effect.gen(function*() {
      let receiptInterruptedAtMs: number | undefined
      let ownedInterruptedAtMs: number | undefined
      const lapses: Array<number> = []
      const owning = yield* Effect.raceFirst(
        Effect.never.pipe(Effect.onInterrupt(() =>
          Clock.currentTimeMillis.pipe(
            Effect.tap((atMs) => Effect.sync(() => void (ownedInterruptedAtMs = atMs)))
          )
        )),
        heartbeatLoop("bounded-reconfirm-receipt", ownerA, {
          onReconfirm: () =>
            Effect.never.pipe(Effect.onInterrupt(() =>
              Clock.currentTimeMillis.pipe(
                Effect.tap((atMs) => Effect.sync(() => void (receiptInterruptedAtMs = atMs)))
              )
            )),
          onLapse: (gapMs) => Effect.sync(() => void lapses.push(gapMs))
        })
      ).pipe(
        Effect.provide(RunStoreLive.layerNoop({
          heartbeat: () => Effect.never,
          reconfirm: () => Effect.sleep(intervalMs - 1).pipe(Effect.as({ _tag: "Updated" as const }))
        })),
        Effect.forkChild({ startImmediately: true })
      )
      yield* TestClock.adjust(toleranceMs * 2 - 1)
      expect(owning.pollUnsafe()).toBeUndefined()
      expect(lapses).toEqual([])
      yield* TestClock.adjust(1)
      yield* Effect.yieldNow
      const exit = owning.pollUnsafe()
      expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
      expect(receiptInterruptedAtMs).toBe(toleranceMs * 2)
      expect(ownedInterruptedAtMs).toBe(toleranceMs * 2)
      expect(lapses).toEqual([toleranceMs])
    }))

  for (const overshootMs of [0, 1]) {
    it.effect(`refuses a renewal result whose persisted stamp is ${overshootMs}ms past its budget (#3411)`, () =>
      Effect.gen(function*() {
        const baseClock = yield* Clock.Clock
        const timers = yield* Deferred.make<void>()
        const lapses: Array<number> = []
        let nowMs = 0
        let waits = 0
        let receipts = 0
        const clock: Clock.Clock = {
          ...baseClock,
          currentTimeMillis: Effect.sync(() => nowMs),
          currentTimeMillisUnsafe: () => nowMs,
          sleep: () => ++waits <= 2 ? Deferred.await(timers) : Effect.never
        }
        const owning = yield* heartbeatLoop("expired-renewal-result", ownerA, {
          onReconfirm: () => Effect.sync(() => void receipts++),
          onLapse: (gapMs) => Effect.sync(() => void lapses.push(gapMs))
        }).pipe(
          Effect.provideService(Clock.Clock, clock),
          Effect.provide(RunStoreLive.layerNoop({
            heartbeat: () => Effect.die("an overdue pulse must reconfirm"),
            reconfirm: (_runId, _owner, atMs) =>
              Effect.sync(() => {
                // The clock jumped while the persistence result was returning.
                // Its stamp remains atMs; completion time is not fresh evidence.
                nowMs = atMs + toleranceMs + overshootMs
                return { _tag: "Updated" as const }
              })
          })),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        nowMs = toleranceMs
        yield* Deferred.succeed(timers, undefined)
        for (let index = 0; index < 10; index++) yield* Effect.yieldNow
        const exit = owning.pollUnsafe()
        expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(receipts).toBe(0)
        expect(lapses).toEqual([toleranceMs])
      }))
  }

  for (const renewed of [true, false]) {
    it.effect(`settles simultaneous overdue pulse and watchdog once when reconfirm ${renewed ? "succeeds" : "loses"}`, () =>
      Effect.gen(function*() {
        const baseClock = yield* Clock.Clock
        const timers = yield* Deferred.make<void>()
        const entered = yield* Deferred.make<void>()
        const finish = yield* Deferred.make<void>()
        let now = 0
        let waits = 0
        let calls = 0
        const receipts: Array<string> = []
        const clock: Clock.Clock = {
          ...baseClock,
          currentTimeMillis: Effect.sync(() => now),
          currentTimeMillisUnsafe: () => now,
          sleep: () => ++waits <= 2 ? Deferred.await(timers) : Effect.never
        }
        const owning = yield* heartbeatLoop("simultaneous-expiry", ownerA, {
          onReconfirm: () =>
            Effect.sync(() => {
              receipts.push("reconfirmed")
            }),
          onLapse: () =>
            Effect.sync(() => {
              receipts.push("lapsed")
            }).pipe(Effect.andThen(Effect.yieldNow))
        }).pipe(
          Effect.provideService(Clock.Clock, clock),
          Effect.provide(RunStoreLive.layerNoop({
            heartbeat: () => Effect.die("an overdue pulse must reconfirm"),
            reconfirm: () =>
              Effect.gen(function*() {
                calls++
                yield* Deferred.succeed(entered, undefined)
                yield* Deferred.await(finish)
                return renewed ? { _tag: "Updated" as const } : { _tag: "FenceLost" as const }
              })
          })),
          Effect.forkChild({ startImmediately: true })
        )
        yield* Effect.yieldNow
        expect(waits).toBe(2)
        now = toleranceMs
        yield* Deferred.succeed(timers, undefined)
        yield* Deferred.await(entered)
        yield* Effect.yieldNow
        expect(calls).toBe(1)
        yield* Deferred.succeed(finish, undefined)
        for (let index = 0; index < 10; index++) yield* Effect.yieldNow
        expect(calls).toBe(1)
        expect(receipts).toEqual([renewed ? "reconfirmed" : "lapsed"])
        const exit = owning.pollUnsafe()
        expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(!renewed)
        yield* Fiber.interrupt(owning)
      }))
  }

  for (const interrupted of ["reconfirm", "receipt"] as const) {
    it.effect(`propagates a self-interrupted ${interrupted} without recording lapse`, () =>
      Effect.gen(function*() {
        const lapsed: Array<number> = []
        const owning = yield* heartbeatLoop("self-interrupt-reconfirm", ownerA, {
          onReconfirm: () => Effect.interrupt,
          onLapse: (ms) =>
            Effect.sync(() => {
              lapsed.push(ms)
            })
        }).pipe(
          Effect.provide(RunStoreLive.layerNoop({
            heartbeat: () => Effect.never,
            reconfirm: () => interrupted === "reconfirm" ? Effect.interrupt : Effect.succeed({ _tag: "Updated" })
          })),
          Effect.forkChild({ startImmediately: true })
        )
        yield* TestClock.adjust(toleranceMs)
        yield* Effect.yieldNow
        const exit = owning.pollUnsafe()
        expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(lapsed).toEqual([])
        yield* Fiber.interrupt(owning)
      }))
  }

  for (const pending of ["reconfirm", "receipt"] as const) {
    it.effect(`preserves parent cancellation while ${pending} is pending`, () =>
      Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        let interrupted = false
        const lapsed: Array<number> = []
        const blocked = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true
            })
          )
        )
        const owning = yield* heartbeatLoop("cancel-reconfirm", ownerA, {
          onReconfirm: () => blocked,
          onLapse: (ms) =>
            Effect.sync(() => {
              lapsed.push(ms)
            })
        }).pipe(
          Effect.provide(RunStoreLive.layerNoop({
            heartbeat: () => Effect.never,
            reconfirm: () => pending === "reconfirm" ? blocked : Effect.succeed({ _tag: "Updated" })
          })),
          Effect.forkChild({ startImmediately: true })
        )
        yield* TestClock.adjust(toleranceMs)
        yield* Deferred.await(started)
        yield* Fiber.interrupt(owning)
        const exit = owning.pollUnsafe()
        expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(interrupted).toBe(true)
        expect(lapsed).toEqual([])
      }))
  }

  for (const receipt of ["timeout", "error", "defect"] as const) {
    it.effect(`interrupts owned work when the reconfirm receipt ends in ${receipt}`, () =>
      Effect.gen(function*() {
        let receiptInterrupted = false
        let ownedInterrupted = false
        const lapsed: Array<number> = []
        const owning = yield* Effect.raceFirst(
          Effect.never.pipe(Effect.onInterrupt(() =>
            Effect.sync(() => {
              ownedInterrupted = true
            })
          )),
          heartbeatLoop("reconfirm-receipt", ownerA, {
            onReconfirm: () =>
              (receipt === "timeout" ? Effect.never : receipt === "defect" ?
                Effect.die("receipt unavailable")
                // Exercise a runtime callback that violates its infallible contract.
                : Effect.fail("receipt unavailable") as unknown as Effect.Effect<void>).pipe(
                  Effect.onInterrupt(() =>
                    Effect.sync(() => {
                      receiptInterrupted = true
                    })
                  )
                ),
            onLapse: (ms) =>
              Effect.sync(() => {
                lapsed.push(ms)
              })
          })
        ).pipe(
          Effect.provide(RunStoreLive.layerNoop({
            heartbeat: () => Effect.never,
            reconfirm: () => Effect.succeed({ _tag: "Updated" })
          })),
          Effect.forkChild({ startImmediately: true })
        )
        yield* TestClock.adjust(toleranceMs)
        if (receipt === "timeout") {
          yield* TestClock.adjust(toleranceMs - 1)
          expect(owning.pollUnsafe()).toBeUndefined()
          yield* TestClock.adjust(1)
        }
        yield* Effect.yieldNow
        const exit = owning.pollUnsafe()
        expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(lapsed).toEqual([toleranceMs])
        expect(ownedInterrupted).toBe(true)
        if (receipt === "timeout") expect(receiptInterrupted).toBe(true)
        yield* Fiber.interrupt(owning)
      }))
  }

  for (const failure of ["timeout", "error"] as const) {
    it.effect(`interrupts when reconfirm ends in ${failure}`, () =>
      Effect.gen(function*() {
        let calls = 0
        let writeInterrupted = false
        const lapsed: Array<number> = []
        const owning = yield* heartbeatLoop("reconfirm-unavailable", ownerA, {
          onReconfirm: () => Effect.die("failed reconfirm must not report success"),
          onLapse: (ms) =>
            Effect.sync(() => {
              lapsed.push(ms)
            })
        }).pipe(
          Effect.provide(RunStoreLive.layerNoop({
            heartbeat: () => Effect.never,
            reconfirm: () => {
              calls++
              return (failure === "timeout" ? Effect.never : Effect.fail(
                new RunStoreLive.RunStoreError({
                  code: "persistence_failed",
                  method: "reconfirm",
                  message: "offline",
                  cause: new Error("offline")
                })
              )).pipe(Effect.onInterrupt(() =>
                Effect.sync(() => {
                  writeInterrupted = true
                })
              ))
            }
          })),
          Effect.forkChild({ startImmediately: true })
        )
        yield* TestClock.adjust(toleranceMs)
        expect(calls).toBe(1)
        if (failure === "timeout") {
          expect(owning.pollUnsafe()).toBeUndefined()
          yield* TestClock.adjust(intervalMs - 1)
          expect(owning.pollUnsafe()).toBeUndefined()
          yield* TestClock.adjust(1)
        }
        yield* Effect.yieldNow
        const exit = owning.pollUnsafe()
        expect(exit !== undefined && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(lapsed).toHaveLength(1)
        if (failure === "timeout") expect(writeInterrupted).toBe(true)
        yield* Fiber.interrupt(owning)
      }))
  }
})
