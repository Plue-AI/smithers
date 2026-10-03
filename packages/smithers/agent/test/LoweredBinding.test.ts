/** Standard schema/metadata declarations bound through the agent call boundary. */
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

  it("decodes a scalar binding input without a wrapper", async () => {
    // Binding records decode the schema directly, including scalar inputs.
    const scalar = {
      capabilities: [],
      effects: undefined,
      name: "scalar",
      description: "Takes one string.",
      input: Schema.String,
      output: Schema.Number
    } as const
    expect(scalar.input).toBe(Schema.String)
    expect(scalar.output).toBe(Schema.Number)

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
