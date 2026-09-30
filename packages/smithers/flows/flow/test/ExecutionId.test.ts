// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, it } from "@effect/vitest"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { effect } from "./Harness.ts"
import { layerWired } from "./MemoryFlowRuntime.ts"

const Echo = Action.make("ExecutionId/echo", {
  payload: { value: Schema.String },
  success: Schema.String
})

const Idempotent = Flow.make("ExecutionId/Idempotent", {
  payload: { value: Schema.String },
  success: Schema.String,
  idempotencyKey: ({ value }) => `key:${value}`,
  body: ({ value }) => Echo.call({ value })
})

const IdempotentLayer = layerWired(
  Layer.mergeAll(
    Echo.toLayer(({ value }) => Effect.succeed(value)),
    Interpreter.layer(Idempotent)
  )
)

/** A flow that declares no key: identity comes from the ambient source. */
const Anonymous = Flow.make("ExecutionId/Anonymous", {
  payload: { value: Schema.String },
  success: Schema.String,
  body: ({ value }) => Echo.call({ value })
})

/** The same declaration under another tag, to prove the tag is derived on. */
const Twin = Flow.make("ExecutionId/Twin", {
  payload: { value: Schema.String },
  success: Schema.String,
  body: ({ value }) => Echo.call({ value })
})

const AnonymousLayer = layerWired(
  Layer.mergeAll(
    Echo.toLayer(({ value }) => Effect.succeed(value)),
    Interpreter.layer(Anonymous)
  )
)

/** A host source that answers every flow with one id. */
const fixed = (executionId: string) => Flow.layerExecutionIds({ mint: () => Effect.succeed(executionId) })

const keyedFlow = (tag: string, key: string) =>
  Flow.make(tag, {
    payload: {},
    success: Schema.String,
    idempotencyKey: () => key,
    body: () => Echo.call({ value: "unused" })
  })

const ambientFlow = (tag: string) =>
  Flow.make(tag, {
    payload: { value: Schema.String },
    success: Schema.String,
    body: ({ value }) => Echo.call({ value })
  })

