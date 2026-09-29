import type * as Crypto from "effect/Crypto"
/**
 * Issue #73: invocation keys must not depend on fiber scheduling order.
 *
 * Compensable, irreversible, and unsealed actions are keyed by
 * `(runId, ordinal, tier)`, and the ordinal used to come from one per-run
 * counter bumped in the order fibers happened to reach `actionExecute`.
 * Nothing serializes that order — a flow body may run actions under
 * `Effect.all({ concurrency: "unbounded" })`, and on replay a recorded
 * action resolves from the journal near-instantly while an unrecorded one
 * runs live — so a permuted interleaving aliased one action onto another's
 * recorded attempt rows, checkpoint, and outcome.
 *
 * The two drives below dispatch the same pair of actions in opposite
 * orders, which is exactly what a permuted interleaving produces. Each
 * action must keep its own identity across both.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, FlowRuntime, StepIdentity } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Context, Deferred, Effect, Exit, Layer, Schema } from "effect"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"
import { effect } from "./Harness.ts"
import { scriptedEngine as noOpEngine } from "./ScriptedEngine.ts"

const flow = Flow.make("InvocationKeyStability/flow", {
  payload: { id: Schema.String },
  success: Schema.Void,
  body: () => Node.succeed(undefined)
})

const chargeCard = Action.make({
  name: "InvocationKeyStability/chargeCard",
  tier: "irreversible",
  success: Schema.Void,
  execute: Effect.void
})

const sendEmail = Action.make({
  name: "InvocationKeyStability/sendEmail",
  tier: "irreversible",
  success: Schema.Void,
  execute: Effect.void
})

const repeatedCharge = Action.make({
  name: "InvocationKeyStability/repeated",
  tier: "irreversible",
  success: Schema.Void,
  execute: Effect.void
})

/** Captures the step key the engine allocates for each dispatch. */
const scriptedEngine = (keys: Array<{ readonly name: string; readonly key: string }>) =>
  noOpEngine({
    actionExecute: (input) =>
      Effect.sync(() => {
        keys.push({ name: input.action.name, key: input.key })
        return new Flow.Complete({ exit: Exit.void })
      })
  })

/** One drive of a run: dispatches `actions` in the given order. */
const drive = (
  executionId: string,
  actions: ReadonlyArray<Action.Action>
): Effect.Effect<ReadonlyArray<{ readonly name: string; readonly key: string }>, never, Crypto.Crypto> => {
  const keys: Array<{ readonly name: string; readonly key: string }> = []
  return Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    for (const action of actions) {
      yield* engine.actionExecute(action, 1)
    }
  }).pipe(
    Effect.as(keys as ReadonlyArray<{ readonly name: string; readonly key: string }>),
    Effect.provideService(
      FlowRuntime.FlowInstance,
      FlowEngine.makeInstance(flow, executionId)
    ),
    Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(scriptedEngine(keys)))
  )
}

const keyOf = (
  entries: ReadonlyArray<{ readonly name: string; readonly key: string }>,
  name: string
) => entries.filter((entry) => entry.name === name).map((entry) => entry.key)

describe("invocation key stability under permuted scheduling (issue #73)", () => {
  effect("keeps each action's key when a replay dispatches the pair in the opposite order", () => {
    return Effect.gen(function*() {
      const first = yield* drive("ordinal-stability-run", [chargeCard, sendEmail])
      const replay = yield* drive("ordinal-stability-run", [sendEmail, chargeCard])

      expect(keyOf(first, chargeCard.name)).toEqual(keyOf(replay, chargeCard.name))
      expect(keyOf(first, sendEmail.name)).toEqual(keyOf(replay, sendEmail.name))
      // Distinct actions still never share an identity.
      expect(keyOf(first, chargeCard.name)).not.toEqual(keyOf(first, sendEmail.name))
    })
  })

  effect("still separates repeated invocations of one action within a run", () => {
    return Effect.gen(function*() {
      const entries = yield* drive("ordinal-repeat-run", [
        repeatedCharge,
        repeatedCharge,
        repeatedCharge
      ])
      const keys = keyOf(entries, repeatedCharge.name)
      expect(keys).toHaveLength(3)
      expect(new Set(keys).size).toBe(3)
    })
  })

  effect("keeps repeated invocations aligned across a replay of the same sequence", () => {
    return Effect.gen(function*() {
      const first = yield* drive("ordinal-repeat-replay", [repeatedCharge, chargeCard, repeatedCharge])
      // The replay reaches `chargeCard` last; the two `repeated` dispatches
      // keep their first and second identities regardless.
      const replay = yield* drive("ordinal-repeat-replay", [repeatedCharge, repeatedCharge, chargeCard])
      expect(keyOf(first, repeatedCharge.name)).toEqual(keyOf(replay, repeatedCharge.name))
      expect(keyOf(first, chargeCard.name)).toEqual(keyOf(replay, chargeCard.name))
    })
  })
})

