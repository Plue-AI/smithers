import { describe, expect, expectTypeOf, it } from "@effect/vitest"
import { Action, Flow, Graph, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Cause, Context, Duration, Effect, Exit, Layer, Schema } from "effect"
import { effect } from "./Harness.ts"
import { layerMemory } from "./MemoryFlowRuntime.ts"

describe("canonical prompt flows", () => {
  it("plans one ordinary action without rendering the prompt", () => {
    let renders = 0
    const flow = Flow.make("prompt/summary", {
      payload: { count: Schema.NumberFromString },
      success: Schema.String,
      prompt: ({ count }) => {
        expectTypeOf(count).toEqualTypeOf<number>()
        renders++
        return `Summarize ${count}.`
      }
    })
    expectTypeOf<Flow.Requirements<typeof flow>>().toEqualTypeOf<Action.Requirement<"prompt/summary/prompt">>()
    expect(renders).toBe(0)
    expect(flow.action.name).toBe("prompt/summary/prompt")
    expect(flow.action.payloadSchema).toBe(flow.payloadSchema)
    expect(flow.action.successSchema).toBe(flow.successSchema)
    const graph = Graph.build(flow, { count: 2 }, { callbackIdentity: "stable" })
    expect(graph.diagnostics).toEqual([])
    expect(graph.nodes.map(({ kind }) => kind)).toEqual(["ActionCall", "FlowCall"])
    expect(Graph.drafts(graph)).toHaveLength(2)
    expect(renders).toBe(0)
    expect(flow.prompt({ count: 2 })).toBe("Summarize 2.")
    expect(renders).toBe(1)
  })

  effect("runs, validates inputs, and replays through the existing interpreter", () => {
    let renders = 0
    const flow = Flow.make("prompt/execute", {
      payload: { count: Schema.Number },
      success: Schema.String,
      error: Schema.String,
      prompt: ({ count }) => {
        renders++
        return `Count ${count}`
      }
    })
    const layer = Interpreter.layerWithImplementations(
      flow,
      flow.action.toLayer((payload) => Effect.succeed(flow.prompt(payload)))
    ).pipe(Layer.provideMerge(layerMemory))
    return Effect.gen(function*() {
      const invalid = yield* Effect.exit(flow.execute({ count: "wrong" } as never, { executionId: "bad" }))
      expect(Exit.isFailure(invalid)).toBe(true)
      expect(renders).toBe(0)
      expect(yield* flow.execute({ count: 3 }, { executionId: "same" })).toBe("Count 3")
      expect(yield* flow.execute({ count: 3 }, { executionId: "same" })).toBe("Count 3")
      expect(renders).toBe(1)
    }).pipe(Effect.provide(layer))
  })

  it("retains renderer, action, and literal metadata through annotations", () => {
    const prompt = ({ name }: { readonly name: string }) => `Hello ${name}`
    const flow = Flow.make("prompt/metadata", {
      payload: { name: Schema.String },
      success: Schema.String,
      capabilities: ["fs:read:src/**"],
      effects: { reads: ["src/**"], writes: [], tier: "irreversible", mode: "expected", onConflict: "fail" },
      model: ["primary", "fallback"],
      effort: "high",
      system: ["Keep answers brief."],
      chat: true,
      flows: ["review"],
      prompt
    })
    for (
      const annotated of [
        flow,
        flow.annotate(Flow.ModelInvocable, false),
        flow.annotateMerge(Context.make(Flow.ModelInvocable, false))
      ]
    ) {
      expect(annotated.prompt).toBe(prompt)
      expect(annotated.action).toBe(flow.action)
      expect(annotated.model).toEqual(["primary", "fallback"])
      expect(annotated.effort).toBe("high")
      expect(annotated.system).toEqual(["Keep answers brief."])
      expect(annotated.chat).toBe(true)
      expect(annotated.flows).toEqual(["review"])
      expect(annotated.body({ name: "Ada" }).ast).toMatchObject({
        _tag: "ActionCall",
        action: "prompt/metadata/prompt",
        payload: { name: "Ada" }
      })
    }
    expect(Context.get(flow.action.annotations, Flow.Capabilities)).toEqual(["fs:read:src/**"])
    expect(flow.action.tier).toBe("irreversible")
    expect(flow.action.idempotencyKey).toBeUndefined()
  })

  it("keeps body declarations unchanged and rejects two behaviors", () => {
    const body = ({ count }: { readonly count: number }) => Node.succeed(count)
    const flow = Flow.make("prompt/body", {
      payload: { count: Schema.Number },
      success: Schema.Number,
      body,
      model: "primary",
      system: ["Teaching"],
      chat: false,
      flows: []
    })
    expect(flow.body).toBe(body)
    expect(flow.action).toBeUndefined()
    expect(flow.prompt).toBeUndefined()
    expect(flow.annotate(Flow.ModelInvocable, false).system).toEqual(["Teaching"])
    expect(() => {
      // @ts-expect-error -- declarations have exactly one behavior.
      Flow.make("prompt/two", { payload: {}, body: () => Node.succeed(undefined), prompt: () => "wrong" })
    }).toThrow(/body.*prompt/)
  })

  effect("preserves declared failures and renderer defects at the action boundary", () => {
    const flow = Flow.make("prompt/failure", {
      payload: { fail: Schema.Boolean },
      success: Schema.String,
      error: Schema.String,
      prompt: () => {
        throw new Error("renderer failed")
      }
    })
    const layer = Interpreter.layerWithImplementations(
      flow,
      flow.action.toLayer((payload) =>
        payload.fail ? Effect.fail("declared failure") : Effect.sync(() => flow.prompt(payload))
      )
    ).pipe(Layer.provideMerge(layerMemory))
    return Effect.gen(function*() {
      const failed = yield* Effect.exit(flow.execute({ fail: true }, { executionId: "failure" }))
      expect(Exit.isFailure(failed)).toBe(true)
      if (Exit.isFailure(failed)) expect(Cause.squash(failed.cause)).toBe("declared failure")
      const defect = yield* Effect.exit(flow.execute({ fail: false }, { executionId: "defect" }))
      expect(Exit.isFailure(defect)).toBe(true)
      if (Exit.isFailure(defect)) expect(String(Cause.squash(defect.cause))).toContain("renderer failed")
    }).pipe(Effect.provide(layer))
  })

  it("refuses missing, non-string, empty, and blank tags", () => {
    for (const tag of [undefined, null, 12, {}, "", "  "] as const) {
      expect(() => Flow.make(tag as never, { payload: {}, body: () => Node.succeed(undefined) }))
        .toThrow(/tag must be a non-empty string/)
    }
    const flow = Flow.make(" prompt/valid ", { payload: {}, prompt: () => "valid" })
    expect(flow._tag).toBe(" prompt/valid ")
  })

  it("keeps schema defaults and explicit implementation identity", () => {
    const payload = Schema.Struct({ count: Schema.Number })
    const flow = Flow.make("prompt/defaults", {
      payload,
      prompt: ({ count }) => `Count ${count}`,
      implementationVersion: "prompt/v1"
    })
    expect(flow.payloadSchema).toBe(payload)
    expect(flow.successSchema).toBe(Schema.Void)
    expect(flow.errorSchema).toBe(Schema.Never)
    expect(flow.action.implementationVersion).toBe("prompt/v1")
    expect(flow.action.errorSchema).toBe(flow.errorSchema)
    expectTypeOf(flow.annotate(Flow.ModelInvocable, false).action.name).toEqualTypeOf<"prompt/defaults/prompt">()
    expectTypeOf(flow.annotateMerge(Context.empty()).prompt).toEqualTypeOf<
      (payload: { readonly count: number }) => string
    >()
    const changed = Flow.make("prompt/defaults", {
      payload,
      prompt: ({ count }) => `Count ${count}`,
      implementationVersion: "prompt/v2"
    })
    expect(Node.functionIdentity(flow.body)).not.toEqual(Node.functionIdentity(changed.body))
    expect(Graph.build(flow, { count: 1 }, { callbackIdentity: "stable" }).diagnostics).toEqual([])
  })

  for (const tier of ["sealed", "compensable", "irreversible"] as const) {
    it(`keeps the explicitly declared ${tier} effect tier`, () => {
      const flow = Flow.make(`prompt/tier-${tier}`, {
        payload: {},
        effects: { reads: [], writes: [], tier, mode: "hermetic", onConflict: "fail" },
        prompt: () => "Run the declared operation."
      })
      expect(flow.action.tier).toBe(tier)
      expect(flow.action.idempotencyKey).toBeUndefined()
      expect(Graph.build(flow, {}, { callbackIdentity: "stable" }).diagnostics).toEqual([])
    })
  }

  it("refuses JavaScript declarations without one callable behavior", () => {
    const invalid = [
      { payload: {} },
      { payload: {}, body: null },
      { payload: {}, body: 1 },
      { payload: {}, prompt: "literal" },
      { payload: {}, prompt: null },
      { payload: {}, body: () => Node.succeed(undefined), prompt: 1 },
      { payload: {}, body: 1, prompt: () => "valid" }
    ]
    for (const options of invalid) {
      expect(() => Flow.make("prompt/invalid-js", options as never)).toThrow(/body.*prompt/)
    }
  })

  it("retains the original declaration site when reconstructing a prompt", () => {
    const original = Flow.make("prompt/source", { payload: {}, prompt: () => "source" })
    const rebuilt = Flow.make("prompt/rebuilt", { payload: {}, prompt: () => "rebuilt", declaredFrom: original })
    const originalSite = Graph.build(original, {}).nodes.find(({ kind }) => kind === "FlowCall")?.declaredAt
    expect(originalSite?.path.endsWith("test/PromptFlow.test.ts")).toBe(true)
    const graph = Graph.build(rebuilt, {})
    expect(graph.nodes.map(({ declaredAt }) => declaredAt)).toEqual([originalSite, originalSite])
  })

  it("validates deadline bounds before planning and preserves a valid duration", () => {
    let renders = 0
    const prompt = () => {
      renders++
      return "run"
    }
    for (const deadline of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "invalid"] as const) {
      expect(() => Flow.make("prompt/deadline-invalid", { payload: {}, prompt, deadline: deadline as Duration.Input }))
        .toThrow(/deadline must be a positive finite duration/)
    }
    expect(renders).toBe(0)
    const flow = Flow.make("prompt/deadline-valid", { payload: {}, prompt, deadline: "250 millis" })
    expect(Duration.toMillis(flow.deadline!)).toBe(250)
    expect(flow.annotate(Flow.ModelInvocable, false).deadline).toBe(flow.deadline)
    expect(flow.annotateMerge(Context.empty()).deadline).toBe(flow.deadline)
    expect(Graph.build(flow, {}, { callbackIdentity: "stable" }).diagnostics).toEqual([])
    expect(renders).toBe(0)
  })
})
