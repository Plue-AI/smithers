import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Sandbox from "../src/Sandbox.ts"
import * as StructuredOutput from "../src/StructuredOutput.ts"

describe("typed completion persistence", () => {
  const codec = Schema.toCodecJson(Cell.Transition)

  it("reports an exhausted typed mismatch with original diagnostics", () => {
    const result = Effect.runSync(Effect.result(
      StructuredOutput.decode(Schema.String, "12", { corrections: 0, limit: 0 }, 12)
    ))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("correction_exhausted")
      expect(result.failure.issues[0]).toMatchObject({ code: "invalid_type", message: "Expected string" })
    }
  })

  it("replays completion records written before typed values", () => {
    const encoded = { _tag: "complete", output: "old answer" }
    const decoded = Schema.decodeUnknownSync(codec)(encoded)
    expect(decoded._tag).toBe("complete")
    expect(decoded).toMatchObject(encoded)
    expect((decoded as Cell.Complete).value).toBeUndefined()
    expect(Schema.encodeSync(codec)(decoded)).toEqual(encoded)
  })

  it.each([null, "12", { approved: true }, [1, false]])("roundtrips a typed completion (%j)", (value) => {
    const transition = Sandbox.replTransition({ _tag: "Done", output: Cell.renderText(value), value }, undefined)
    const decoded = Schema.decodeUnknownSync(codec)(Schema.encodeSync(codec)(transition))
    expect(decoded._tag).toBe("complete")
    expect((decoded as Cell.Complete).value).toEqual(value)
  })

  it.each([null, "12", "\"hello\"", 12, false, { approved: true }, [1, false]])(
    "records ctx.done's original JSON value (%j)",
    async (value) => {
      const outcome = await Effect.gen(function*() {
        const sandbox = yield* Sandbox.Sandbox
        const realm = yield* sandbox.openRealm!({ flows: {} })
        const frame = yield* realm.evaluate({
          cell: Cell.source(`ctx.done(${JSON.stringify(value)})`),
          frame: 0,
          call: () => Effect.die("no flow call expected")
        })
        return frame.outcome
      }).pipe(Effect.provide(QuickJSSandbox.layer), Effect.scoped, Effect.runPromise)
      expect(outcome._tag).toBe("settled")
      const transition = (outcome as Cell.Settled).transition
      expect(transition._tag).toBe("complete")
      expect((transition as Cell.Complete).value).toEqual(value)
      expect((transition as Cell.Complete).output).toBe(Cell.renderText(value))
    }
  )
})