/** One drive of a run executing an arbitrary program against the engine. */
const driveProgram = (
  executionId: string,
  program: (
    engine: FlowRuntime.FlowRuntime["Service"]
  ) => Effect.Effect<unknown, unknown, FlowRuntime.FlowInstance | FlowRuntime.FlowRuntime | Crypto.Crypto>
): Effect.Effect<ReadonlyArray<{ readonly name: string; readonly key: string }>, unknown, Crypto.Crypto> => {
  const keys: Array<{ readonly name: string; readonly key: string }> = []
  const engine = scriptedEngine(keys)
  return Effect.gen(function*() {
    yield* program(engine)
  }).pipe(
    Effect.as(keys as ReadonlyArray<{ readonly name: string; readonly key: string }>),
    Effect.provideService(
      FlowRuntime.FlowInstance,
      FlowEngine.makeInstance(flow, executionId)
    ),
    Effect.provide(Layer.succeed(FlowRuntime.FlowRuntime)(engine))
  )
}

describe("ordinal slots inside Action.retry (issue #84)", () => {
  effect("a differently-named action in one retry block keeps its own name-scoped identity", () => {
    // `Action.retry(gen { yield* A; yield* B })` followed by a plain
    // `yield* B`: the in-block B must consume `action:B`'s counter, not
    // inherit A's slot value, or the later independent B collides with it.
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-slot-run", (engine) =>
        Effect.gen(function*() {
          yield* Action.retry(
            Effect.gen(function*() {
              yield* engine.actionExecute(chargeCard, 1)
              yield* engine.actionExecute(sendEmail, 1)
            }),
            { times: 0 }
          )
          yield* engine.actionExecute(sendEmail, 1)
        }))
      const emailKeys = keyOf(entries, sendEmail.name)
      expect(emailKeys).toHaveLength(2)
      expect(new Set(emailKeys).size).toBe(2)
      // And no key is shared across differently-named actions either.
      expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length)
    })
  })

  effect("each action inside a retry block keeps a stable ordinal across attempts", () => {
    // The per-name slot map must still pin each action of the block to one
    // ordinal for the whole retry sequence.
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-slot-retry-run", (engine) => {
        let attempt = 0
        return Action.retry(
          Effect.gen(function*() {
            yield* engine.actionExecute(chargeCard, 1)
            yield* engine.actionExecute(sendEmail, 1)
            attempt++
            if (attempt < 3) return yield* Effect.fail("again")
          }),
          { times: 5 }
        )
      })
      expect(keyOf(entries, chargeCard.name)).toHaveLength(3)
      expect(new Set(keyOf(entries, chargeCard.name)).size).toBe(1)
      expect(keyOf(entries, sendEmail.name)).toHaveLength(3)
      expect(new Set(keyOf(entries, sendEmail.name)).size).toBe(1)
      expect(keyOf(entries, chargeCard.name)[0]).not.toEqual(keyOf(entries, sendEmail.name)[0])
    })
  })
})

