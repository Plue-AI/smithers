import { expect, it } from "@effect/vitest"
import { Ownership, RunStore } from "@smthrs/run-store"
import * as TestRunStore from "@smthrs/run-store/test/TestRunStore"
import { Cause, Clock, Duration, Effect, Exit } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vitest"
import * as ControlAffinity from "../src/internal/ControlAffinity.ts"

const claimant: Ownership.OwnerId = { hostId: "host", pid: process.pid, nonce: "claimant" }
const peer: Ownership.OwnerId = { hostId: "host", pid: process.pid + 1, nonce: "peer" }
const staleAfter = Duration.toMillis(Ownership.heartbeatStaleAfter)
const running = (store: RunStore.Service, owner = peer) =>
  Effect.gen(function*() {
    yield* store.create("root", "{}")
    const row = yield* store.get("root")
    const now = yield* Clock.currentTimeMillis
    expect((yield* store.claimAndOwn("root", row, owner, now))._tag).toBe("Activated")
    return yield* store.get("root")
  })
const stored = <A, E>(effect: Effect.Effect<A, E, RunStore.RunStore>) =>
  effect.pipe(
    Effect.provide(TestRunStore.layer),
    Effect.provide(TestClock.layer())
  )

it.effect("admits engine-only children and unclaimed pending control rows", () =>
  stored(Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const admit = ControlAffinity.make({ runs, claimant })
    expect(yield* admit("missing-child")).toBe(true)
    yield* runs.create("pending", "{}")
    expect(yield* admit("pending")).toBe(true)
  })))

it.effect("retains fresh peer ownership at the exact lease cutoff without probing", () =>
  stored(Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* running(runs)
    const probe = vi.fn(() => Effect.succeed(false))
    const admit = ControlAffinity.make({ runs, claimant, isAlive: probe })
    expect(yield* admit("root")).toBe(false)
    yield* TestClock.adjust(staleAfter)
    expect(yield* admit("root")).toBe(false)
    expect(probe).not.toHaveBeenCalled()
  })))

it.effect("admits a same-process owner across nonce changes without probing", () =>
  stored(Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* running(runs, { ...claimant, nonce: "earlier-session" })
    const probe = vi.fn(() => Effect.succeed(false))
    expect(yield* ControlAffinity.make({ runs, claimant, isAlive: probe })("root")).toBe(true)
    expect(probe).not.toHaveBeenCalled()
  })))

it.effect("keeps a stale live owner parked and admits recovery only after confirmed death", () =>
  stored(Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const before = yield* running(runs)
    yield* TestClock.adjust(staleAfter + 1)
    const nowMs = yield* Clock.currentTimeMillis
    const probe = vi.fn(() => Effect.succeed(true))
    const admit = ControlAffinity.make({ runs, claimant, isAlive: probe })
    expect(yield* admit("root")).toBe(false)
    expect(probe).toHaveBeenCalledWith(peer, { claimant, heartbeatAtMs: before.heartbeatAtMs, nowMs })
    probe.mockImplementation(() => Effect.succeed(false))
    expect(yield* admit("root")).toBe(true)
    // Admission is read-only; the authoritative fenced claim remains untouched.
    expect(yield* runs.get("root")).toEqual(before)
  })))

it.effect("uses the real process probe to preserve a stale live same-host owner", () =>
  stored(Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* running(runs, claimant)
    yield* TestClock.adjust(staleAfter + 1)
    expect(yield* ControlAffinity.make({ runs, claimant: peer })("root")).toBe(false)
  })))

it.effect("fails closed for incomplete running ownership and unknown liveness", () =>
  stored(Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    const row = yield* running(runs)
    yield* TestClock.adjust(staleAfter + 1)
    const probe = vi.fn(() => Effect.die("probe unavailable"))
    // Invalid persisted states are injected at get: public writes correctly
    // reject them, so manufacturing them through those writes is impossible.
    for (const replacement of [{ ...row, owner: null }, { ...row, heartbeatAtMs: null }]) {
      const faulty = { ...runs, get: () => Effect.succeed(replacement) }
      expect(yield* ControlAffinity.make({ runs: faulty, claimant, isAlive: probe })("root")).toBe(false)
    }
    expect(probe).not.toHaveBeenCalled()
    expect(yield* ControlAffinity.make({ runs, claimant, isAlive: probe })("root")).toBe(false)
    expect(probe).toHaveBeenCalledOnce()
  })))

it.effect("fails closed for read errors and defects while preserving interruption", () =>
  stored(Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    // Fault injection tests failure policy without replacing production SQLite
    // behavior in the ownership cases above.
    const error = new RunStore.RunStoreError({ code: "invalid_run", method: "get", message: "unreadable", cause: null })
    for (const get of [() => Effect.fail(error), () => Effect.die("sqlite unavailable")]) {
      expect(yield* ControlAffinity.make({ runs: { ...runs, get }, claimant })("root")).toBe(false)
    }
    const exit = yield* Effect.exit(
      ControlAffinity.make({ runs: { ...runs, get: () => Effect.interrupt }, claimant })("root")
    )
    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })))
