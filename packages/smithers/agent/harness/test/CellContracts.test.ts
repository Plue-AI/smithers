import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema, SchemaRepresentation } from "effect"
import * as Cell from "../src/Cell.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"

// Current encoded records, independent of schema constructors. The absent
// failure code is a current record, not a newly invented success default.
const results = [
  { outcome: "success", value: { count: 2 } },
  { outcome: "failure", value: null, message: "flow refused" },
  { outcome: "failure", value: null, code: "timeout", message: "deadline" }
] as const
const transitions = [
  { _tag: "continue" },
  { _tag: "continue", justification: "waiting for check" },
  { _tag: "complete", output: "done" },
  { _tag: "park", reason: "waiting-input", message: "need answer" },
  { _tag: "park", reason: "waiting-event", message: "need event" },
  { _tag: "park", reason: "waiting-quota", message: "need capacity" }
] as const

describe("cell state and result contracts", () => {
  it.effect("decodes current result and transition fixtures with identical encoded fields", () =>
    Effect.gen(function*() {
      for (const result of results) {
        expect(yield* Cell.decodeCallResult(JSON.parse(JSON.stringify(result)))).toEqual(result)
        expect(Schema.encodeSync(Schema.toCodecJson(Cell.CallResult))(new Cell.CallResult(result))).toEqual(result)
      }
      for (const transition of transitions) {
        expect(yield* Cell.decodeTransition(transition)).toEqual(transition)
        const outcome = { _tag: "settled", transition }
        expect(yield* Cell.decodeOutcome(outcome)).toEqual(outcome)
      }
      for (
        const outcome of [
          { _tag: "raised", name: "Error", message: "boom" },
          { _tag: "rejected", code: "compile_failed", message: "syntax" }
        ]
      ) expect(yield* Cell.decodeOutcome(outcome)).toEqual(outcome)
    }))

  it.effect("refuses contradictory success, outcome and transition records with causes", () =>
    Effect.gen(function*() {
      for (
        const value of [
          { outcome: "success", value: null, code: "timeout" },
          { outcome: "success", value: new Error("not encoded") },
          { outcome: "failure", value: null, code: "invented" },
          { outcome: "success" }
        ]
      ) {
        const error = yield* Effect.flip(Cell.decodeCallResult(value))
        expect(error.code).toBe("engine_failed")
        expect(error.cause).toBeDefined()
      }
      for (
        const value of [
          { _tag: "continue", output: "not complete" },
          { _tag: "complete" },
          { _tag: "park", message: "missing reason" },
          { _tag: "park", reason: "unknown", message: "bad" }
        ]
      ) expect((yield* Effect.flip(Cell.decodeTransition(value))).cause).toBeDefined()
      for (
        const value of [
          { _tag: "settled", transition: { _tag: "continue" }, code: "compile_failed" },
          { _tag: "raised", name: "Error", message: "bad", transition: { _tag: "complete", output: "done" } },
          { _tag: "rejected", message: "missing code" }
        ]
      ) expect((yield* Effect.flip(Cell.decodeOutcome(value))).cause).toBeDefined()
      const mutated = Object.assign(new Cell.Settled({ transition: new Cell.Continue({}) }), { code: "compile_failed" })
      expect((yield* Effect.flip(Cell.decodeOutcome(mutated))).cause).toBeDefined()
      const cause = new Error("accessor")
      const error = yield* Effect.flip(Cell.decodeCallResult({
        get outcome() {
          throw cause
        }
      }))
      expect(error.cause).toBe(cause)
    }))

  it("serializes the result schema used by sealed action keys", () => {
    const document = Schema.toRepresentation(Cell.CallResult)
    const encoded = SchemaRepresentation.toJson(document)
    const restored = SchemaRepresentation.fromJson(JSON.parse(JSON.stringify(encoded)))
    expect(SchemaRepresentation.toJson(restored)).toEqual(encoded)
  })

  it("rejects success failure-codes at the existing constructor and schema", () => {
    expect(() => {
      // @ts-expect-error A successful call cannot carry a failure code.
      return new Cell.CallResult({ outcome: "success", value: null, code: "timeout" })
    }).toThrow()
    expect(() => Schema.decodeUnknownSync(Cell.CallResult)({ outcome: "success", value: null, code: "timeout" }))
      .toThrow()
    const valid = new Cell.CallResult({ outcome: "failure", value: null, code: "timeout" })
    expect(valid.outcome).toBe("failure")
  })

  it.effect("captures real sandbox results and refuses a malformed host settlement", () =>
    Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.make
      const realm = yield* sandbox.openRealm!({ flows: {} })
      const frame = yield* realm.evaluate({
        cell: Cell.source("const result = await ctx.call(\"probe\", {}); ctx.done(String(result.count))"),
        frame: 0,
        call: () => Effect.succeed(new Cell.CallResult(results[0]))
      })
      const encoded = Schema.encodeSync(Schema.toCodecJson(Cell.Outcome))(frame.outcome)
      expect(encoded).toEqual({ _tag: "settled", transition: { _tag: "complete", output: "2", value: "2" } })
      expect(yield* Cell.decodeOutcome(encoded)).toEqual(frame.outcome)

      const invalid = yield* Effect.exit(realm.evaluate({
        cell: Cell.source("await ctx.call(\"probe\", {}); ctx.done(\"must not complete\")"),
        frame: 1,
        // A remote host may return plain JSON that bypassed the constructor.
        call: () => Effect.succeed({ outcome: "success", value: null, code: "timeout" } as Cell.CallResult)
      }))
      expect(invalid._tag).toBe("Failure")
    }).pipe(Effect.scoped))
})