describe("nested Action.retry keeps inner pins across outer attempts (issue #108)", () => {
  effect("an inner block's completed dispatch keeps its key when the outer block replays", () => {
    // `outer retry { inner retry { charge }; flakyStep }`: outer attempt 1
    // charges under ordinal N and fails later; outer attempt 2 re-enters the
    // inner block. A per-invocation inner slot was rebuilt from scratch on
    // every outer attempt, so the completed charge drew a brand-new ordinal —
    // a new step key — and re-executed as a fresh attempt-1 step instead of
    // replaying (the #84/#100 stability contract, broken one nesting level
    // down).
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-nested-retry", (engine) => {
        let outerAttempt = 0
        return Action.retry(
          Effect.gen(function*() {
            yield* Action.retry(
              engine.actionExecute(chargeCard, 1),
              { times: 0 }
            )
            outerAttempt++
            if (outerAttempt < 3) return yield* Effect.fail("flaky")
          }),
          { times: 5 }
        )
      })
      const keys = keyOf(entries, chargeCard.name)
      expect(keys).toHaveLength(3)
      expect(new Set(keys).size).toBe(1)
    })
  })

  effect("inner retries still rewind their own dispatch cursors from the block entry", () => {
    // The inner block's attempts must replay the inner dispatches by position
    // from the *block entry*, not from the outer attempt's start — while a
    // sibling dispatch of the same declaration before the block keeps its own
    // pinned identity.
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-nested-cursor", (engine) => {
        let innerAttempt = 0
        return Action.retry(
          Effect.gen(function*() {
            yield* engine.actionExecute(repeatedCharge, 1)
            yield* Action.retry(
              Effect.gen(function*() {
                yield* engine.actionExecute(repeatedCharge, 1)
                innerAttempt++
                if (innerAttempt < 2) return yield* Effect.fail("again")
              }),
              { times: 5 }
            )
          }),
          { times: 0 }
        )
      })
      const keys = keyOf(entries, repeatedCharge.name)
      // pre-block dispatch, then inner attempt 1 and inner attempt 2 of the
      // same in-block identity.
      expect(keys).toHaveLength(3)
      expect(keys[1]).toBe(keys[2])
      expect(keys[0]).not.toBe(keys[1])
    })
  })
  effect("an inner block that leaves a copied scope untouched does not move the outer cursor", () => {
    // The inner block's private cursor view copies the outer cursor for the
    // scope dispatched before it; since the block never dispatches that
    // scope, its exit propagation is a no-op and the outer block's later
    // dispatch still takes the next position, not a replayed one.
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-nested-untouched", (engine) =>
        Action.retry(
          Effect.gen(function*() {
            yield* engine.actionExecute(repeatedCharge, 1)
            yield* Action.retry(Effect.void, { times: 0 })
            yield* engine.actionExecute(repeatedCharge, 1)
          }),
          { times: 0 }
        ))
      const keys = keyOf(entries, repeatedCharge.name)
      expect(keys).toHaveLength(2)
      expect(new Set(keys).size).toBe(2)
    })
  })
})

