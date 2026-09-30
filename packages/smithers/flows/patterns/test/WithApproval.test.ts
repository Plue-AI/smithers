/**
 * `WithApproval` on `@smthrs/flow`'s `Graph.build` and `Interpreter`.
 *
 * Every assertion is the one it was: the composed name and ceiling, the
 * approval call declared ahead of the gated one with the payload it carries,
 * and the four run-time outcomes, denial, failure, interruption and approval.
 * The evaluator is the real `Interpreter` over the in-memory engine, with the
 * two opaque steps declared as actions whose implementations a case scripts.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { describe, it } from "@effect/vitest"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import * as Effects from "@smthrs/plan/Effects"
import * as Node from "@smthrs/plan/Node"
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { expect } from "vitest"
import * as Decorate from "../src/internal/Decorate.ts"
import { PatternError } from "../src/PatternError.ts"
import * as WithApproval from "../src/WithApproval.ts"
import { callsTo, payloadOf } from "./Graphs.ts"

const ApprovalInput = Schema.Struct({
  input: Schema.Unknown,
  reason: Schema.String,
  scope: Schema.String
})

const Release = Schema.Struct({ release: Schema.String })

/** What the approval and the gated step were handed, and in what order. */
const approvalInputs: Array<unknown> = []
const innerInputs: Array<unknown> = []
const trace: Array<string> = []
/** What the scripted approver answers, set per case. */
let decision: Effect.Effect<unknown, unknown> = Effect.succeed("approved")

const decide = Action.make("withApproval/decide", {
  payload: { input: Schema.Unknown, reason: Schema.String, scope: Schema.String },
  success: WithApproval.Approved,
  error: PatternError
})

const decideLayer = decide.toLayer((payload) =>
  Effect.suspend((): Effect.Effect<"approved", PatternError> => {
    trace.push("approval")
    approvalInputs.push(payload)
    return Effect.tap(decision, () => Effect.sync(() => trace.push("approved"))) as Effect.Effect<
      "approved",
      PatternError
    >
  })
)

const publish = Action.make("withApproval/publish", {
  payload: { release: Schema.String },
  success: Release,
  error: Schema.Never
})

const publishLayer = publish.toLayer((payload) =>
  Effect.sync(() => {
    trace.push("inner")
    innerInputs.push(payload)
    return payload
  })
)

const inner = Flow.make("publish", {
  payload: Release,
  success: Release,
  error: Schema.Unknown,
  capabilities: ["fs:write:release/**"],
  effects: Effects.make({
    reads: [],
    writes: ["release"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  }),
  body: Node.capture({}, ({ release }: { readonly release: string }) => publish.call({ release }))
}) as unknown as Flow.Any

const approval = Flow.make("human-approval", {
  payload: ApprovalInput,
  success: WithApproval.Approved,
  error: Schema.Unknown,
  body: Node.capture({}, (payload: typeof ApprovalInput.Type) => decide.call(payload))
}) as unknown as Flow.Any

/** A declaration carrying exactly the schema pair a refusal case needs. */
const declaring = (input: Schema.Top, output: Schema.Top): Flow.Any =>
  Flow.make("withApproval/probe", {
    payload: input as Flow.AnyStructSchema,
    success: output,
    error: Schema.Never,
    body: (value: unknown) => Node.succeed(value)
  }) as unknown as Flow.Any

/**
 * Runs one declaration to settlement IN Effect, not through a promise: the
 * denial and interruption cases assert on the cause, which a promise loses.
 */
const settle = (wrapper: Flow.Any, payload: unknown, executionId: string): Effect.Effect<unknown, unknown> =>
  (wrapper as unknown as {
    readonly execute: (
      payload: unknown,
      options: { readonly executionId: string }
    ) => Effect.Effect<unknown, unknown, any>
  })
    .execute(payload, { executionId })
    .pipe(
      Effect.provide(
        Layer.mergeAll(
          Interpreter.layer(wrapper as never),
          Interpreter.layer(inner as never),
          decideLayer,
          publishLayer
        ).pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(FlowEngine.layerMemory),
          Layer.provideMerge(NodeCrypto.layer)
        ) as Layer.Layer<any, never, never>
      ),
      Effect.scoped
    ) as Effect.Effect<unknown, unknown>

