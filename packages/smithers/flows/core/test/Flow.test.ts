import { Action, Flow as Durable, Graph } from "@smthrs/flow"
import * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import * as Annotations from "../src/Annotations.ts"
import * as Effects from "../src/Effects.ts"
import * as Flow from "../src/Flow.ts"
import * as Node from "../src/Node.ts"
import * as Placement from "../src/Placement.ts"

const Payload = Schema.Struct({ text: Schema.String })

/*
 * A signature declared at the top level of this file, so the line it reports
 * is a line a reader of this file can see.
 *
 * `Flow.make` here is sugar: it lowers through `@smthrs/core`'s own source and
 * then through `@smthrs/flow`'s, so two framework frames sit between this call
 * and the capture that records where the declaration was written. The case
 * below is that neither of them is what gets recorded.
 */
const Provenance = Flow.make({ name: "core/provenance", input: Payload, output: Schema.Number })

const callsTo = (graph: Graph.Graph, tag: string): ReadonlyArray<Graph.GraphNode> =>
  Graph.nodes(graph).filter((node) =>
    (node.kind === "FlowCall" && (node.ast as { readonly flow?: string }).flow === tag) ||
    (node.kind === "ActionCall" && (node.ast as { readonly action?: string }).action === tag)
  )

describe("Flow.make", () => {
  it("refuses a signature that declares no name", () => {
    expect(() => Flow.make({ input: Schema.String })).toThrow(TypeError)
    expect(() => Flow.make({ name: "", input: Schema.String })).toThrow(
      "Flow.make requires a name: it is the tag the flow, its action, and every plan that records a call carry"
    )
  })

  it("lowers a body-less signature to a declared action and the flow that calls it once", () => {
    const signature = Flow.make({
      name: "core/declared",
      description: "one sentence",
      input: Payload,
      output: Schema.Number
    })

    expect(Flow.isFlow(signature)).toBe(true)
    expect(signature.name).toBe("core/declared")
    expect(signature.action?.name).toBe("core/declared")
    expect(signature.flow._tag).toBe("core/declared")
    expect(signature.flow.description).toBe("one sentence")
    expect(Durable.isFlow(signature.flow)).toBe(true)
    // The action is what a host supplies the implementation for, and the flow
    // beside it is what a caller splices, so the pair carries one declaration.
    expect(signature.action?.payloadSchema).toBe(signature.flow.payloadSchema)
    expect(signature.action?.successSchema).toBe(signature.output)
    expect(signature.action?.errorSchema).toBe(signature.error)
  })

  it("carries a struct input as the payload and wraps any other schema", () => {
    const struct = Flow.make({ name: "core/struct", input: Payload })
    const scalar = Flow.make({ name: "core/scalar", input: Schema.String })

    expect(struct.flow.payloadSchema).toBe(Payload)
    expect(struct.input).toBe(Payload)
    expect(Object.keys(scalar.flow.payloadSchema.fields)).toEqual(["input"])
    expect(scalar.flow.payloadSchema.fields.input).toBe(Schema.String)
    // The declared schema is what a consumer reads back, wrapper or not.
    expect(scalar.input).toBe(Schema.String)
  })

  it("passes a call in the declared shape and wraps it once on the way in", () => {
    const struct = Flow.make({ name: "core/call-struct", input: Payload, output: Schema.String })
    const scalar = Flow.make({ name: "core/call-scalar", input: Schema.String, output: Schema.String })

    const structCall = Graph.nodes(Graph.build(struct.call({ text: "written" })))
    const scalarCall = Graph.nodes(Graph.build(scalar.call("written")))

    expect(callsTo(Graph.build(struct.call({ text: "written" })), "core/call-struct")[0]?.payload).toEqual({
      text: "written"
    })
    expect(callsTo(Graph.build(scalar.call("written")), "core/call-scalar")[0]?.payload).toEqual({
      input: "written"
    })
    // Both spliced: a call reaches the action beneath the one-call flow.
    expect(structCall.map((node) => node.kind)).toContain("ActionCall")
    expect(scalarCall.map((node) => node.kind)).toContain("ActionCall")
  })

  it("defaults the three schemas a signature may omit", () => {
    const signature = Flow.make({ name: "core/defaults" })

    expect(signature.input).toBe(Schema.Void)
    expect(signature.output).toBe(Schema.Unknown)
    expect(signature.error).toBe(Schema.Never)
  })

  it("keeps a declared body and hands it the declared input shape", () => {
    const seen: Array<unknown> = []
    const signature = Flow.make({
      name: "core/body",
      input: Schema.String,
      output: Schema.String,
      body: (input) => {
        seen.push(input)
        return Node.succeed(input)
      }
    })

    // A signature with a body needs no action: the body IS the implementation.
    expect(signature.action).toBeUndefined()
    // The body runs at plan time, once, with the value the caller passed.
    expect(seen).toEqual([])
    const graph = Graph.build(signature.flow, { input: "written" })
    expect(seen).toEqual(["written"])
    // Dependency order: the body's node, then the entry call that depends on it.
    expect(Graph.nodes(graph).map((node) => node.kind)).toEqual(["Succeed", "FlowCall"])
  })

  it("hands a struct body its payload without a wrapper", () => {
    const seen: Array<unknown> = []
    const signature = Flow.make({
      name: "core/body-struct",
      input: Payload,
      output: Schema.String,
      body: (input) => {
        seen.push(input)
        return Node.succeed(input.text)
      }
    })

    Graph.build(signature.flow, { text: "written" })

    expect(seen).toEqual([{ text: "written" }])
  })

  it("sorts and deduplicates capabilities and lowers them onto the flow", () => {
    const signature = Flow.make({
      name: "core/capable",
      capabilities: ["write", "read", "write"]
    })

    expect(signature.capabilities).toEqual(["read", "write"])
    expect(Option.getOrUndefined(Context.getOption(signature.annotations, Durable.Capabilities))).toEqual([
      "read",
      "write"
    ])
  })

  it("lowers a declared envelope onto the one effects annotation key", () => {
    const envelope = Effects.make({
      reads: ["src"],
      writes: ["dist"],
      mode: "expected",
      onConflict: "serialize"
    })
    const signature = Flow.make({ name: "core/effects", effects: envelope })

    expect(signature.effects).toBe(envelope)
    expect(Option.getOrUndefined(Context.getOption(signature.annotations, Annotations.Effects))).toEqual(envelope)
    expect(Annotations.Effects).toBe(Durable.EffectEnvelope)
  })

  it("dispatches an undeclared tier as irreversible and a declared one as declared", () => {
    const undeclared = Flow.make({ name: "core/tier-undeclared" })
    const declared = Flow.make({
      name: "core/tier-declared",
      effects: Effects.make({ reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" })
    })

    // A signature that never stated its tier must not content-share another
    // run's result, so it is irreversible rather than `@smthrs/flow`'s `sealed`
    // default.
    expect(undeclared.action?.tier).toBe("irreversible")
    expect(declared.action?.tier).toBe("sealed")
  })

  it("records advisory model, collaborator, and prompt metadata and snapshots the array", () => {
    const collaborators: Array<Flow.Reference> = ["helper"]
    const signature = Flow.make({
      name: "core/advisory",
      model: "smart",
      flows: collaborators,
      prompt: "Answer exactly."
    })

    collaborators.push("mutated-later")

    expect(signature.model).toBe("smart")
    expect(signature.flows).toEqual(["helper"])
    expect(signature.prompt).toBe("Answer exactly.")
    expect(Flow.make({ name: "core/no-collaborators" }).flows).toBeUndefined()
  })

  it("records the line the caller declared it on, not one inside the sugar", () => {
    const built = Graph.build(Provenance.flow, { text: "hi" })
    const flowCall = Graph.nodes(built).find((node) => node.kind === "FlowCall")
    const actionCall = Graph.nodes(built).find((node) => node.kind === "ActionCall")

    // Both halves of the lowered pair — the flow a caller splices and the
    // action a host implements — name the author's file and the line the
    // signature is written on, above.
    expect(flowCall?.declaredAt?.path.endsWith("core/test/Flow.test.ts")).toBe(true)
    expect(flowCall?.declaredAt?.line).toBe(23)
    expect(actionCall?.declaredAt?.path).toBe(flowCall?.declaredAt?.path)
    expect(actionCall?.declaredAt?.line).toBe(23)
    // The frames this sugar itself occupies are the ones that must not be
    // reported: a site inside `@smthrs/core` or `@smthrs/flow` would name one
    // line for every signature the process ever declared.
    expect(flowCall?.declaredAt?.path).not.toContain("/flows/core/src/")
    expect(flowCall?.declaredAt?.path).not.toContain("/flows/flow/src/")
  })
})

describe("Flow combinators", () => {
  const original = Flow.make({
    name: "core/original",
    description: "the declaration every combinator rebuilds",
    input: Payload,
    output: Schema.String,
    capabilities: ["net"],
    model: "smart",
    flows: ["helper"],
    prompt: "P"
  })

  it("returns fresh values and leaves the original alone", () => {
    const placed = original.pipe(Flow.within(Placement.sandbox({ profile: "test" })))

    for (const variant of [placed]) {
      expect(variant).not.toBe(original)
      expect(variant.name).toBe("core/original")
      expect(variant.description).toBe("the declaration every combinator rebuilds")
      expect(variant.model).toBe("smart")
      expect(variant.flows).toEqual(["helper"])
      expect(variant.prompt).toBe("P")
      expect(variant.flow._tag).toBe("core/original")
    }
    expect(original.capabilities).toEqual(["net"])
    expect(original.effects).toBeUndefined()
    expect(Option.isNone(Annotations.getOption(original.annotations, Annotations.Placement))).toBe(true)
    expect(Option.getOrUndefined(Annotations.getOption(placed.annotations, Annotations.Placement))).toEqual(
      Placement.sandbox({ profile: "test" })
    )
  })

  it("attaches a typed annotation without disturbing the declared ones", () => {
    const Bank = Context.Service<{ readonly bank: string }>("test/Flow/Bank")
    const direct = Flow.annotate(original, Bank, { bank: "one" })
    const piped = original.pipe(Flow.annotate(Bank, { bank: "two" }))

    expect(Option.isNone(Annotations.getOption(original.annotations, Bank))).toBe(true)
    expect(Option.getOrUndefined(Annotations.getOption(direct.annotations, Bank))).toEqual({ bank: "one" })
    expect(Option.getOrUndefined(Annotations.getOption(piped.annotations, Bank))).toEqual({ bank: "two" })
    // The declared capability ceiling survives the rebuild.
    expect(Option.getOrUndefined(Context.getOption(direct.annotations, Durable.Capabilities))).toEqual(["net"])
  })

  it("replaces the collaborators a signature declares and snapshots the replacement", () => {
    const replacements: Array<Flow.Reference> = ["replacement"]
    const rebound = Flow.withFlows(original, replacements)

    replacements.push("late")

    expect(rebound.flows).toEqual(["replacement"])
    expect(original.flows).toEqual(["helper"])
    expect(rebound.capabilities).toEqual(["net"])
    expect(rebound.prompt).toBe("P")
  })

  it("rebuilds the body a signature declared rather than dropping it", () => {
    const signature = Flow.make({
      name: "core/rebuilt-body",
      input: Schema.String,
      output: Schema.String,
      body: (input) => Node.succeed(input)
    })
    const placed = Flow.within(signature, Placement.remote())

    expect(placed.action).toBeUndefined()
    expect(Graph.nodes(Graph.build(placed.flow, { input: "written" })).map((node) => node.kind)).toEqual([
      "Succeed",
      "FlowCall"
    ])
  })
})

describe("Flow.isFlow", () => {
  it("answers for signatures and for everything else", () => {
    expect(Flow.isFlow(Flow.make({ name: "core/guarded" }))).toBe(true)
    expect(Flow.isFlow(Action.make("core/action", { payload: { text: Schema.String } }))).toBe(false)
    expect(Flow.isFlow(undefined)).toBe(false)
  })
})