describe("concurrent sibling retry blocks inside one outer block (issue #116)", () => {
  // Keyed overlap of one declaration is sanctioned (issue #111), so two
  // sibling `Action.retry` blocks may run concurrently inside one outer
  // block. Sharing one mutable cursor map made a sibling's attempt boundary
  // clear *every* scope's dispatch cursor: the victim's next dispatch then
  // re-consumed its first pinned ordinal — a duplicate step key silently
  // replaying another dispatch's recorded outcome.
  const keyed = (idempotencyKey: string) =>
    Action.make({
      name: "InvocationKeyStability/sibling",
      tier: "irreversible",
      idempotencyKey,
      success: Schema.Void,
      execute: Effect.void
    })
  const siblingA = keyed("sibling-a")
  const siblingB = keyed("sibling-b")

  effect("a sibling's retry boundary never rewinds another block's mid-flight cursor", () => {
    return Effect.gen(function*() {
      const bFirstDone = yield* Deferred.make<void>()
      const aRetried = yield* Deferred.make<void>()
      const entries = yield* driveProgram("ordinal-concurrent-siblings", (engine) =>
        Action.retry(
          Effect.all([
            Action.retry(
              Effect.gen(function*() {
                const attempt = yield* Action.CurrentAttempt
                yield* engine.actionExecute(siblingA, 1)
                if (attempt === 1) {
                  // Fail only after B's first dispatch is recorded, so A's
                  // attempt boundary fires while B is mid-flight between its
                  // two dispatches.
                  yield* Deferred.await(bFirstDone)
                  return yield* Effect.fail("boom")
                }
                yield* Deferred.done(aRetried, Exit.void)
              }),
              { times: 5 }
            ),
            Action.retry(
              Effect.gen(function*() {
                yield* engine.actionExecute(siblingB, 1)
                yield* Deferred.done(bFirstDone, Exit.void)
                yield* Deferred.await(aRetried)
                yield* engine.actionExecute(siblingB, 1)
              }),
              { times: 0 }
            )
          ], { concurrency: 2 }),
          { times: 0 }
        ))
      // Deterministic interleaving under the latches: A attempt 1, B first
      // dispatch, A attempt 2, B second dispatch.
      expect(entries).toHaveLength(4)
      const [a1, b1, a2, b2] = entries.map((entry) => entry.key)
      // A's own replay still pins its dispatch across attempts (issue #108).
      expect(a2).toBe(a1)
      // B's second dispatch owns its own second ordinal: A's boundary must
      // not have rewound B's cursor onto B's first pinned ordinal.
      expect(b2).not.toBe(b1)
      // And no cross-sibling collision either.
      expect(new Set([a1, b1, b2]).size).toBe(3)
    })
  })
})

describe("same-name invocation identity (issue #85)", () => {
  const notify = (idempotencyKey: string) =>
    Action.make({
      name: "InvocationKeyStability/notify",
      tier: "irreversible",
      idempotencyKey,
      success: Schema.Void,
      execute: Effect.void
    })
  const notifyA = notify("user-a")
  const notifyB = notify("user-b")

  effect("a declared idempotencyKey pins each invocation's key under swapped arrival order", () => {
    // Two concurrent invocations of one action name with distinguishable
    // inputs must not swap recorded outcomes when a replay reverses arrival
    // order: the declared identity, not the fiber schedule, owns the key.
    return Effect.gen(function*() {
      const first = yield* drive("ordinal-same-name-run", [notifyA, notifyB])
      const replay = yield* drive("ordinal-same-name-run", [notifyB, notifyA])
      const byOrder = (entries: ReadonlyArray<{ readonly key: string }>) => entries.map((entry) => entry.key)
      const [keyA1, keyB1] = byOrder(first)
      const [keyB2, keyA2] = byOrder(replay)
      expect(keyA1).toBe(keyA2)
      expect(keyB1).toBe(keyB2)
      expect(keyA1).not.toBe(keyB1)
    })
  })

  effect("repeated invocations of one declared identity stay separated within a run", () => {
    return Effect.gen(function*() {
      const entries = yield* drive("ordinal-same-key-repeat-run", [notifyA, notifyA])
      const keys = entries.map((entry) => entry.key)
      expect(keys).toHaveLength(2)
      expect(new Set(keys).size).toBe(2)
    })
  })

  const notifyContent = (user: string) =>
    Action.make({
      name: "InvocationKeyStability/notifyContent",
      tier: "irreversible",
      idempotencyKey: { user },
      success: Schema.Void,
      execute: Effect.void
    })
  const notifyContentA = notifyContent("user-a")
  const notifyContentB = notifyContent("user-b")

  effect("an object-form idempotencyKey pins each invocation's key under swapped arrival order (issue #101)", () => {
    // The idempotency component is a union: an object must
    // refine the allocation scope exactly as a string does. Refining only
    // the string form left object-keyed actions on the name-only counter,
    // so a replay with reversed fiber arrival swapped their ordinals — and
    // with them the recorded attempt rows and outcomes.
    return Effect.gen(function*() {
      const first = yield* drive("ordinal-object-key-run", [notifyContentA, notifyContentB])
      const replay = yield* drive("ordinal-object-key-run", [notifyContentB, notifyContentA])
      const [keyA1, keyB1] = first.map((entry) => entry.key)
      const [keyB2, keyA2] = replay.map((entry) => entry.key)
      expect(keyA1).toBe(keyA2)
      expect(keyB1).toBe(keyB2)
      expect(keyA1).not.toBe(keyB1)
    })
  })
})

