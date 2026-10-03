/**
 * A `@smthrs/std` signature, bound and called through the path the agent uses.
 *
 * `@smthrs/harness` `FlowBinding.Declared` is a structural interface: it names
 * six fields and imports no flow constructor. `@smthrs/core`'s `Flow.make`
 * answers `@smthrs/flow` values, so "the lowered value still satisfies it" is a
 * claim about a shape nothing checks at the seam. This asserts it against a
 * real declaration rather than a fixture shaped to fit, and then runs one call
 * end to end through `CellCalls`, which is the resolver `@smthrs/agent`'s cell
 * loop dispatches every `ctx.call` through.
 */
import * as Cell from "@smthrs/harness/Cell"
import * as CellCalls from "@smthrs/harness/CellCalls"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Registry from "@smthrs/registry/Registry"
import * as Glob from "@smthrs/std/Glob"
import { Effect, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"

const callOf = (descriptor: FlowBinding.Binding["descriptor"], input: Schema.Json): Cell.Call =>
  new Cell.Call({
    flowName: descriptor.name,
    input,
    capabilities: descriptor.capabilities,
    effects: descriptor.effects,
    placement: descriptor.placement,
    identity: new Cell.CallIdentity({
      session: "session-1",
      frame: 0,
      cell: "cell-digest",
      ordinal: 0,
      declaration: Cell.declarationDigest(descriptor),
      layers: []
    })
  })

describe("a lowered std signature as a harness binding", () => {
  it("satisfies the structural declaration the binding contract reads", () => {
    // The six fields `FlowBinding.Declared` names, plus the two schemas
    // `FlowBinding.Options.flow` adds. Read off the signature itself, so the
    // case fails if the sugar stops projecting any one of them.
    const declared: FlowBinding.Declared = Glob.flow
    expect(declared.name).toBe(Glob.name)
    expect(declared.description).toBe(Glob.description)
    expect(declared.capabilities).toEqual(Glob.capabilities)
    expect(declared.effects).toEqual(Glob.effects)
    expect(Glob.flow.input).toBe(Glob.Input)
    expect(Glob.flow.output).toBe(Glob.Output)
  })

  it("projects the declaration into a descriptor and runs one call through CellCalls", async () => {
    const seen: Array<unknown> = []
    const binding = FlowBinding.make({
      flow: Glob.flow,
      handler: (input) =>
        Effect.sync(() => {
          seen.push(input)
          return { paths: ["src/Glob.ts"], total: 1, truncated: false }
        })
    })

    expect(binding.descriptor.name).toBe(Glob.name)
    expect(binding.descriptor.capabilities).toEqual(Glob.capabilities)
    // A signature that declared `sealed` keeps it; the conservative
    // `irreversible` default is for one that declared no envelope at all.
    expect(binding.descriptor.effects.tier).toBe("sealed")

    const catalog = Result.getOrThrow(FlowBinding.catalogResult([binding]))
    const result = await Effect.runPromise(
      CellCalls.make({ registry: FlowBinding.registry(Registry.makeNoop({}), catalog), catalog })
        .run(callOf(binding.descriptor, { pattern: "*.ts" }))
        .pipe(Effect.orDie)
    )

    expect(result).toMatchObject({
      outcome: "success",
      value: { paths: ["src/Glob.ts"], total: 1, truncated: false }
    })
    // Decoded through the signature's own `input` schema before the handler
    // saw it, which is what makes the declaration the call's contract.
    expect(seen).toEqual([{ pattern: "*.ts" }])
  })

  it("keeps a non-struct input unwrapped for a caller and wraps it only inside the plan", async () => {
    // A flow payload is a struct, so a signature that declares something else
    // is wrapped as one `input` field. The wrap belongs to the plan: a cell
    // passes the value the signature declared, and a binding decodes it with
    // that same schema. Two wraps would make the declared contract unreachable.
    const scalar = {
      capabilities: [],
      effects: undefined,
      name: "scalar",
      description: "Takes one string.",
      input: Schema.String,
      output: Schema.Number
    } as const
    expect(scalar.input).toBe(Schema.String)
    expect(Object.keys(scalar.flow.payloadSchema.fields)).toEqual(["input"])

    const seen: Array<unknown> = []
    const binding = FlowBinding.make({
      flow: scalar,
      handler: (input) => Effect.sync(() => (seen.push(input), input.length))
    })
    const catalog = Result.getOrThrow(FlowBinding.catalogResult([binding]))
    const result = await Effect.runPromise(
      CellCalls.make({ registry: FlowBinding.registry(Registry.makeNoop({}), catalog), catalog })
        .run(callOf(binding.descriptor, "four"))
        .pipe(Effect.orDie)
    )

    expect(result).toMatchObject({ outcome: "success", value: 4 })
    expect(seen).toEqual(["four"])
  })
})
