/**
 * Failure and hard-boundary-violation paths of the action executor
 * (issue #21): failed execute, prepare/settle boundary failures, suspended
 * attempt rows, and the fence guard on the failed-attempt finish path.
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, type JournalEvent } from "@smthrs/journal"
import * as Notifying from "@smthrs/journal/test/Notifying"
import { Jj } from "@smthrs/kernel"
import { AttemptStore, Ownership, RunStore } from "@smthrs/run-store"
import { CacheStore } from "@smthrs/step-cache"
import * as Cause from "effect/Cause"
import * as Clock from "effect/Clock"
import type * as Crypto from "effect/Crypto"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type * as Scope from "effect/Scope"
import { TestClock } from "effect/testing"
import * as ActionPersistence from "../src/internal/ActionPersistence.ts"
import * as StepBoundary from "../src/StepBoundary.ts"
import * as StepSandbox from "../src/StepSandbox.ts"
import * as TestStores from "../src/test/TestStores.ts"
import * as WorkspaceSandbox from "../src/WorkspaceSandbox.ts"
import * as Clocks from "./Clocks.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const ownerA: Ownership.OwnerId = { hostId: "failure-host-a", pid: 1, nonce: "failure-owner-a" }
const ownerB: Ownership.OwnerId = { hostId: "failure-host-b", pid: 2, nonce: "failure-owner-b" }

let getterInvoked = false
let toJsonInvoked = false
let proxyGetInvoked = false

const hardBoundary: ActionPersistence.BoundaryMetadata = {
  readSet: [],
  writeSet: ["declared.txt"],
  boundaryMode: "hard"
}

const jj = Layer.succeed(
  Jj.Jj,
  Jj.make({
    snapshot: () => Effect.succeed({ commitId: "failure-snapshot" as never, changeId: "failure-snapshot" as never }),
    restore: () => Effect.void,
    diff: () => Effect.succeed(""),
    workspaceAdd: () => Effect.void,
    workspaceForget: () => Effect.void,
    status: () => Effect.succeed("")
  })
)

type Services =
  | AttemptStore.AttemptStore
  | CacheStore.CacheStore
  | Journal.Journal
  | RunStore.RunStore
  | StepBoundary.Service
  | Jj.Jj
  | Crypto.Crypto

const run = <A, E>(
  effect: Effect.Effect<A, E, Services | Scope.Scope>,
  boundary: Layer.Layer<StepBoundary.Service> = StepBoundary.layerTest()
) =>
  withCrypto(
    effect.pipe(
      Effect.provide(Layer.mergeAll(TestStores.layer(), boundary, jj)),
      Effect.scoped
    )
  )

const activate = (runId: string, owner: Ownership.OwnerId) =>
  Effect.gen(function*() {
    const runs = yield* RunStore.RunStore
    yield* runs.create(runId, "{}")
    yield* takeover(runs, runId, owner)
  })

const takeover = (runs: RunStore.Service, runId: string, claimant: Ownership.OwnerId) =>
  Effect.gen(function*() {
    const row = yield* runs.get(runId)
    const snapshot = { status: row.status, owner: row.owner, heartbeatAtMs: row.heartbeatAtMs }
    const stealing = row.status === "running" && row.owner !== null
    if (stealing) {
      yield* TestClock.adjust(Duration.millis(Duration.toMillis(Ownership.heartbeatStaleAfter) + 1))
    }
    const now = yield* Clock.currentTimeMillis
    const evidence: Ownership.LivenessEvidence | undefined = stealing
      ? { expectedOwner: row.owner!, checkedAtMs: now, kind: "cross-host-unreachable-stale" }
      : undefined
    // The store decides staleness from the clock IT reads, never from `now`,
    // so the steal is taken at the skewed moment rather than merely described
    // by it (`@smthrs/run-store` `claimAndOwn`).
    const outcome = yield* Clocks.at(now, runs.claimAndOwn(runId, snapshot, claimant, now, evidence))
    if (outcome._tag !== "Activated") {
      return yield* Effect.die(new Error(`run ${runId} takeover was lost: ${outcome._tag}`))
    }
  })

class ExecuteFailed extends Error {
  override readonly name = "ExecuteFailed"
}

const executor = (options: {
  readonly runId: string
  readonly owner?: Ownership.OwnerId
  readonly execute?: () => Effect.Effect<unknown, unknown>
}) =>
  ActionPersistence.make({
    runId: options.runId,
    owner: options.owner ?? ownerA,
    sourceId: `failure-paths-${options.runId}`,
    execute: options.execute ?? (() => Effect.fail(new ExecuteFailed("action execute failed")))
  })

const input = (key: string, attempt = 1): ActionPersistence.ActionInput => ({
  action: {},
  attempt,
  key,
  tier: "sealed",
  metadata: hardBoundary
})

const journalState = (runId: string) =>
  Effect.gen(function*() {
    const journal = yield* Journal.Journal
    yield* journal.flush
    const entries = yield* journal.entries({ runId: runId as never, limit: 50 })
    return entries.entries.map((entry) => ({ eventType: entry.eventType, payload: entry.payload }))
  })

const settleCause = (runId: string, cause: Cause.Cause<unknown>) => {
  const key = `failure/${runId}`
  return run(Effect.gen(function*() {
    yield* activate(runId, ownerA)
    const exit = yield* executor({ runId, execute: () => Effect.failCause(cause) })(input(key)).pipe(Effect.exit)
    const attempts = yield* AttemptStore.AttemptStore
    const row = yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 })
    return { exit, row }
  }))
}

const settleDefect = (runId: string, defect: unknown) => settleCause(runId, Cause.die(defect))

describe("action executor failure paths", () => {
  it.effect("records a failed finish and journals a failed attempt-finished when execute fails", () =>
    Effect.gen(function*() {
      const key = "failure/execute"
      const result = yield* run(Effect.gen(function*() {
        yield* activate("execute-fails", ownerA)
        const exit = yield* executor({ runId: "execute-fails" })(input(key)).pipe(Effect.exit)
        const attempts = yield* AttemptStore.AttemptStore
        const row = yield* attempts.get({
          runId: "execute-fails",
          stepKeyDigest: sha256(key),
          attempt: 1
        })
        const cache = yield* CacheStore.CacheStore
        const cached = yield* cache.get(sha256(key))
        const events = yield* journalState("execute-fails")
        return { exit, row, cached, events }
      }))

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(
        Exit.isFailure(result.exit) && Cause.squash(result.exit.cause) instanceof ExecuteFailed
      ).toBe(true)
      const row = Option.getOrThrow(result.row)
      expect(row.state).toBe("failed")
      expect(row.finishedAtMs).toBeDefined()
      // A failed action never populates the sealed cache.
      expect(Option.isNone(result.cached)).toBe(true)
      const finished = result.events.filter((event) => event.eventType === "flows.engine.attempt-finished")
      expect(finished).toHaveLength(1)
      expect(finished[0]!.payload).toMatchObject({ state: "failed" })
      // An ordinary execute failure is not a boundary violation.
      expect(result.events.map((event) => event.eventType)).not.toContain("flows.engine.hard-violation")
    }))

  /**
   * A defect JSON cannot express reaches the attempt row as `null`, and the
   * finish still lands.
   *
   * `AttemptStore` admits inert JSON only, so the write side reduces a live
   * failure value before handing it over. Two shapes have no JSON at all: one
   * `JSON.stringify` answers `undefined` for, and one it throws on. Both must
   * settle the attempt rather than fail the finish with an attempt-store
   * refusal, because a refused finish leaves the row `running` and the reclaim
   * machinery reads that as a crash.
   */
  const unserializable: ReadonlyArray<readonly [string, string, () => unknown]> = [
    ["undefined", "die-undefined", () => undefined],
    ["a symbol", "die-symbol", () => Symbol("no JSON form")],
    ["a function", "die-function", () => () => "no JSON form"],
    ["a bigint", "die-bigint", () => 1n],
    ["a cycle", "die-cycle", () => {
      const cyclic: Record<string, unknown> = {}
      cyclic["self"] = cyclic
      return cyclic
    }]
  ]

  for (const [what, runId, defect] of unserializable) {
    it.effect(`settles the attempt when the defect is ${what} JSON cannot express`, () =>
      Effect.gen(function*() {
        const key = `failure/${runId}`
        const result = yield* run(Effect.gen(function*() {
          yield* activate(runId, ownerA)
          const exit = yield* executor({
            runId,
            execute: () => Effect.die(defect())
          })(input(key)).pipe(Effect.exit)
          const attempts = yield* AttemptStore.AttemptStore
          const row = yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 })
          return { exit, row }
        }))

        expect(Exit.isFailure(result.exit)).toBe(true)
        const row = Option.getOrThrow(result.row)
        expect(row.state).toBe("failed")
        expect(row.error).toEqual({ reasons: [{ _tag: "Die", defect: null }] })
      }))
  }

  it.effect("copies JSON leaves without invoking accessors and applies JSON omission rules", () =>
    Effect.gen(function*() {
      getterInvoked = false
      const list: Array<unknown> = [
        undefined,
        Symbol("omitted array symbol"),
        () => "omitted array function",
        1n,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        null,
        true,
        2.5,
        "kept"
      ]
      Object.defineProperty(list, "10", {
        enumerable: true,
        configurable: true,
        get: () => {
          getterInvoked = true
          throw new Error("array getter ran")
        }
      })
      list.length = 12
      const defect = {
        nothing: null,
        yes: true,
        no: false,
        finite: -2.5,
        notANumber: Number.NaN,
        infinite: Number.NEGATIVE_INFINITY,
        text: "kept",
        astral: "😀",
        privateUse: "\ue000",
        list,
        nested: {
          omittedUndefined: undefined,
          omittedSymbol: Symbol("omitted object symbol"),
          omittedFunction: () => "omitted object function",
          omittedBigint: 2n,
          kept: "nested"
        }
      }
      Object.defineProperty(defect, "accessor", {
        enumerable: true,
        get: () => {
          getterInvoked = true
          throw new Error("object getter ran")
        }
      })
      Object.defineProperty(defect, "hidden", { enumerable: false, value: "omitted" })
      Object.defineProperty(defect, Symbol("hidden symbol"), { enumerable: true, value: "omitted" })

      const result = yield* settleDefect("inert-json-leaves", defect)

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(getterInvoked).toBe(false)
      expect(Option.getOrThrow(result.row)).toMatchObject({
        state: "failed",
        error: {
          reasons: [{
            _tag: "Die",
            defect: {
              nothing: null,
              yes: true,
              no: false,
              finite: -2.5,
              notANumber: null,
              infinite: null,
              text: "kept",
              astral: "😀",
              privateUse: "\ue000",
              list: [null, null, null, null, null, null, null, true, 2.5, "kept", null, null],
              nested: { kept: "nested" }
            }
          }]
        }
      })
    }))

  it.effect("does not invoke a throwing message getter while settling a defect", () =>
    Effect.gen(function*() {
      getterInvoked = false
      const defect = { stable: "kept" }
      Object.defineProperty(defect, "message", {
        enumerable: true,
        get: () => {
          getterInvoked = true
          throw new Error("message getter ran")
        }
      })

      const result = yield* settleDefect("getter-defect", defect)

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(getterInvoked).toBe(false)
      expect(Option.getOrThrow(result.row)).toMatchObject({
        state: "failed",
        error: { reasons: [{ _tag: "Die", defect: { stable: "kept" } }] }
      })
    }))

  it.effect("does not invoke toJSON while settling a defect", () =>
    Effect.gen(function*() {
      toJsonInvoked = false
      const defect = {
        stable: "kept",
        toJSON: () => {
          toJsonInvoked = true
          throw new Error("toJSON ran")
        }
      }

      const result = yield* settleDefect("to-json-defect", defect)

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(toJsonInvoked).toBe(false)
      expect(Option.getOrThrow(result.row)).toMatchObject({
        state: "failed",
        error: { reasons: [{ _tag: "Die", defect: { stable: "kept" } }] }
      })
    }))

  it.effect("rejects a proxy without invoking its get trap", () =>
    Effect.gen(function*() {
      proxyGetInvoked = false
      const proxy = new Proxy({ stable: "hidden" }, {
        get: (target, key, receiver) => {
          proxyGetInvoked = true
          return Reflect.get(target, key, receiver)
        }
      })

      const result = yield* settleDefect("proxy-defect", { nested: [proxy] })

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(proxyGetInvoked).toBe(false)
      expect(Option.getOrThrow(result.row)).toMatchObject({
        state: "failed",
        error: { reasons: [{ _tag: "Die", defect: null }] }
      })
    }))

  it.effect("reduces a large array-buffer view without persisting one key per byte", () =>
    Effect.gen(function*() {
      const result = yield* settleDefect("array-buffer-view-defect", {
        bytes: new Uint8Array(1_000_000)
      })

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(Option.getOrThrow(result.row)).toMatchObject({
        state: "failed",
        error: { reasons: [{ _tag: "Die", defect: { bytes: "[ArrayBufferView]" } }] }
      })
    }))

  it.effect("charges every enumerated own key against a bounded walk", () =>
    Effect.gen(function*() {
      const defect: Record<PropertyKey, unknown> = {}
      for (let index = 0; index <= ActionPersistence.maxInertJsonNodes; index++) {
        Object.defineProperty(defect, Symbol(index), { value: index, enumerable: true })
      }

      const result = yield* settleDefect("own-key-budget-defect", defect)

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(Option.getOrThrow(result.row)).toMatchObject({
        state: "failed",
        error: { reasons: [{ _tag: "Die", defect: null }] }
      })
    }))

  it.effect("rejects a defect deeper than the inert JSON depth bound", () =>
    Effect.gen(function*() {
      let defect: unknown = "leaf"
      for (let depth = 0; depth <= ActionPersistence.maxInertJsonDepth; depth++) {
        defect = { nested: defect }
      }

      const result = yield* settleDefect("deep-defect", defect)

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(Option.getOrThrow(result.row)).toMatchObject({
        state: "failed",
        error: { reasons: [{ _tag: "Die", defect: null }] }
      })
    }))

  it.effect("rejects a defect wider than the inert JSON node bound", () =>
    Effect.gen(function*() {
      // Numbers, so the node bound is what this case reaches: a key or string
      // long enough to reach the node count would spend the character budget
      // first and reject for the other reason.
      const defect = new Array(ActionPersistence.maxInertJsonNodes).fill(0)

      const result = yield* settleDefect("wide-defect", defect)

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(Option.getOrThrow(result.row)).toMatchObject({
        state: "failed",
        error: { reasons: [{ _tag: "Die", defect: null }] }
      })
    }))

  it.effect("rejects a defect above the inert JSON character bound", () =>
    Effect.gen(function*() {
      const stringResult = yield* settleDefect(
        "large-string-defect",
        "x".repeat(ActionPersistence.maxInertJsonCharacters + 1)
      )
      const keyedDefect: Record<string, unknown> = {}
      keyedDefect["k".repeat(ActionPersistence.maxInertJsonCharacters + 1)] = "value"
      const keyResult = yield* settleDefect("large-key-defect", keyedDefect)

      for (const result of [stringResult, keyResult]) {
        expect(Exit.isFailure(result.exit)).toBe(true)
        expect(Option.getOrThrow(result.row)).toMatchObject({
          state: "failed",
          error: { reasons: [{ _tag: "Die", defect: null }] }
        })
      }
    }))

  it.effect("spends one character budget across every reason of a cause", () =>
    Effect.gen(function*() {
      // Each half fits on its own; together they do not, so the first reason
      // is persisted whole and the second is the one that reaches the bound.
      const half = "y".repeat(Math.trunc(ActionPersistence.maxInertJsonCharacters * 0.75))
      const result = yield* settleCause(
        "shared-budget-defect",
        Cause.fromReasons([Cause.makeDieReason(half), Cause.makeDieReason(half)])
      )

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(Option.getOrThrow(result.row)).toMatchObject({
        state: "failed",
        error: { reasons: [{ _tag: "Die", defect: half }, { _tag: "Die", defect: null }] }
      })
    }))

  it.effect("collapses an over-budget interrupt cause into a replayable terminal failure", () =>
    Effect.gen(function*() {
      const runId = "interrupt-cause-budget"
      const key = `failure/${runId}`
      const reasonCount = Math.floor(AttemptStore.maximumJsonNodes / 3) + 1
      const cause = Cause.fromReasons(
        Array.from({ length: reasonCount }, (_, fiberId) => Cause.makeInterruptReason(fiberId))
      )
      const result = yield* run(Effect.gen(function*() {
        yield* activate(runId, ownerA)
        const first = yield* executor({ runId, execute: () => Effect.failCause(cause) })(input(key)).pipe(
          Effect.exit
        )
        const attempts = yield* AttemptStore.AttemptStore
        const row = yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 })
        const replayed = Option.isSome(row) && row.value.state === "failed"
          ? yield* executor({ runId, execute: () => Effect.die("replay executed the body") })(input(key)).pipe(
            Effect.exit
          )
          : undefined
        return { first, row, replayed }
      }))

      expect(Exit.isFailure(result.first)).toBe(true)
      expect(Option.getOrThrow(result.row)).toMatchObject({
        state: "failed",
        error: { reasons: [{ _tag: "Die", defect: null }] }
      })
      // The replay is the point of the collapse: the bounded row must rethrow
      // the persisted terminal failure. A replay that succeeded, or one that
      // never ran because the row was not persisted as failed, hands the
      // caller an outcome the attempt never produced, so it is reported here
      // rather than skipped over.
      const replayed = result.replayed
      expect(replayed !== undefined && Exit.isFailure(replayed)).toBe(true)
      if (replayed === undefined || !Exit.isFailure(replayed)) {
        throw new Error("expected the replay to rethrow the persisted terminal failure")
      }
      // The whole collapsed cause, not merely its presence: the bound spends
      // every interrupt reason on the single `Die(null)` it can afford.
      expect(replayed.cause.reasons).toHaveLength(1)
      expect(replayed.cause.reasons).toMatchObject([{ _tag: "Die", defect: null }])
    }))

  /**
   * The bounds exist to keep a failure inside the store's admission, not to
   * shrink what a failure may say. An ordinary error, with the multi-kilobyte
   * message and stack a provider or a parser produces, must reach the row
   * whole: rejecting it would replace the domain error with `null`, and replay
   * would rethrow a defect no `RetryPolicy` tag can match.
   */
  it.effect("persists an ordinary multi-kilobyte message and stack intact", () =>
    Effect.gen(function*() {
      const message = "boundary refused the write: ".repeat(256)
      const stack = "    at frame (file.ts:1:1)\n".repeat(256)
      const defect = { _tag: "ProviderRefused", message, stack, issues: new Array(64).fill("issue") }

      const result = yield* settleDefect("large-but-admissible-defect", defect)

      expect(Exit.isFailure(result.exit)).toBe(true)
      expect(Option.getOrThrow(result.row)).toMatchObject({
        state: "failed",
        error: { reasons: [{ _tag: "Die", defect }] }
      })
    }))

  /**
   * A git or HTTP failure message embeds the remote URL, credentials included.
   * `message` and `stack` are observability text, so the journal's redaction
   * rules run over them on write; the typed `_tag` replay classifies on stays.
   */
  it.effect("redacts credentials in a failure message and stack before the row is written", () =>
    Effect.gen(function*() {
      const token = "ghs_A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
      const remote = `https://x-access-token:${token}@github.com/acme/private.git/`
      const error = {
        _tag: "GitCloneFailed",
        message: `fatal: unable to access '${remote}': 403`,
        stack: `GitCloneFailed: fatal\n    at clone (${remote})`
      }

      const result = yield* settleCause("redacted-failure-text", Cause.fail(error))

      const row = Option.getOrThrow(result.row)
      expect(row.state).toBe("failed")
      expect(JSON.stringify(row.error)).not.toContain(token)
      expect(row.error).toMatchObject({
        reasons: [{
          _tag: "Fail",
          error: {
            _tag: "GitCloneFailed",
            message: "fatal: unable to access 'https://x-access-token:[REDACTED]@github.com/acme/private.git/': 403"
          }
        }]
      })
    }))

  it.effect("rejects ill-formed string values and keys before store admission", () =>
    Effect.gen(function*() {
      const keyedDefect: Record<string, unknown> = {}
      keyedDefect["\ud800"] = "value"
      const results = [
        yield* settleDefect("high-surrogate-defect", "\ud800"),
        yield* settleDefect("invalid-surrogate-pair-defect", "\ud800\ue000"),
        yield* settleDefect("low-surrogate-defect", "\udc00"),
        yield* settleDefect("surrogate-key-defect", keyedDefect)
      ]

      for (const result of results) {
        expect(Exit.isFailure(result.exit)).toBe(true)
        expect(Option.getOrThrow(result.row)).toMatchObject({
          state: "failed",
          error: { reasons: [{ _tag: "Die", defect: null }] }
        })
      }
    }))

  it.effect("settles with null when inert inspection itself refuses", () =>
    Effect.gen(function*() {
      const defect = { stable: "hidden" }
      const originalOwnKeys = Reflect.ownKeys
      Reflect.ownKeys = (target) => {
        if (target === defect) throw new Error("inspection refused")
        return originalOwnKeys(target)
      }
      try {
        const result = yield* settleDefect("inspection-refusal", defect)

        expect(Exit.isFailure(result.exit)).toBe(true)
        expect(Option.getOrThrow(result.row)).toMatchObject({
          state: "failed",
          error: { reasons: [{ _tag: "Die", defect: null }] }
        })
      } finally {
        Reflect.ownKeys = originalOwnKeys
      }
    }))

  it.effect("journals a hard violation and a failed finish when boundary.prepare fails", () =>
    Effect.gen(function*() {
      const key = "failure/prepare"
      const result = yield* run(
        Effect.gen(function*() {
          yield* activate("prepare-fails", ownerA)
          const exit = yield* executor({
            runId: "prepare-fails",
            execute: () => Effect.succeed("never dispatched? no: prepare fails first")
          })(input(key)).pipe(Effect.exit)
          const attempts = yield* AttemptStore.AttemptStore
          const row = yield* attempts.get({
            runId: "prepare-fails",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          const events = yield* journalState("prepare-fails")
          return { exit, row, events }
        }),
        StepBoundary.layerTest({ supported: false })
      )

      const failure = Exit.isFailure(result.exit)
        ? Cause.squash(result.exit.cause) as { readonly _tag?: string }
        : {}
      expect(failure._tag).toBe("@smthrs/engine-store/UnsupportedBoundary")
      expect(Option.getOrThrow(result.row).state).toBe("failed")
      const eventTypes = result.events.map((event) => event.eventType)
      expect(eventTypes).toContain("flows.engine.hard-violation")
      const finished = result.events.filter((event) => event.eventType === "flows.engine.attempt-finished")
      expect(finished).toHaveLength(1)
      expect(finished[0]!.payload).toMatchObject({ state: "failed" })
    }))

  it.effect("settles the attempt when the injected sandbox refuses to open", () =>
    Effect.gen(function*() {
      // `StepSandbox.layerNoop` is the browser story: a host that cannot build
      // the forest refuses typed. The refusal must settle the attempt exactly
      // like a prepare failure — a row left "running" would read as a crash to
      // the reclaim machinery instead of a refusal.
      const key = "failure/sandbox-open"
      const result = yield* run(
        Effect.gen(function*() {
          yield* activate("sandbox-open-fails", ownerA)
          const exit = yield* executor({
            runId: "sandbox-open-fails",
            execute: () => Effect.succeed("never dispatched: open refuses first")
          })(input(key)).pipe(Effect.exit)
          const attempts = yield* AttemptStore.AttemptStore
          const row = yield* attempts.get({
            runId: "sandbox-open-fails",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          const events = yield* journalState("sandbox-open-fails")
          return { exit, row, events }
        }),
        Layer.mergeAll(StepBoundary.layerTest(), StepSandbox.layerNoop)
      )

      const failure = Exit.isFailure(result.exit)
        ? Cause.squash(result.exit.cause) as { readonly _tag?: string }
        : {}
      expect(failure._tag).toBe("@smthrs/engine-store/UnsupportedBoundary")
      expect(Option.getOrThrow(result.row).state).toBe("failed")
      const eventTypes = result.events.map((event) => event.eventType)
      expect(eventTypes).toContain("flows.engine.hard-violation")
      const finished = result.events.filter((event) => event.eventType === "flows.engine.attempt-finished")
      expect(finished).toHaveLength(1)
      expect(finished[0]!.payload).toMatchObject({ state: "failed" })
    }))

  it.effect("journals a hard violation and a failed finish when boundary.settle rejects an undeclared write", () =>
    Effect.gen(function*() {
      const key = "failure/settle"
      const result = yield* run(
        Effect.gen(function*() {
          yield* activate("settle-fails", ownerA)
          const exit = yield* executor({
            runId: "settle-fails",
            execute: () => Effect.succeed("value")
          })(input(key)).pipe(Effect.exit)
          const attempts = yield* AttemptStore.AttemptStore
          const row = yield* attempts.get({
            runId: "settle-fails",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          const cache = yield* CacheStore.CacheStore
          const cached = yield* cache.get(sha256(key))
          const events = yield* journalState("settle-fails")
          return { exit, row, cached, events }
        }),
        StepBoundary.layerTest({
          failure: new StepBoundary.UndeclaredWrite({
            code: "undeclared_write",
            paths: ["undeclared.txt"],
            diffIdentity: "test-diff"
          })
        })
      )

      const failure = Exit.isFailure(result.exit)
        ? Cause.squash(result.exit.cause) as { readonly _tag?: string }
        : {}
      expect(failure._tag).toBe("@smthrs/engine-store/UndeclaredWrite")
      expect(Option.getOrThrow(result.row).state).toBe("failed")
      expect(Option.isNone(result.cached)).toBe(true)
      const eventTypes = result.events.map((event) => event.eventType)
      expect(eventTypes).toContain("flows.engine.hard-violation")
      const finished = result.events.filter((event) => event.eventType === "flows.engine.attempt-finished")
      expect(finished).toHaveLength(1)
      expect(finished[0]!.payload).toMatchObject({ state: "failed" })
    }))

  /**
   * Preparation, sandbox open, and settlement are the three places a sealed
   * attempt's boundary can refuse it, and all three are one durable
   * transition: a failed row marked `hardViolation`, which is all the failed
   * replay branch re-emits the violation from, then the hard-violation record
   * and the failed finish. Under a lost fence none of it lands.
   */
  const boundaryRefusals = [
    {
      phase: "prepare",
      boundary: () => StepBoundary.layerTest({ supported: false }),
      refusal: "@smthrs/engine-store/UnsupportedBoundary"
    },
    {
      phase: "sandbox-open",
      boundary: () => Layer.mergeAll(StepBoundary.layerTest(), StepSandbox.layerNoop),
      refusal: "@smthrs/engine-store/UnsupportedBoundary"
    },
    {
      phase: "settle",
      boundary: () =>
        StepBoundary.layerTest({
          failure: new StepBoundary.UndeclaredWrite({
            code: "undeclared_write",
            paths: ["undeclared.txt"],
            diffIdentity: "test-diff"
          })
        }),
      refusal: "@smthrs/engine-store/UndeclaredWrite"
    }
  ] as const

  for (const { boundary, phase, refusal } of boundaryRefusals) {
    const refuse = (runId: string, fenceLost: boolean) =>
      run(
        Effect.gen(function*() {
          yield* activate(runId, ownerA)
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const steal: Notifying.Hook = (op, order, args) =>
            fenceLost && op === "finish" && order === "before" &&
              (args[0] as { readonly state: string }).state === "failed"
              ? takeover(runs, runId, ownerB).pipe(Effect.orDie)
              : Effect.void
          const key = `failure/${runId}`
          const exit = yield* executor({ runId, execute: () => Effect.succeed("value") })(input(key)).pipe(
            Effect.provideService(AttemptStore.AttemptStore, Notifying.wrap(attempts, steal)),
            Effect.forkChild({ startImmediately: true }),
            Effect.flatMap(Fiber.await)
          )
          const row = yield* attempts.get({ runId, stepKeyDigest: sha256(key), attempt: 1 })
          const events = yield* journalState(runId)
          return { exit, row: Option.getOrThrow(row), events }
        }),
        boundary()
      )

    it.effect(`settles a ${phase} refusal as a failed hard-violation attempt and rethrows it`, () =>
      Effect.gen(function*() {
        const { events, exit, row } = yield* refuse(`${phase}-refused`, false)

        const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) as { readonly _tag?: string } : {}
        expect(failure._tag).toBe(refusal)
        expect(row.state).toBe("failed")
        expect(row.meta).toEqual({ tier: "sealed", hardViolation: true })
        expect(row.error).toMatchObject({ reasons: [{ _tag: "Fail", error: { _tag: refusal } }] })
        const eventTypes = events.map((event) => event.eventType)
        expect(eventTypes.filter((type) => type === "flows.engine.hard-violation")).toHaveLength(1)
        expect(eventTypes.filter((type) => type === "flows.engine.attempt-finished")).toHaveLength(1)
        expect(events.slice(-2)).toMatchObject([
          { eventType: "flows.engine.hard-violation" },
          { eventType: "flows.engine.attempt-finished", payload: { state: "failed" } }
        ])
      }))

    it.effect(`discards a ${phase} refusal's settlement when the fence is lost`, () =>
      Effect.gen(function*() {
        const { events, exit, row } = yield* refuse(`${phase}-fenced`, true)

        expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
        expect(row.state).toBe("running")
        const eventTypes = events.map((event) => event.eventType)
        expect(eventTypes).not.toContain("flows.engine.hard-violation")
        expect(eventTypes).not.toContain("flows.engine.attempt-finished")
      }))
  }

  it.effect("fails with AttemptSuspended when the durable attempt row is suspended", () =>
    Effect.gen(function*() {
      const key = "failure/suspended"
      const result = yield* run(Effect.gen(function*() {
        yield* activate("suspended-row", ownerA)
        const attempts = yield* AttemptStore.AttemptStore
        const now = yield* Clock.currentTimeMillis
        const seeded = yield* attempts.put({
          runId: "suspended-row",
          stepKeyDigest: sha256(key),
          attempt: 1,
          state: "suspended",
          startedAtMs: now,
          meta: { tier: "sealed" }
        }, ownerA)
        const exit = yield* executor({ runId: "suspended-row" })(input(key)).pipe(Effect.exit)
        return { seeded, exit }
      }))

      expect(result.seeded._tag).toBe("Inserted")
      const failure = Exit.isFailure(result.exit)
        ? Cause.squash(result.exit.cause) as { readonly _tag?: string }
        : {}
      expect(failure._tag).toBe("@smthrs/engine-store/AttemptSuspended")
    }))

  it.effect("fence lost while finishing a FAILED attempt: the finish is discarded and no failed lifecycle record leaks", () =>
    Effect.gen(function*() {
      const key = "failure/fence-failed-finish"
      const result = yield* run(Effect.gen(function*() {
        yield* activate("fence-failed-finish", ownerA)
        const runs = yield* RunStore.RunStore
        const attempts = yield* AttemptStore.AttemptStore
        const failedFinish = (args: ReadonlyArray<unknown>): boolean =>
          (args[0] as { readonly state: string }).state === "failed"
        const steal: Notifying.Hook = (op, order, args) =>
          op === "finish" && order === "before" && failedFinish(args)
            ? takeover(runs, "fence-failed-finish", ownerB).pipe(Effect.orDie)
            : Effect.void

        const fencedOut = executor({ runId: "fence-failed-finish" })
        const exit = yield* fencedOut(input(key)).pipe(
          Effect.provideService(AttemptStore.AttemptStore, Notifying.wrap(attempts, steal)),
          Effect.forkChild({ startImmediately: true }),
          Effect.flatMap(Fiber.await)
        )
        const row = yield* attempts.get({
          runId: "fence-failed-finish",
          stepKeyDigest: sha256(key),
          attempt: 1
        })
        const events = yield* journalState("fence-failed-finish")
        return { exit, row, events }
      }))

      // The fenced owner self-interrupts instead of surfacing the action
      // failure under a lost fence.
      expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
      // The failed finish never seals under the lost fence.
      expect(Option.getOrThrow(result.row).state).toBe("running")
      const eventTypes = result.events.map((event) => event.eventType)
      expect(eventTypes).not.toContain("flows.engine.attempt-finished")
      expect(eventTypes).not.toContain("flows.engine.hard-violation")
    }))

  it.effect("fence lost while settling a refused sandbox open: the finish is discarded", () =>
    Effect.gen(function*() {
      // The same fence discipline as every other settle path, on the
      // sandbox-open refusal branch: a steal between the refusal and the finish
      // self-interrupts instead of sealing under the lost fence.
      const key = "failure/fence-sandbox-open"
      const result = yield* run(
        Effect.gen(function*() {
          yield* activate("fence-sandbox-open", ownerA)
          const runs = yield* RunStore.RunStore
          const attempts = yield* AttemptStore.AttemptStore
          const failedFinish = (args: ReadonlyArray<unknown>): boolean =>
            (args[0] as { readonly state: string }).state === "failed"
          const steal: Notifying.Hook = (op, order, args) =>
            op === "finish" && order === "before" && failedFinish(args)
              ? takeover(runs, "fence-sandbox-open", ownerB).pipe(Effect.orDie)
              : Effect.void

          const fencedOut = executor({
            runId: "fence-sandbox-open",
            execute: () => Effect.succeed("never dispatched: open refuses first")
          })
          const exit = yield* fencedOut(input(key)).pipe(
            Effect.provideService(AttemptStore.AttemptStore, Notifying.wrap(attempts, steal)),
            Effect.forkChild({ startImmediately: true }),
            Effect.flatMap(Fiber.await)
          )
          const row = yield* attempts.get({
            runId: "fence-sandbox-open",
            stepKeyDigest: sha256(key),
            attempt: 1
          })
          const events = yield* journalState("fence-sandbox-open")
          return { exit, row, events }
        }),
        Layer.mergeAll(StepBoundary.layerTest(), StepSandbox.layerNoop)
      )

      expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
      expect(Option.getOrThrow(result.row).state).toBe("running")
      expect(result.events.map((event) => event.eventType)).not.toContain("flows.engine.attempt-finished")
    }))

  it.effect("preserves materialization conflict classification through durable failure replay", () =>
    run(Effect.gen(function*() {
      yield* activate("conflict-replay", ownerA)
      let calls = 0
      const execute = executor({
        runId: "conflict-replay",
        execute: () =>
          Effect.suspend(() => {
            calls++
            return Effect.fail(
              new WorkspaceSandbox.MaterializationConflict({ paths: ["shared.out"], message: "a competing landing" })
            )
          })
      })
      const first = yield* execute(input("conflict/replay")).pipe(Effect.exit)
      const replay = yield* executor({ runId: "conflict-replay", execute: () => Effect.die("must not run") })(
        input("conflict/replay")
      )
        .pipe(Effect.exit)
      for (const exit of [first, replay]) {
        expect(Exit.isFailure(exit)).toBe(true)
        const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
        expect(WorkspaceSandbox.isMaterializationConflict(error)).toBe(true)
        expect(error).toMatchObject({ paths: ["shared.out"], message: "a competing landing" })
      }
      expect(calls).toBe(1)
    })))

  it.effect("persists the failing cause as explicit tagged-reason JSON, independent of the store's serializer", () =>
    Effect.gen(function*() {
      // The write side owns the durable shape: `Fail`, `Die`, and `Interrupt`
      // reasons (with and without a fiber id) all round-trip as `{reasons}` so
      // failed-attempt replay (issue #59) cannot be broken by a change in how
      // the attempt store serializes opaque values.
      const cause = Cause.fromReasons([
        Cause.makeFailReason("boom"),
        Cause.makeDieReason("defective"),
        Cause.makeInterruptReason(5),
        Cause.makeInterruptReason(undefined)
      ])
      const result = yield* run(Effect.gen(function*() {
        yield* activate("tagged-cause", ownerA)
        const attempts = yield* AttemptStore.AttemptStore
        const exit = yield* executor({
          runId: "tagged-cause",
          execute: () => Effect.failCause(cause)
        })(input("cause/tagged")).pipe(Effect.exit)
        const row = yield* attempts.get({
          runId: "tagged-cause",
          stepKeyDigest: sha256("cause/tagged"),
          attempt: 1
        })
        return { exit, row }
      }))

      expect(Exit.isFailure(result.exit)).toBe(true)
      const persisted = Option.getOrThrow(result.row).error as {
        readonly reasons: ReadonlyArray<Record<string, unknown>>
      }
      expect(persisted.reasons).toEqual([
        { _tag: "Fail", error: "boom" },
        { _tag: "Die", defect: "defective" },
        { _tag: "Interrupt", fiberId: 5 },
        { _tag: "Interrupt", fiberId: null }
      ])
    }))
})