describe("same identity dispatched twice inside Action.retry (issue #100)", () => {
  effect("each dispatch of one declaration in a retry block owns its own key", () => {
    // `Action.retry(gen { yield* charge; yield* charge })`: a single-valued
    // slot handed the first dispatch's ordinal to the second, so under a
    // durable engine the second charge silently replayed the first's
    // recorded outcome instead of executing.
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-same-identity-block", (engine) =>
        Action.retry(
          Effect.gen(function*() {
            yield* engine.actionExecute(repeatedCharge, 1)
            yield* engine.actionExecute(repeatedCharge, 1)
          }),
          { times: 0 }
        ))
      const keys = keyOf(entries, repeatedCharge.name)
      expect(keys).toHaveLength(2)
      expect(new Set(keys).size).toBe(2)
    })
  })

  effect("both dispatches keep their identities across every attempt of the sequence", () => {
    return Effect.gen(function*() {
      const entries = yield* driveProgram("ordinal-same-identity-retry", (engine) => {
        let attempt = 0
        return Action.retry(
          Effect.gen(function*() {
            yield* engine.actionExecute(repeatedCharge, 1)
            yield* engine.actionExecute(repeatedCharge, 1)
            attempt++
            if (attempt < 3) return yield* Effect.fail("again")
          }),
          { times: 5 }
        )
      })
      const keys = keyOf(entries, repeatedCharge.name)
      expect(keys).toHaveLength(6)
      // Attempt n dispatches the same (first, second) pair of identities.
      expect(new Set(keys).size).toBe(2)
      expect(keys[0]).not.toBe(keys[1])
      expect(keys.slice(2)).toEqual([keys[0], keys[1], keys[0], keys[1]])
    })
  })
})

describe("idempotency form refines the allocation scope (StepIdentity.ts:88-89)", () => {
  effect("a string key and a caller object that spells it derive distinct scopes", () => {
    // The scope claims that "both idempotency forms canonicalize under
    // distinct one-character tags so a string can never alias the object
    // identity whose digest it happens to spell". Nothing asserted it. The
    // persisted key had the same gap and did alias there (B3).
    const name = "InvocationKeyStability/charge"
    const base = `action/${name.length}:${name}`
    return Effect.gen(function*() {
      const declared = yield* StepIdentity.allocationScope({
        kind: "action",
        name,
        idempotency: "order-7"
      })
      const callerOwned = yield* StepIdentity.allocationScope({
        kind: "action",
        name,
        idempotency: { action: name, idempotencyKey: "order-7" }
      })

      expect(declared).not.toBe(callerOwned)
      // Same base, so the tag is the only thing keeping the digest bodies
      // from being free to coincide.
      expect(declared.startsWith(`${base}/s:`)).toBe(true)
      expect(callerOwned.startsWith(`${base}/c:`)).toBe(true)
    })
  })
})

class Unprovided extends Context.Service<Unprovided, { readonly value: string }>()(
  "test/flows-engine/InvocationKeyStability/Unprovided"
) {}

/** Never called; tsc checks it (#2704). */
const unprovidedServiceProbe = () => {
  // @ts-expect-error driveProgram provides only the flow instance and runtime, not Unprovided
  driveProgram("probe", () => Effect.map(Unprovided, (service) => service.value))
  driveProgram("probe", (engine) => engine.actionExecute(chargeCard, 1))
}

describe("regression: provide-then-cast test helpers erase layer requirements (#2704)", () => {
  it("rejects a body that needs a service its layer does not provide", () => {
    // The assertion is the `@ts-expect-error` directive above.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})