describe("Flow execution identities", () => {
  effect("an explicit execution id wins over the idempotency key", () =>
    Effect.gen(function*() {
      const executionId = yield* Idempotent.execute(
        { value: "same" },
        { discard: true, executionId: "caller-selected" }
      )
      expect(executionId).toBe("caller-selected")
    }).pipe(Effect.provide(IdempotentLayer)))

  effect("derives a stable deterministic id from an opt-in idempotency key", () =>
    Effect.gen(function*() {
      const first = yield* Idempotent.executionId({ value: "stable" })
      const second = yield* Idempotent.executionId({ value: "stable" })
      const other = yield* Idempotent.executionId({ value: "other" })
      expect(first).toBe(second)
      expect(first).not.toBe(other)
    }))

  effect("frames a declared flow tag and key instead of delimiter-splicing them", () =>
    Effect.gen(function*() {
      const left = keyedFlow("a-b", "c")
      const right = keyedFlow("a", "b-c")

      expect(`${left._tag}-c`).toBe(`${right._tag}-b-c`)
      const leftId = yield* left.executionId({})
      const rightId = yield* right.executionId({})
      expect(leftId).not.toBe(rightId)
      expect(leftId).toBe("a9504b44f8b6649d0d41a006af6f902532eb78b43e4a673efbc580621cb62e96")
    }))

  effect("frames the derived source's tag and canonical payload key", () =>
    Effect.gen(function*() {
      const left = ambientFlow("a-b")
      const right = ambientFlow("a")

      expect(`${left._tag}-c`).toBe(`${right._tag}-b-c`)
      expect(yield* left.executionId({ value: "c" })).not.toBe(
        yield* right.executionId({ value: "b-c" })
      )
    }).pipe(Effect.provide(Flow.layerExecutionIds(Flow.derived))))

  effect("frames empty keys without absorbing a neighboring member", () =>
    Effect.gen(function*() {
      const emptyKey = yield* keyedFlow("a-b", "").executionId({})
      const neighborKey = yield* keyedFlow("a", "b-").executionId({})

      expect(emptyKey).not.toBe(neighborKey)
    }))

  effect("hashes non-ASCII tags and keys exactly without Unicode normalization", () =>
    Effect.gen(function*() {
      const composed = keyedFlow("caf\u00e9", "cl\u00e9")
      const decomposed = keyedFlow("cafe\u0301", "cle\u0301")
      const first = yield* composed.executionId({})

      expect(yield* composed.executionId({})).toBe(first)
      expect(yield* decomposed.executionId({})).not.toBe(first)
      expect(first).toMatch(/^[0-9a-f]{64}$/)
    }))

  effect("an explicit execution id wins over the ambient source", () =>
    Effect.gen(function*() {
      const executionId = yield* Anonymous.execute(
        { value: "same" },
        { discard: true, executionId: "caller-selected" }
      )
      expect(executionId).toBe("caller-selected")
    }).pipe(Effect.provide(AnonymousLayer), Effect.provide(fixed("ambient-id"))))

  effect("a declared idempotency key wins over the ambient source", () =>
    Effect.gen(function*() {
      const derived = yield* Idempotent.executionId({ value: "same" })
      const executionId = yield* Idempotent.execute({ value: "same" }, { discard: true })
      expect(executionId).toBe(derived)
      expect(executionId).not.toBe("ambient-id")
    }).pipe(Effect.provide(IdempotentLayer), Effect.provide(fixed("ambient-id"))))

  effect("the ambient source names an execution the caller and the flow left unnamed", () =>
    Effect.gen(function*() {
      const executionId = yield* Anonymous.execute({ value: "same" }, { discard: true })
      expect(executionId).toBe("ambient-id")
    }).pipe(Effect.provide(AnonymousLayer), Effect.provide(fixed("ambient-id"))))

  // A host installs this source, so a hostile or careless one is a wiring
  // mistake rather than caller input. The port does not second-guess it, and
  // these two cases record what a bad source actually costs instead of
  // leaving it undocumented.
  effect("runs under an empty id when the host source mints one", () =>
    Effect.gen(function*() {
      const executionId = yield* Anonymous.execute({ value: "empty" }, { discard: true })
      expect(executionId).toBe("")
    }).pipe(Effect.provide(AnonymousLayer), Effect.provide(fixed(""))))

  effect(
    "collapses two flows onto one execution when the host source names one id for both",
    () =>
      Effect.gen(function*() {
        // The settled cost of a bad source, pinned rather than left to be
        // discovered in production: the runtime addresses an execution by its
        // id, so a source that answers every flow with one id makes the SECOND
        // flow replay the FIRST one's recorded result instead of running. A
        // source installed with `layerExecutionIds` must therefore scope the id
        // to something that actually separates the work, and the flow tag is
        // part of what the opt-in `derived` source hashes for this reason.
        //
        // This pins the cost, NOT a settled design. `FlowRuntime`'s port
        // addresses an execution by id alone, while `WaitFor.action`'s token
        // path compares the flow name AND the execution id
        // (`src/WaitFor.ts`), so the two surfaces already disagree about what
        // identifies a run. Whether the engine should key an execution by
        // (flow, executionId) is an open question for `@smthrs/engine` and
        // `@smthrs/engine-store`, which own the record this test only reads
        // through the memory fixture. If that changes, this expectation turns
        // red on purpose: replace it with the two ids the new keying produces
        // rather than restoring the collapse.
        expect(yield* Anonymous.execute({ value: "left" })).toBe("left")
        expect(yield* Twin.execute({ value: "right" })).toBe("left")
      }).pipe(
        Effect.provide(
          layerWired(
            Layer.mergeAll(
              Echo.toLayer(({ value }) => Effect.succeed(value)),
              Interpreter.layer(Anonymous),
              Interpreter.layer(Twin)
            )
          )
        ),
        Effect.provide(fixed("collided-id"))
      )
  )
})