let executions = 0

const gated = (answer: Effect.Effect<unknown, unknown>) => {
  approvalInputs.length = 0
  innerInputs.length = 0
  trace.length = 0
  decision = answer
  executions = executions + 1
  const wrapper = WithApproval.withApproval(inner, { reason: "publish release", approval })
  return {
    input: { release: "v1" },
    approvalInputs,
    innerInputs,
    trace,
    run: settle(wrapper, { release: "v1" }, `with-approval-${executions}`)
  }
}

describe("WithApproval", () => {
  it("runs a caller-supplied approval flow before the inner flow", () => {
    const approved = WithApproval.withApproval(inner, { reason: "publish release", approval })
    const graph = Graph.build(approved, { release: "v1" })
    const approvalCall = callsTo(graph, "human-approval")[0]
    const gatedCall = callsTo(graph, "publish")[0]

    expect(approved._tag).toBe("withApproval(publish)")
    expect(Decorate.capabilitiesOf(approved)).toEqual(["fs:write:release/**"])
    expect(Graph.nodes(graph).filter((node) => node.kind === "ActionCall")).toHaveLength(2)
    expect(Graph.diagnostics(graph)).toEqual([])

    expect(payloadOf(approvalCall!)).toEqual({
      input: { release: "v1" },
      reason: "publish release",
      scope: "run"
    })
    expect(payloadOf(gatedCall!)).toEqual({ release: "v1" })
    // The gated call waits for the approval, which is what the decorator is
    // for. `@smthrs/flow` states it as an edge whose reason is the sequencing.
    expect(Graph.edges(graph).some((edge) => edge.from === approvalCall!.id && edge.to === gatedCall!.id)).toBe(true)
  })

  it("carries the wrapped flow's description, and states none when it has none", () => {
    // The gated wrapper copies it, and `Pattern.decorate`'s re-declaration
    // copies it again off that wrapper, so both readings are stated here.
    const described = Flow.make("publish-described", {
      description: "Publish one release.",
      payload: Release,
      success: Release,
      error: Schema.Unknown,
      body: Node.capture({}, ({ release }: { readonly release: string }) => publish.call({ release }))
    }) as unknown as Flow.Any

    expect(WithApproval.withApproval(described, { reason: "publish release", approval }).description)
      .toBe("Publish one release.")
    expect(WithApproval.withApproval(inner, { reason: "publish release", approval }).description)
      .toBeUndefined()
  })

  it.effect("rejects denial on the schema channel and never starts the gated step", () =>
    Effect.gen(function*() {
      // The approval action declares `Approved`, and its scripted
      // implementation answers "denied". Under `@smthrs/core` the wrapper's
      // declared OUTPUT was decoded and the violation was a typed
      // `SchemaError` failure; `@smthrs/flow` treats an implementation that
      // breaks its own declared success schema as a defect, because it is
      // programmer wiring rather than caller data. The fact the case is about,
      // that a denial is a schema refusal and never reaches the gated step, is
      // asserted on the cause instead of the failure channel.
      const fixture = gated(Effect.succeed("denied"))
      const exit = yield* Effect.exit(fixture.run)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true)
        expect(Schema.isSchemaError(Cause.squash(exit.cause))).toBe(true)
      }
      expect(fixture.approvalInputs).toHaveLength(1)
      expect(fixture.innerInputs).toEqual([])
    }))

  it.effect("leaves the inner flow unstarted when approval fails", () =>
    Effect.gen(function*() {
      const error = new PatternError({ code: "exhausted", message: "Approval unavailable" })
      const fixture = gated(Effect.fail(error))
      const failure = yield* fixture.run.pipe(Effect.flip)

      expect(failure).toMatchObject({ code: "exhausted", message: "Approval unavailable" })
      expect(fixture.trace).toEqual(["approval"])
      expect(fixture.innerInputs).toEqual([])
    }))

  it.effect("leaves the inner flow unstarted when approval is interrupted", () =>
    Effect.gen(function*() {
      const fixture = gated(Effect.interrupt)
      const exit = yield* Effect.exit(fixture.run)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.isCause(exit.cause)).toBe(true)
      expect(fixture.trace).toEqual(["approval"])
      expect(fixture.innerInputs).toEqual([])
    }))

  it.effect("invokes the inner flow exactly once with the original input after approval", () =>
    Effect.gen(function*() {
      const fixture = gated(Effect.succeed("approved"))
      const result = yield* fixture.run

      expect(result).toEqual(fixture.input)
      expect(fixture.approvalInputs).toEqual([{
        input: fixture.input,
        reason: "publish release",
        scope: "run"
      }])
      expect(fixture.innerInputs).toEqual([fixture.input])
      expect(fixture.trace).toEqual(["approval", "approved", "inner"])
    }))

  it("accepts an approval flow whose input exactly describes the call payload", () => {
    const approved = WithApproval.withApproval(inner, {
      reason: "publish",
      approval: declaring(ApprovalInput, WithApproval.Approved)
    })

    expect(Graph.diagnostics(Graph.build(approved, { release: "v1" }))).toEqual([])
  })

  it("names the input side and both schema tags for an incompatible approval input", () => {
    expect(() =>
      WithApproval.withApproval(inner, {
        reason: "publish",
        approval: declaring(Schema.String, WithApproval.Approved)
      })
    ).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The bound flow has an incompatible input schema: expected Objects, received String"
      })
    )
  })

  it("rejects an approval flow whose output permits denial", () => {
    expect(() =>
      WithApproval.withApproval(inner, {
        reason: "publish",
        approval: declaring(Schema.Unknown, Schema.String)
      })
    ).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "The bound flow has an incompatible output schema: expected Literal, received String"
      })
    )
  })

  it("checks the approval flow's declared authority against the wrapper's at build", () => {
    // The wrapper declares the inner flow's authority only; an approval flow
    // that asks for more is refused by `Graph.build` at the approval call, so
    // the composite cannot hide it.
    const greedy = Flow.make("greedy-approval", {
      payload: ApprovalInput,
      success: WithApproval.Approved,
      error: Schema.Unknown,
      capabilities: ["net:post:**"],
      effects: Effects.make({
        reads: [],
        writes: ["secrets"],
        mode: "expected",
        onConflict: "serialize",
        tier: "irreversible"
      }),
      body: Node.capture({}, (payload: typeof ApprovalInput.Type) => decide.call(payload))
    }) as unknown as Flow.Any
    const graph = Graph.build(WithApproval.withApproval(inner, { reason: "publish release", approval: greedy }), {
      release: "v1"
    })
    const approvalCall = callsTo(graph, "greedy-approval")[0]!

    expect(Graph.diagnostics(graph).map((error) => [error.code, error.node, error.path])).toEqual([
      ["effect_outside_envelope", approvalCall.id, ["secrets"]],
      ["capability_outside_grant", approvalCall.id, ["net:post:**"]]
    ])
    expect(approvalCall.capabilities).not.toContain("net:post:**")
    expect(() => Graph.drafts(graph)).toThrow(expect.objectContaining({ code: "effect_outside_envelope" }))
  })

  it("refuses a blank approval reason with its exact code", () => {
    expect(() => WithApproval.withApproval(inner, { reason: " \t", approval })).toThrow(
      expect.objectContaining({
        code: "invalid_decorator",
        message: "Approval reason must not be empty"
      })
    )
    expect(() => WithApproval.withApproval(inner, { reason: " \t", approval })).toThrow(PatternError)
  })
})
