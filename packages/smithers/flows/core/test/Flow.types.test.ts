import * as Flow from "@smthrs/core/Flow"
import { Action, Flow as Canonical } from "@smthrs/flow"
import * as Schema from "effect/Schema"
import { describe, expectTypeOf, it } from "vitest"
import * as Node from "../src/Node.ts"

interface BodyError {
  readonly _tag: "BodyError"
}

const BodyFailure = Schema.Struct({ _tag: Schema.Literal("BodyError") })

describe("Flow types", () => {
  it("exposes the same canonical flow type through the deprecated adapter", () => {
    // The adapter historically widens its tag. Compare like-for-like rather
    // than promising that it preserves a literal tag it never retained.
    const tag: string = "types/canonical-parity"
    const Input = Schema.Struct({ text: Schema.String })
    const action = Action.make("types/parity-action", {
      payload: Input,
      success: Schema.Number,
      error: BodyFailure
    })
    const adapted = Flow.make({
      name: tag,
      input: Input,
      output: Schema.Number,
      error: BodyFailure,
      body: (payload) => action.call(payload)
    })
    const canonical = Canonical.make(tag, {
      payload: adapted.flow.payloadSchema,
      success: Schema.Number,
      error: BodyFailure,
      body: (payload) => action.call(payload)
    })
    expectTypeOf(adapted.flow).toEqualTypeOf<typeof canonical>()
    expectTypeOf(adapted.call({ text: "input" })).toEqualTypeOf<ReturnType<typeof canonical.call>>()
    expectTypeOf(adapted.flow.execute).toEqualTypeOf<typeof canonical.execute>()
    expectTypeOf(adapted.flow.payloadSchema.Type).toEqualTypeOf<typeof Input.Type>()
    expectTypeOf(adapted.call({ text: "input" })).toEqualTypeOf<
      Node.Node<number, BodyError, Action.Requirement<"types/parity-action">>
    >()

    const scalar = Flow.make({
      name: tag,
      input: Schema.String,
      output: Schema.Number,
      body: (text) => Node.succeed(text.length)
    })
    const scalarCanonical = Canonical.make(tag, {
      payload: scalar.flow.payloadSchema,
      success: Schema.Number,
      body: ({ input }) => Node.succeed(input.length)
    })
    expectTypeOf(scalar.flow).toEqualTypeOf<typeof scalarCanonical>()
    expectTypeOf(scalar.call("input")).toEqualTypeOf<ReturnType<typeof scalarCanonical.call>>()
    expectTypeOf(scalar.flow.payloadSchema.Type).toEqualTypeOf<{ readonly input: string }>()
    // @ts-expect-error the adapter still accepts its declared primitive shape
    scalar.call({ input: "input" })
    // @ts-expect-error the canonical declaration requires its struct payload
    scalarCanonical.call("input")
  })

  it("exports consumer-nameable make options from the public Flow module", () => {
    const options: Flow.MakeOptions<typeof Schema.String, typeof Schema.Number, typeof BodyFailure, never> = {
      name: "types/options",
      input: Schema.String,
      output: Schema.Number,
      error: BodyFailure,
      body: (input) => Node.succeed(input.length) as Node.Node<number, BodyError>
    }
    const flow = Flow.make(options)

    expectTypeOf(flow).toEqualTypeOf<
      Flow.Flow<typeof Schema.String, typeof Schema.Number, typeof BodyFailure, never>
    >()
  })

  it("infers body input from the sibling input schema and calls in the declared shape", () => {
    const Input = Schema.Struct({ id: Schema.String, count: Schema.Number })
    const Output = Schema.Struct({ accepted: Schema.Boolean })
    const flow = Flow.make({
      name: "types/body",
      input: Input,
      output: Output,
      body: (input) => {
        expectTypeOf(input).toEqualTypeOf<typeof Input.Type>()
        return Node.succeed({ accepted: input.count > 0 })
      }
    })

    expectTypeOf(flow.call({ id: "a", count: 1 })).toEqualTypeOf<Node.Node<typeof Output.Type, never, never>>()

    // @ts-expect-error count must be a number
    flow.call({ id: "a", count: "1" })
  })

  it("keeps input schemas invariant in both assignability directions", () => {
    const A = Schema.Struct({ a: Schema.String })
    const AB = Schema.Struct({ a: Schema.String, b: Schema.Number })
    const flowA = Flow.make({
      name: "types/a",
      input: A,
      output: Schema.Void,
      body: () => Node.succeed(undefined)
    })
    const flowAB = Flow.make({
      name: "types/ab",
      input: AB,
      output: Schema.Void,
      body: () => Node.succeed(undefined)
    })

    // @ts-expect-error Flow input schemas are invariant
    const acceptsAB: Flow.Flow<typeof AB, typeof Schema.Void, typeof Schema.Never, never> = flowA
    // @ts-expect-error Flow input schemas are invariant
    const acceptsA: Flow.Flow<typeof A, typeof Schema.Void, typeof Schema.Never, never> = flowAB

    expectTypeOf(acceptsAB).toEqualTypeOf<Flow.Flow<typeof AB, typeof Schema.Void, typeof Schema.Never, never>>()
    expectTypeOf(acceptsA).toEqualTypeOf<Flow.Flow<typeof A, typeof Schema.Void, typeof Schema.Never, never>>()
  })

  it("uses Flow.Any for heterogeneous concrete flow collections", () => {
    const text = Flow.make({
      name: "types/text",
      input: Schema.String,
      output: Schema.Number,
      body: (input) => Node.succeed(input.length)
    })
    const toggle = Flow.make({
      name: "types/toggle",
      input: Schema.Boolean,
      output: Schema.String,
      body: (input) => Node.succeed(String(input))
    })
    const flows: ReadonlyArray<Flow.Any> = [text, toggle]

    expectTypeOf(flows).toMatchTypeOf<ReadonlyArray<Flow.Any>>()
    expectTypeOf<Flow.Input<typeof text>>().toEqualTypeOf<string>()
    expectTypeOf<Flow.Output<typeof toggle>>().toEqualTypeOf<string>()
    expectTypeOf<Flow.Error<typeof text>>().toEqualTypeOf<never>()
  })

  it("defaults the schemas a signature omits and owes its action's requirement", () => {
    const declared = Flow.make({ name: "types/declared" })

    expectTypeOf(declared).toEqualTypeOf<
      Flow.Flow<
        typeof Schema.Void,
        typeof Schema.Unknown,
        typeof Schema.Never,
        Action.Requirement<string>
      >
    >()
    expectTypeOf(declared.call(undefined)).toEqualTypeOf<
      Node.Node<unknown, never, Action.Requirement<string>>
    >()
    // A signature with a body carries no action to implement.
    expectTypeOf(
      Flow.make({ name: "types/bodied", body: () => Node.succeed("value") }).action
    ).toEqualTypeOf<
      Action.Declared<
        string,
        Flow.Payload<typeof Schema.Void>,
        typeof Schema.Unknown,
        typeof Schema.Never,
        never
      > | undefined
    >()
  })

  it("wraps a non-struct payload and passes a struct one through", () => {
    const Input = Schema.Struct({ id: Schema.String })

    expectTypeOf<Flow.Payload<typeof Input>["Type"]>().toEqualTypeOf<{ readonly id: string }>()
    expectTypeOf<Flow.Payload<typeof Schema.String>["Type"]>().toEqualTypeOf<{ readonly input: string }>()
  })
})