describe("the explicit payload-derived execution-id source", () => {
  const derivedEffect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
    effect(name, () => body().pipe(Effect.provide(Flow.layerExecutionIds(Flow.derived))))
  derivedEffect("runs a flow that named no identity at all, and answers with its value", () =>
    Effect.gen(function*() {
      // The whole point: this is `yield* F.execute(payload)`, with no
      // executionId, no idempotencyKey, and no layer wiring identity.
      const value = yield* Anonymous.execute({ value: "unnamed" })
      expect(value).toBe("unnamed")
    }).pipe(Effect.provide(AnonymousLayer)))

  derivedEffect("derives one stable id per (flow tag, payload) pair", () =>
    Effect.gen(function*() {
      const first = yield* Anonymous.executionId({ value: "stable" })
      const second = yield* Anonymous.executionId({ value: "stable" })
      const otherPayload = yield* Anonymous.executionId({ value: "other" })
      const otherFlow = yield* Twin.executionId({ value: "stable" })
      expect(first).toBe(second)
      expect(first).not.toBe(otherPayload)
      // The tag is part of the derivation, so two flows of the same shape do
      // not share an execution.
      expect(first).not.toBe(otherFlow)
    }).pipe(Effect.provide(Flow.layerExecutionIds(Flow.derived))))

  effect("joins equal payloads when the derived source is explicitly installed", () => {
    let invoked = 0
    const layer = layerWired(
      Layer.mergeAll(
        Echo.toLayer(({ value }) =>
          Effect.sync(() => {
            invoked++
            return value
          })
        ),
        Interpreter.layer(Anonymous)
      )
    )

    return Effect.gen(function*() {
      expect(yield* Anonymous.execute({ value: "Ada" })).toBe("Ada")
      expect(yield* Anonymous.execute({ value: "Ada" })).toBe("Ada")
      expect(invoked).toBe(1)
    }).pipe(
      Effect.provide(layer),
      Effect.provide(Flow.layerExecutionIds(Flow.derived))
    )
  })

  effect("keeps equal payloads distinct when the caller supplies execution ids", () => {
    let invoked = 0
    const layer = layerWired(
      Layer.mergeAll(
        Echo.toLayer(({ value }) =>
          Effect.sync(() => {
            invoked++
            return value
          })
        ),
        Interpreter.layer(Anonymous)
      )
    )

    return Effect.gen(function*() {
      expect(yield* Anonymous.execute({ value: "Ada" }, { executionId: "ada-1" })).toBe("Ada")
      expect(yield* Anonymous.execute({ value: "Ada" }, { executionId: "ada-2" })).toBe("Ada")
      expect(invoked).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  derivedEffect("agrees with the id execute runs under", () =>
    Effect.gen(function*() {
      const predicted = yield* Anonymous.executionId({ value: "agreed" })
      const executionId = yield* Anonymous.execute({ value: "agreed" }, { discard: true })
      expect(executionId).toBe(predicted)
    }).pipe(
      Effect.provide(AnonymousLayer),
      Effect.provide(Flow.layerExecutionIds(Flow.derived))
    ))

  derivedEffect("dies before engine invocation when the payload has no canonical form", () => {
    const Unreached = Action.make("ExecutionId/unreached", {
      payload: { value: Schema.String },
      success: Schema.String
    })
    const Uncanonical = Flow.make("ExecutionId/Uncanonical", {
      payload: { value: Schema.String },
      success: Schema.String,
      body: ({ value }) => Unreached.call({ value })
    })
    let invoked = 0
    const layer = layerWired(
      Layer.mergeAll(
        Unreached.toLayer(({ value }) =>
          Effect.sync(() => {
            invoked++
            return value
          })
        ),
        Interpreter.layer(Uncanonical)
      )
    )

    return Effect.gen(function*() {
      // RFC 8785 has no form for a lone surrogate, so this invocation has no
      // derivable identity and must not open a run under a guessed one.
      const exit = yield* Uncanonical.execute({ value: "\uD800" }).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(true)
      expect(Exit.isFailure(exit) && exit.cause.toString()).toContain("ExecutionIdRequired")
      expect(invoked).toBe(0)
    }).pipe(
      Effect.provide(layer),
      Effect.provide(Flow.layerExecutionIds(Flow.derived))
    )
  })
})
