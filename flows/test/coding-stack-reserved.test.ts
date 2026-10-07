import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { NativeCoding, NativeCodingError, StackCandidate, StackProposal } from "../coding/native.ts"
import { CodingError } from "../coding/schema.ts"
import { Candidate, captureStackCandidate, Propose, proposeStackCandidate, stackBaseLayer } from "../coding/stack.ts"

const candidate = { generation: 3, base: "a".repeat(40), head: "b".repeat(40) }
const proposal = { generation: 3, head: "c".repeat(40) }
const Capture = Flow.make("test/stack-candidate", {
  payload: {},
  success: StackCandidate,
  error: Schema.Union([CodingError, NativeCodingError]),
  body: () => Candidate.call({})
})
const Publish = Flow.make("test/stack-propose", {
  payload: { generation: StackCandidate.fields.generation },
  success: StackProposal,
  error: Schema.Union([CodingError, NativeCodingError]),
  body: ({ generation }) => Propose.call({ generation })
})
const forbidden = () => Effect.die("reserved operations must not call ordinary native operations")
const native = {
  sourcePublication: "cloud" as const,
  read: forbidden,
  apply: forbidden,
  publishOriginalSource: forbidden
}

// Actual declared-action dispatch and its journal run against a test-only
// authority transport. This is not a guest/microVM admission receipt.
test("reserved packaged actions dispatch through NativeCoding and replay without another capture or push", async (t) => {
  const calls: Array<{ kind: string; requestId: string; generation?: number }> = []
  const provider = Layer.succeed(NativeCoding, {
    ...native,
    stackCandidate: (requestId) =>
      Effect.sync(() => {
        calls.push({ kind: "candidate", requestId })
        return candidate
      }),
    stackPropose: (requestId, generation) =>
      Effect.sync(() => {
        calls.push({ kind: "propose", requestId, generation })
        return proposal
      })
  })
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Interpreter.layer(Capture),
      Interpreter.layer(Publish),
      stackBaseLayer.pipe(Layer.provide(provider))
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer)
    )
  )
  t.after(() => runtime.dispose())
  assert.deepEqual(await runtime.runPromise(Capture.execute({}, { executionId: "capture-one" })), candidate)
  assert.deepEqual(await runtime.runPromise(Capture.execute({}, { executionId: "capture-one" })), candidate)
  assert.deepEqual(
    await runtime.runPromise(Publish.execute({ generation: 3 }, { executionId: "publish-one" })),
    proposal
  )
  assert.deepEqual(
    await runtime.runPromise(Publish.execute({ generation: 3 }, { executionId: "publish-one" })),
    proposal
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[1]!.generation, 3)
  assert.notEqual(calls[0]!.requestId, calls[1]!.requestId)
})

test("missing native authority refuses both actions before ordinary native reads or writes", async () => {
  for (const sourcePublication of ["cloud", "local-only"] as const) {
    const provider = Layer.succeed(NativeCoding, { ...native, sourcePublication })
    for (const operation of [captureStackCandidate("run"), proposeStackCandidate("run", 3)]) {
      const error = await Effect.runPromise(
        Effect.flip(operation).pipe(
          Effect.provide(provider),
          Effect.provideService(Action.CurrentInvocationKey, "node-one")
        )
      )
      assert.equal(error.code, "source_refused")
    }
  }
})

test("a runtime without durable invocation identity refuses before the authority transport", async () => {
  const provider = Layer.succeed(NativeCoding, { ...native, stackCandidate: forbidden, stackPropose: forbidden })
  for (const operation of [captureStackCandidate("run"), proposeStackCandidate("run", 3)]) {
    const error = await Effect.runPromise(Effect.flip(operation).pipe(Effect.provide(provider)))
    assert.equal(error.code, "source_refused")
    assert.match(error.message, /identity/)
  }
})

test("two captures on the same run use distinct engine identities while replay retains the request", async () => {
  const requests: string[] = []
  const provider = Layer.succeed(NativeCoding, {
    ...native,
    stackCandidate: (id: string) =>
      Effect.sync(() => {
        requests.push(id)
        return candidate
      })
  })
  for (const key of ["node-one", "node-two", "node-one"]) {
    await Effect.runPromise(
      captureStackCandidate("same-run").pipe(
        Effect.provide(provider),
        Effect.provideService(Action.CurrentInvocationKey, key)
      )
    )
  }
  assert.notEqual(requests[0], requests[1])
  assert.equal(requests[0], requests[2])
})

test("a local-only host cannot use even an installed reserved transport", async () => {
  const provider = Layer.succeed(NativeCoding, {
    ...native,
    sourcePublication: "local-only" as const,
    stackCandidate: forbidden,
    stackPropose: forbidden
  })
  for (const operation of [captureStackCandidate("run"), proposeStackCandidate("run", 3)]) {
    const error = await Effect.runPromise(
      Effect.flip(operation).pipe(
        Effect.provide(provider),
        Effect.provideService(Action.CurrentInvocationKey, "node-one")
      )
    )
    assert.equal(error.code, "source_refused")
    assert.match(error.message, /authority/)
  }
})
test("Propose refuses an acknowledgement for another generation", async () => {
  const provider = Layer.succeed(NativeCoding, {
    ...native,
    stackPropose: () => Effect.succeed({ ...proposal, generation: 4 })
  })
  const error = await Effect.runPromise(
    Effect.flip(proposeStackCandidate("run", 3)).pipe(
      Effect.provide(provider),
      Effect.provideService(Action.CurrentInvocationKey, "node-one")
    )
  )
  assert.equal(error.code, "source_refused")
  assert.match(error.message, /another candidate generation/)
})
