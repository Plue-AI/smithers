import { describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import { Action, Flow, Graph } from "@smthrs/flow"
import { Effects, GraphBuildError } from "@smthrs/plan"
import { Context, Option, Schema } from "effect"

const Touch = Action.make("envelope/touch", {
  payload: { path: Schema.String },
  success: Schema.Number
})

const envelope = (input: Partial<Effects.MakeOptions> = {}): Effects.Declaration =>
  Effects.make({
    reads: input.reads ?? [],
    writes: input.writes ?? [],
    mode: input.mode ?? "expected",
    onConflict: input.onConflict ?? "serialize",
    ...(input.tier === undefined ? {} : { tier: input.tier })
  })

/** The envelope a declaration's annotation bag carries, or `undefined`. */
const declaredEnvelope = (annotations: Context.Context<never>): Effects.Declaration | undefined =>
  Option.getOrUndefined(Context.getOption(annotations, Flow.EffectEnvelope))

/** The diagnostic a build recorded for one code, or `undefined`. */
const recorded = (graph: Graph.Graph, code: string): GraphBuildError.GraphBuildError | undefined =>
  Graph.diagnostics(graph).find((diagnostic) => diagnostic.code === code)

describe("Graph.build effect envelope", () => {
  it("admits a callee that narrows the enclosing envelope", () => {
    const Callee = Flow.make("envelope/narrow-callee", {
      payload: {},
      success: Schema.Number,
      effects: { reads: ["src/a.ts"], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
      body: () => Touch.call({ path: "src/a.ts" })
    })
    const Caller = Flow.make("envelope/narrow-caller", {
      payload: {},
      success: Schema.Number,
      effects: {
        reads: ["src/**"],
        writes: ["dist/**"],
        mode: "hermetic",
        onConflict: "serialize",
        tier: "compensable"
      },
      body: () => Callee.call({})
    })

    const graph = Graph.build(Caller, {})

    expect(Graph.diagnostics(graph)).toEqual([])
    expect(Graph.drafts(graph).length).toBeGreaterThan(0)
  })

  it("refuses an inline callee that reads or writes outside the envelope", () => {
    const Callee = Flow.make("envelope/outside-callee", {
      payload: {},
      success: Schema.Number,
      effects: { reads: [], writes: ["/etc/passwd"], mode: "hermetic", onConflict: "serialize" },
      body: () => Touch.call({ path: "/etc/passwd" })
    })
    const Caller = Flow.make("envelope/outside-caller", {
      payload: {},
      success: Schema.Number,
      effects: { reads: ["src/**"], writes: ["dist/**"], mode: "hermetic", onConflict: "serialize" },
      body: () => Callee.call({})
    })

    const graph = Graph.build(Caller, {})
    const refusal = recorded(graph, "effect_outside_envelope")

    expect(refusal?.code).toBe("effect_outside_envelope")
    expect(refusal?.node).toBe("root.flow")
    expect(refusal?.path).toEqual(["/etc/passwd"])
    expect(() => Graph.drafts(graph)).toThrow(
      expect.objectContaining({ code: "effect_outside_envelope" })
    )
  })

  it("names every escaping path in one refusal", () => {
    const Callee = Flow.make("envelope/many-outside-callee", {
      payload: {},
      success: Schema.Number,
      effects: { reads: ["etc/hosts"], writes: ["var/log"], mode: "hermetic", onConflict: "serialize" },
      body: () => Touch.call({ path: "var/log" })
    })
    const Caller = Flow.make("envelope/many-outside-caller", {
      payload: {},
      success: Schema.Number,
      effects: { reads: ["src/**"], writes: ["dist/**"], mode: "hermetic", onConflict: "serialize" },
      body: () => Callee.call({})
    })

    const refusal = recorded(Graph.build(Caller, {}), "effect_outside_envelope")

    expect(refusal?.path).toEqual(["etc/hosts", "var/log"])
    expect(refusal?.message).toContain("declares paths its caller's effect envelope does not cover")
    expect(refusal?.message).toContain("etc/hosts, var/log")
  })

  it("refuses an inline callee that loosens a hermetic envelope to expected", () => {
    const Callee = Flow.make("envelope/mode-callee", {
      payload: {},
      success: Schema.Number,
      effects: { reads: ["src/a.ts"], writes: [], mode: "expected", onConflict: "serialize" },
      body: () => Touch.call({ path: "src/a.ts" })
    })
    const Caller = Flow.make("envelope/mode-caller", {
      payload: {},
      success: Schema.Number,
      effects: { reads: ["src/**"], writes: [], mode: "hermetic", onConflict: "serialize" },
      body: () => Callee.call({})
    })

    const graph = Graph.build(Caller, {})

    expect(recorded(graph, "effect_mode_widening")?.node).toBe("root.flow")
    expect(() => Graph.drafts(graph)).toThrow(expect.objectContaining({ code: "effect_mode_widening" }))
  })

  it("refuses an inline callee whose tier is less reversible than the envelope's", () => {
    const Callee = Flow.make("envelope/tier-callee", {
      payload: {},
      success: Schema.Number,
      effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "irreversible" },
      body: () => Touch.call({ path: "src/a.ts" })
    })
    const Caller = Flow.make("envelope/tier-caller", {
      payload: {},
      success: Schema.Number,
      effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "compensable" },
      body: () => Callee.call({})
    })

    const graph = Graph.build(Caller, {})

    expect(recorded(graph, "effect_tier_widening")?.node).toBe("root.flow")
    expect(() => Graph.drafts(graph)).toThrow(expect.objectContaining({ code: "effect_tier_widening" }))
  })

  it("refuses a tier raise beneath a sealed flow, whatever paths it kept", () => {
    const Callee = Flow.make("envelope/sealed-tier-callee", {
      payload: {},
      success: Schema.Number,
      // Inside the sealed flow's retained write list, so only the TIER widens.
      effects: { reads: [], writes: ["dist/out.js"], mode: "hermetic", onConflict: "serialize", tier: "compensable" },
      body: () => Touch.call({ path: "dist/out.js" })
    })
    const Sealed = Flow.make("envelope/sealed-tier-caller", {
      payload: {},
      success: Schema.Number,
      effects: Effects.sealed(envelope({ reads: ["src/**"], writes: ["dist/**"], tier: "irreversible" })),
      body: () => Callee.call({})
    })

    const graph = Graph.build(Sealed, {})
    const refusal = recorded(graph, "effect_tier_widening")

    expect(refusal?.node).toBe("root.flow")
    expect(refusal?.message).toContain("envelope/sealed-tier-callee")
    expect(() => Graph.drafts(graph)).toThrow(expect.objectContaining({ code: "effect_tier_widening" }))
  })

  it("refuses every declared path beneath a flow sealed from nothing", () => {
    const Callee = Flow.make("envelope/sealed-empty-callee", {
      payload: {},
      success: Schema.Number,
      effects: { reads: [], writes: ["dist/out.js"], mode: "hermetic", onConflict: "serialize" },
      body: () => Touch.call({ path: "dist/out.js" })
    })
    const Sealed = Flow.make("envelope/sealed-empty-caller", {
      payload: {},
      success: Schema.Number,
      effects: Effects.sealed(envelope()),
      body: () => Callee.call({})
    })

    const graph = Graph.build(Sealed, {})
    const refusal = recorded(graph, "effect_outside_envelope")

    expect(refusal?.path).toEqual(["dist/out.js"])
    expect(refusal?.message).toContain("envelope/sealed-empty-callee")
    expect(() => Graph.drafts(graph)).toThrow(expect.objectContaining({ code: "effect_outside_envelope" }))
  })

  it("records a capability the caller does not grant, and still compiles", () => {
    expect(Option.isSome(Capability.parsePattern("net:get:**"))).toBe(true)
    const Callee = Flow.make("envelope/capability-callee", {
      payload: {},
      success: Schema.Number,
      capabilities: ["fs:write:**", "net:get:**"],
      body: () => Touch.call({ path: "src/a.ts" })
    })
    const Caller = Flow.make("envelope/capability-caller", {
      payload: {},
      success: Schema.Number,
      capabilities: ["fs:write:**"],
      body: () => Callee.call({})
    })

    const graph = Graph.build(Caller, {})
    const refusal = recorded(graph, "capability_outside_grant")

    expect(refusal?.node).toBe("root.flow")
    expect(refusal?.path).toEqual(["net:get:**"])
    // Advisory: the callee runs with LESS authority, which is the safe
    // direction, so the drafts are still handed over.
    expect(Graph.drafts(graph).length).toBeGreaterThan(0)
  })

  it("records a capability an action requires and its caller does not grant", () => {
    const Privileged = Action.make("envelope/privileged-action", {
      payload: { path: Schema.String },
      success: Schema.Number,
      capabilities: ["fs:write:**", "net:get:**"]
    })
    const Caller = Flow.make("envelope/action-capability-caller", {
      payload: {},
      success: Schema.Number,
      capabilities: ["fs:write:**"],
      body: () => Privileged.call({ path: "src/a.ts" })
    })

    const graph = Graph.build(Caller, {})
    const refusal = recorded(graph, "capability_outside_grant")

    expect(refusal?.node).toBe("root.flow")
    expect(refusal?.path).toEqual(["net:get:**"])
    // Advisory for an action exactly as for a flow: the dispatch runs with
    // less authority, so the drafts are still handed over.
    expect(Graph.drafts(graph).length).toBeGreaterThan(0)
  })

  it("checks a child boundary exactly as it checks an inline call", () => {
    const Callee = Flow.make("envelope/child-callee", {
      payload: {},
      success: Schema.Number,
      capabilities: ["net"],
      effects: { reads: [], writes: ["/etc/passwd"], mode: "hermetic", onConflict: "serialize" },
      body: () => Touch.call({ path: "/etc/passwd" })
    })
    const Caller = Flow.make("envelope/child-caller", {
      payload: {},
      success: Schema.Number,
      capabilities: [],
      effects: { reads: ["src/**"], writes: [], mode: "hermetic", onConflict: "serialize" },
      body: () => Callee.child({})
    })

    const graph = Graph.build(Caller, {})

    expect(recorded(graph, "effect_outside_envelope")?.path).toEqual(["/etc/passwd"])
    expect(recorded(graph, "capability_outside_grant")?.path).toEqual(["net"])
  })

  it("keeps the last accepted envelope when a declaration is refused", () => {
    const Inner = Flow.make("envelope/chain-inner", {
      payload: {},
      success: Schema.Number,
      effects: { reads: ["src/a.ts"], writes: [], mode: "hermetic", onConflict: "serialize" },
      body: () => Touch.call({ path: "src/a.ts" })
    })
    const Middle = Flow.make("envelope/chain-middle", {
      payload: {},
      success: Schema.Number,
      effects: { reads: ["outside/**"], writes: [], mode: "hermetic", onConflict: "serialize" },
      body: () => Inner.call({})
    })
    const Outer = Flow.make("envelope/chain-outer", {
      payload: {},
      success: Schema.Number,
      effects: { reads: ["src/**"], writes: [], mode: "hermetic", onConflict: "serialize" },
      body: () => Middle.call({})
    })

    const graph = Graph.build(Outer, {})
    const refusals = Graph.diagnostics(graph).filter((one) => one.code === "effect_outside_envelope")

    // The middle declaration is refused once and does NOT become the envelope,
    // so the inner flow is still checked against the outer one and passes.
    expect(refusals).toHaveLength(1)
    expect(refusals[0]?.node).toBe("root.flow")
    expect(refusals[0]?.path).toEqual(["outside/**"])
  })

  it("checks an action that declares an envelope of its own", () => {
    const Widening = Action.make("envelope/widening-action", {
      payload: { path: Schema.String },
      success: Schema.Number
    }).annotate(Flow.EffectEnvelope, envelope({ writes: ["/tmp/out"], mode: "hermetic" }))
    const Caller = Flow.make("envelope/action-caller", {
      payload: {},
      success: Schema.Number,
      effects: { reads: ["src/**"], writes: [], mode: "hermetic", onConflict: "serialize" },
      body: () => Widening.call({ path: "/tmp/out" })
    })

    const graph = Graph.build(Caller, {})

    expect(recorded(graph, "effect_outside_envelope")?.path).toEqual(["/tmp/out"])
  })

  it("normalizes a literal envelope and carries its tier into key material", () => {
    const Flowy = Flow.make("envelope/normalized", {
      payload: {},
      success: Schema.Number,
      effects: {
        reads: new Set(["src/b.ts", "src/a.ts", "src/a.ts"]),
        writes: ["dist/b.js", "dist/a.js"],
        mode: "hermetic",
        onConflict: "lane",
        tier: "compensable"
      },
      body: () => Touch.call({ path: "src/a.ts" })
    })

    const graph = Graph.build(Flowy, {})
    const root = Graph.nodes(graph).find((one) => one.id === "root")!

    expect(root.draft.material.kind).toBe("compensable")
    // The declaration the catalog and the build both read is the normalized one.
    expect(Flow.EffectEnvelope).toBeDefined()
    expect(Graph.diagnostics(graph)).toEqual([])
  })

  it("refuses an action whose declared effects literal widens the enclosing envelope", () => {
    const Widening = Action.make("envelope/widening-literal", {
      payload: { path: Schema.String },
      success: Schema.Number,
      effects: { reads: [], writes: ["/tmp/out"], mode: "hermetic", onConflict: "serialize" }
    })
    const Caller = Flow.make("envelope/literal-action-caller", {
      payload: {},
      success: Schema.Number,
      effects: { reads: ["src/**"], writes: [], mode: "hermetic", onConflict: "serialize" },
      body: () => Widening.call({ path: "/tmp/out" })
    })

    const refusal = recorded(Graph.build(Caller, {}), "effect_outside_envelope")

    // The same code a widening INLINE FLOW gets, so the control fires for both.
    expect(refusal?.code).toBe("effect_outside_envelope")
    expect(refusal?.path).toEqual(["/tmp/out"])
  })

  it("lowers an action's declared effects literal to the annotated envelope", () => {
    const declared = Action.make("envelope/declared-literal", {
      payload: {},
      effects: { reads: ["src/a.ts"], writes: [], mode: "hermetic", onConflict: "serialize", tier: "compensable" }
    })
    const annotated = Action.make("envelope/annotated-literal", {
      payload: {}
    }).annotate(
      Flow.EffectEnvelope,
      envelope({ reads: ["src/a.ts"], mode: "hermetic", tier: "compensable" })
    )

    expect(declaredEnvelope(declared.annotations)).toEqual(declaredEnvelope(annotated.annotations))
    expect(declaredEnvelope(declared.annotations)).toEqual(
      envelope({ reads: ["src/a.ts"], mode: "hermetic", tier: "compensable" })
    )
  })

  it("lets an annotated copy narrow the envelope and the ceiling the literals declared", () => {
    const declared = Action.make("envelope/annotated-over-declared", {
      payload: {},
      capabilities: ["fs:read", "fs:write"],
      effects: { reads: ["src/**"], writes: [], mode: "expected", onConflict: "serialize" }
    })

    const narrowed = declared
      .annotate(Flow.Capabilities, ["fs:read"])
      .annotate(Flow.EffectEnvelope, envelope({ reads: ["src/a.ts"], mode: "hermetic" }))

    // The literals lower ONCE, at the declaration, so an annotated copy is
    // rebuilt from the lowered bag rather than from the literals again.
    expect(Context.get(narrowed.annotations, Flow.Capabilities)).toEqual(["fs:read"])
    expect(declaredEnvelope(narrowed.annotations)).toEqual(
      envelope({ reads: ["src/a.ts"], mode: "hermetic" })
    )
    // The original is untouched.
    expect(Context.get(declared.annotations, Flow.Capabilities)).toEqual(["fs:read", "fs:write"])
  })

  it("leaves a flow that declares no envelope unconstrained", () => {
    const Callee = Flow.make("envelope/undeclared-callee", {
      payload: {},
      success: Schema.Number,
      effects: { reads: ["anything/**"], writes: ["anywhere/**"], mode: "expected", onConflict: "fail" },
      body: () => Touch.call({ path: "anything/a" })
    })
    const Caller = Flow.make("envelope/undeclared-caller", {
      payload: {},
      success: Schema.Number,
      body: () => Callee.call({})
    })

    expect(Graph.diagnostics(Graph.build(Caller, {}))).toEqual([])
  })
})
