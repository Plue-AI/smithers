import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { describe, expect, it } from "vitest"
import * as Author from "../src/Author.ts"
import * as Catalog from "../src/Catalog.ts"
import * as JsonBoundary from "../src/JsonBoundary.ts"
import type * as Outcome from "../src/Outcome.ts"
import * as QuickJsRunner from "../src/QuickJsRunner.ts"
import * as Script from "../src/Script.ts"
import * as ScriptRunner from "../src/ScriptRunner.ts"
import { flow, runChain } from "./harness.ts"

const runners: ReadonlyArray<
  readonly [string, Layer.Layer<ScriptRunner.ScriptRunner, ScriptRunner.ScriptFailure>]
> = [
  ["in-process", ScriptRunner.layerInProcess],
  ["quickjs", QuickJsRunner.layer()]
]

const runWith = <E>(
  layer: Layer.Layer<ScriptRunner.ScriptRunner, ScriptRunner.ScriptFailure>,
  text: string,
  handler: (request: ScriptRunner.Request) => Effect.Effect<unknown, E>
): Promise<Outcome.Outcome> =>
  Effect.runPromise(
    Effect.flatMap(ScriptRunner.ScriptRunner, (runner) => runner.run(Script.make(text), handler)).pipe(
      Effect.provide(layer)
    )
  )

const failWith = <E>(
  layer: Layer.Layer<ScriptRunner.ScriptRunner, ScriptRunner.ScriptFailure>,
  text: string,
  handler: (request: ScriptRunner.Request) => Effect.Effect<unknown, E>
): Promise<unknown> =>
  Effect.runPromise(
    Effect.flip(
      Effect.flatMap(ScriptRunner.ScriptRunner, (runner) => runner.run(Script.make(text), handler))
    ).pipe(Effect.provide(layer))
  )

const echo = (request: ScriptRunner.Request): Effect.Effect<unknown> =>
  Effect.succeed({ name: request.name, payload: request.payload })

describe.each(runners)("runner conformance: %s", (_name, layer) => {
  it("settles calls one at a time, in issue order", async () => {
    const outcome = await runWith(
      layer,
      [
        `const [a, b] = await Promise.all([ctx.call("first"), ctx.call("second", 2)])`,
        `const c = await ctx.call("third", { deep: true })`,
        `return done([a, b, c])`
      ].join("\n"),
      echo
    )
    expect(outcome).toEqual({
      _tag: "Done",
      value: [
        { name: "first", payload: null },
        { name: "second", payload: 2 },
        { name: "third", payload: { deep: true } }
      ]
    })
  })

  it("returns to and park outcomes, park defaulting its message", async () => {
    // The digest a script hands to `to` is discarded and re-derived from
    // the text: a script chooses its successor's source, never the replay
    // identity that source is keyed by.
    const to = await runWith(layer, `return to({ text: "next", digest: "FORGED" })`, echo)
    expect(to).toEqual({ _tag: "To", script: Script.make("next") })
    const park = await runWith(layer, `return park("timer")`, echo)
    expect(park).toEqual({ _tag: "Park", reason: { code: "timer", message: "" } })
  })

  it("settles race losers durably", async () => {
    const seen: Array<string> = []
    const handler = (request: ScriptRunner.Request) => {
      seen.push(request.name)
      return echo(request)
    }
    const outcome = await runWith(
      layer,
      `const winner = await Promise.race([ctx.call("a"), ctx.call("b")])\nreturn done(winner)`,
      handler
    )
    expect(outcome).toEqual({ _tag: "Done", value: { name: "a", payload: null } })
    expect(seen).toEqual(["a", "b"])
  })

  it("fails on a script that throws", async () => {
    const error = await failWith(layer, `throw new Error("kaput")`, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toContain("kaput")
  })

  it("fails on a script that does not parse", async () => {
    const error = await failWith(layer, `const const`, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("compile")
  })

  it("fails on a non-outcome return", async () => {
    const error = await failWith(layer, `return { nope: true }`, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("invalid_outcome")
  })

  it("aborts the run on a handler failure and refuses to be swallowed", async () => {
    const seen: Array<string> = []
    const handler = (request: ScriptRunner.Request) => {
      seen.push(request.name)
      return request.name === "boom" ? Effect.fail("handler down") : echo(request)
    }
    const error = await failWith(
      layer,
      [
        `try { await Promise.all([ctx.call("boom"), ctx.call("stale")]) } catch (both) {}`,
        `return done("swallowed")`
      ].join("\n"),
      handler
    )
    expect(error).toBe("handler down")
    expect(seen).toEqual(["boom"])
  })

  it("propagates a synchronous handler throw as a caller defect", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.flatMap(
          ScriptRunner.ScriptRunner,
          (runner) =>
            runner.run(
              Script.make(`await ctx.call("x", null)\nreturn done(null)`),
              () => {
                throw new Error("sync handler boom")
              }
            )
        ).pipe(Effect.provide(layer))
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const cause = (exit as Exit.Failure<unknown, unknown>).cause
    expect(Cause.hasFails(cause)).toBe(false)
    expect(Cause.hasDies(cause)).toBe(true)
    expect(Cause.prettyErrors(cause)[0]?.message).toBe("sync handler boom")
  })

  it("round-trips a missing payload as null and an undefined result as null", async () => {
    const outcome = await runWith(
      layer,
      `const value = await ctx.call("void")\nreturn done([value])`,
      () => Effect.succeed(undefined)
    )
    expect(outcome).toEqual({ _tag: "Done", value: [null] })
  })

  it("treats a bare done() as done(null)", async () => {
    const outcome = await runWith(layer, `return done()`, echo)
    expect(outcome).toEqual({ _tag: "Done", value: null })
  })

  it("rejects a non-string call name identically", async () => {
    const outcome = await runWith(
      layer,
      `const message = await ctx.call(42).catch(function (error) { return error.message })\nreturn done(message)`,
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: "ctx.call expects a call name as its first argument" })
  })

  it("rejects a non-serializable call input identically", async () => {
    const outcome = await runWith(
      layer,
      [
        `const fromFn = await ctx.call("x", function () {}).catch(function (error) { return error.message })`,
        `const fromNaN = await ctx.call("x", NaN).catch(function (error) { return error.message })`,
        `return done([fromFn, fromNaN])`
      ].join("\n"),
      echo
    )
    expect(outcome).toEqual({
      _tag: "Done",
      value: ["ctx.call input must be JSON-serializable", "ctx.call input must be JSON-serializable"]
    })
  })

  it("rejects a non-serializable handler result identically", async () => {
    const outcome = await runWith(
      layer,
      `const message = await ctx.call("big").catch(function (error) { return error.message })\nreturn done(message)`,
      () => Effect.succeed({ count: 10n })
    )
    expect(outcome).toEqual({ _tag: "Done", value: `the "big" call result is not JSON-serializable` })
  })

  it("carries a primitive throw as the failure message", async () => {
    const error = await failWith(layer, `throw "kaput-string"`, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toBe("kaput-string")
  })

  it("reports thrown Error messages identically", async () => {
    const error = await failWith(layer, `throw new Error("kaput")`, echo) as ScriptRunner.ScriptFailure
    expect(error.message).toBe("kaput")
  })

  it("fails a script that awaits something that never settles", async () => {
    const error = await failWith(
      layer,
      `await new Promise(function () {})\nreturn done(null)`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toContain("never settles")
  })

  // Every row here is a value `JSON.stringify` would SILENTLY REWRITE.
  // Laundering one produces a different terminal result than the script
  // wrote — done(NaN) reported as Done(null) — so both bindings refuse
  // before decoding, with the same code and the same message.
  it.each([
    ["a non-finite number", `return done(NaN)`],
    ["an infinity", `return done(Infinity)`],
    ["a function property", `return done({ a: 1, f: function () {} })`],
    ["an undefined property", `return done({ a: 1, u: undefined })`],
    ["a toJSON hook", `return done({ toJSON: function () { return 7 } })`]
  ])("refuses an outcome carrying %s", async (_case, text) => {
    const error = await failWith(layer, text, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("invalid_outcome")
    expect(error.message).toBe(JsonBoundary.unserializableOutcome)
  })

  // Values whose realm-side and host-side treatments used to differ. The
  // QuickJS binding validated in place and then stringified the ORIGINAL, so
  // an accessor decided what actually crossed, a hole became null, and depth
  // was unbounded. Both bindings now build a validated copy and answer the
  // same host boundary.
  it.each([
    ["an array hole", `var a = [1]; a[2] = 3; return done(a)`],
    [
      "a value past the depth bound",
      [
        `var deep = {}`,
        `var head = deep`,
        `for (var i = 0; i < 400; i++) { head.n = {}; head = head.n }`,
        `return done(deep)`
      ].join("\n")
    ]
  ])("refuses an outcome carrying %s", async (_case, text) => {
    const error = await failWith(layer, text, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("invalid_outcome")
    expect(error.message).toBe(JsonBoundary.unserializableOutcome)
  })

  it("never invokes a toJSON hook, however it is defined", async () => {
    // Non-enumerable, so `Object.keys` skips it and the copy drops it. The
    // realm's own `JSON.stringify` would have CALLED it and replaced the
    // whole object with its return value.
    const outcome = await runWith(
      layer,
      [
        `var value = { v: 1 }`,
        `Object.defineProperty(value, "toJSON", { value: function () { return 7 } })`,
        `return done(value)`
      ].join("\n"),
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: { v: 1 } })
  })

  it("reads an outcome's accessors exactly once, so the validated value is the one that crosses", async () => {
    // The old QuickJS path validated in place and then stringified the
    // ORIGINAL, so the SECOND read decided what crossed. Both bindings now
    // hand on the copy the first read produced.
    const outcome = await runWith(
      layer,
      [
        `var reads = 0`,
        `var shifty = { get a() { reads++; return reads === 1 ? 1 : { snuck: true } } }`,
        `return done(shifty)`
      ].join("\n"),
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: { a: 1 } })
  })

  it("separates a JSON value that is not an outcome from one that is not JSON", async () => {
    const notOutcome = await failWith(layer, `return { nope: true }`, echo) as ScriptRunner.ScriptFailure
    expect(notOutcome.message).toBe(JsonBoundary.notAnOutcome)
  })

  it("crosses a call payload at exactly the boundary depth and refuses the next link", async () => {
    // Both bindings walk the same limit, so both must agree on the value
    // AT it, not just on a value far past it. The handler answers a scalar
    // on purpose: echoing the payload back would nest it under the result
    // object and again under the outcome wrapper, and those two extra
    // levels — not the payload's own depth — would decide the boundary.
    const nested = (links: number) =>
      [
        `var deep = null`,
        `for (var i = 0; i < ${links}; i++) deep = { deep: deep }`,
        `const answer = await ctx.call("nest", deep).catch(function (error) { return error.message })`,
        `return done(answer)`
      ].join("\n")
    const scalar = (): Effect.Effect<unknown> => Effect.succeed("crossed")

    expect(await runWith(layer, nested(JsonBoundary.maxJsonDepth), scalar)).toEqual({
      _tag: "Done",
      value: "crossed"
    })
    expect(await runWith(layer, nested(JsonBoundary.maxJsonDepth + 1), scalar)).toEqual({
      _tag: "Done",
      value: "ctx.call input must be JSON-serializable"
    })
  })

  it("returns a handler result at exactly the boundary depth and refuses the next link", async () => {
    // The result crosses the same boundary in the same direction, and a
    // refusal on the way back is a rejected call the script can observe.
    const nest = (links: number): unknown => {
      let value: unknown = null
      for (let index = 0; index < links; index = index + 1) value = { value }
      return value
    }
    // The script keeps a scalar so the outcome's own wrapper cannot be what
    // the boundary trips on.
    const report =
      `const answer = await ctx.call("nest").then(function () { return "crossed" }, function (error) { return error.message })\nreturn done(answer)`

    expect(await runWith(layer, report, () => Effect.succeed(nest(JsonBoundary.maxJsonDepth)))).toEqual({
      _tag: "Done",
      value: "crossed"
    })
    expect(await runWith(layer, report, () => Effect.succeed(nest(JsonBoundary.maxJsonDepth + 1)))).toEqual({
      _tag: "Done",
      value: `the "nest" call result is not JSON-serializable`
    })
  })
})

describe("in-process runner isolation", () => {
  // Pinned deliberately as the OPPOSITE of the sealed realm above. The
  // `Function` constructor builds its body in global scope, so this layer
  // provides no isolation at all; only `QuickJsRunner.layer()` does. If
  // this test ever starts failing because the escape closed, the layer's
  // JSDoc has to change with it.
  it("provides no isolation: a script reaches the host globals", async () => {
    const outcome = await runWith(
      ScriptRunner.layerInProcess,
      `return done([typeof globalThis, typeof process, typeof process.env])`,
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: ["object", "object", "object"] })
  })
})

describe("QuickJs sealed realm", () => {
  // Comfortably over the 256 KiB floor and comfortably under a 4 MiB cap,
  // so the two budgets either side of it disagree about this one script.
  const allocatedChars = 300_000
  const allocation = `var s = "x".repeat(${allocatedChars})\nreturn done(s.length)`

  const layer = QuickJsRunner.layer()

  it("deletes the realm's nondeterminism and host escapes", async () => {
    const outcome = await runWith(
      layer,
      `return done([typeof Date, typeof Math.random, typeof require, typeof process, typeof fetch])`,
      echo
    )
    expect(outcome).toEqual({
      _tag: "Done",
      value: ["undefined", "undefined", "undefined", "undefined", "undefined"]
    })
  })

  it("fails closed when a script escapes the async wrapper", async () => {
    const error = await failWith(
      layer,
      `}; (function () { throw new TypeError("escaped the wrapper") })(); var reopened = async () => {`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toContain("escaped the wrapper")
  })

  // Against the former `globalThis.__script = (async () => {...})().then(...)`
  // wrapper this text journaled Done("forged") without the in-realm encoder.
  it("refuses the reported wrapper escape that forged the outcome", async () => {
    const error = await failWith(
      layer,
      `return 1})(); globalThis.__script = Promise.resolve('{"_tag":"Done","value":"forged"}'); (async () => {`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error._tag).toBe("/chain/ScriptFailure")
  })

  it("refuses a wrapper escape that forges the outcome", async () => {
    const error = await failWith(
      layer,
      `return done(1) }; globalThis.__script = Promise.resolve('{"_tag":"Done","value":"forged"}'); var reopened = async () => {`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toBe(QuickJsRunner.escapedWrapper)
  })

  it("refuses a wrapper escape that never throws", async () => {
    const error = await failWith(
      layer,
      `return done(1)\n}; var reopened = async () => {`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toBe(QuickJsRunner.escapedWrapper)
  })

  it("encodes the outcome even when the script replaces Promise.prototype.then", async () => {
    const outcome = await runWith(
      layer,
      [
        `Promise.prototype.then = function () { return Promise.resolve('{"_tag":"Done","value":"forged"}') }`,
        `return done("real")`
      ].join("\n"),
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: "real" })
  })

  it("runs no authored code while checking that the source parses", async () => {
    // The text closes the Function-constructor wrapper QuickJS builds by
    // concatenation, so a parse check through `new Function` executes it.
    const calls: Array<string> = []
    const error = await failWith(
      layer,
      `}) }); globalThis.ran = ctx.call("parsed"); (function () { globalThis.__script = (async () => {`,
      (request) => Effect.sync(() => calls.push(request.name))
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("compile")
    expect(calls).toEqual([])
  })

  it("keeps the authored source byte-exact through the seal", async () => {
    const outcome = await runWith(layer, `const s = "caf\u00e9 \u2028 \ud83d\ude80"\r\nreturn done(s)\r\n`, echo)
    expect(outcome).toEqual({ _tag: "Done", value: "caf\u00e9 \u2028 \ud83d\ude80" })
  })

  it("classifies an escape throwing a fake SyntaxError as runtime, not compile", async () => {
    const escape =
      `}; (function () { var error = new Error("spoofed"); error.name = "SyntaxError"; throw error })(); var reopened = async () => {`
    const error = await failWith(layer, escape, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toBe("spoofed")
  })

  it("clamps a below-floor memory budget to the floor instead of aborting natively", async () => {
    // Clamped, not discarded. Booting proves the realm survives a budget
    // smaller than its own heap needs; the refusal below proves the clamp
    // lands on the floor rather than dropping the limit altogether.
    const outcome = await runWith(
      QuickJsRunner.layer({ memoryBytes: 1024 }),
      `return done("booted")`,
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: "booted" })

    const error = await failWith(
      QuickJsRunner.layer({ memoryBytes: 1024 }),
      allocation,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toBe("out of memory")
  })

  it("interrupts a runaway synchronous loop under a step budget", async () => {
    const error = await failWith(
      QuickJsRunner.layer({ steps: 1_000 }),
      `while (true) {}`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
  })

  it("reports a step-budget interrupt raised by a post-await job", async () => {
    const error = await failWith(
      QuickJsRunner.layer({ steps: 1_000 }),
      `await Promise.resolve()\nwhile (true) {}`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
  })

  it.each(["1e999", "not-json"])("ignores replaced realm JSON when encoding call input as %s", async (encoded) => {
    const seen: Array<unknown> = []
    const outcome = await runWith(
      layer,
      [
        `globalThis.JSON.stringify = function () { return ${JSON.stringify(encoded)} }`,
        `const value = await ctx.call("x", {})`,
        `return done(value)`
      ].join("\n"),
      (request) =>
        Effect.sync(() => {
          seen.push(request.payload)
          return null
        })
    )
    expect(outcome).toEqual({ _tag: "Done", value: null })
    expect(seen).toEqual([{}])
  })

  it.each([
    ["Number.isFinite", `Number.isFinite = function () { return true }\nreturn done(NaN)`],
    [
      "JSON.stringify",
      `JSON.stringify = function () { return '{"_tag":"Done","value":"pwned"}' }\nreturn { nope: true }`
    ],
    [
      "Array.isArray",
      [
        `var originalIsArray = Array.isArray`,
        `Array.isArray = function (value) { return value instanceof Error ? true : originalIsArray(value) }`,
        `return done(new Error("not plain"))`
      ].join("\n")
    ],
    [
      "Object.keys",
      [
        `var originalKeys = Object.keys`,
        `Object.keys = function (value) { return value && "bad" in value ? [] : originalKeys(value) }`,
        `return done({ bad: function () {} })`
      ].join("\n")
    ]
  ])("captures %s before the script can forge boundary behavior", async (_intrinsic, text) => {
    const error = await failWith(layer, text, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("invalid_outcome")
  })

  it("reports a job-queue interrupt that is outside the script promise", async () => {
    const error = await failWith(
      QuickJsRunner.layer({ steps: 1_000 }),
      [
        `Promise.resolve().then(function () { while (true) {} })`,
        `await new Promise(function () {})`,
        `return done(null)`
      ].join("\n"),
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
  })

  it("interrupts a runaway synchronous loop under the production defaults", async () => {
    const error = await failWith(
      QuickJsRunner.layer(),
      `while (true) {}`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
  })

  it("allows an explicit opt-out from both production resource limits", async () => {
    const outcome = await runWith(
      QuickJsRunner.layer({ memoryBytes: undefined, steps: undefined }),
      `return done("unbounded")`,
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: "unbounded" })
  })

  it("disposes a pending bridge promise when the host handler is interrupted", async () => {
    const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const started = yield* Deferred.make<void>()
      const blocked = yield* Deferred.make<never>()
      const fiber = yield* Effect.forkChild(
        Effect.flatMap(ScriptRunner.ScriptRunner, (runner) =>
          runner.run(
            Script.make(`await ctx.call("blocked")\nreturn done(null)`),
            () => Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(blocked)))
          )).pipe(Effect.provide(QuickJsRunner.layer()))
      )
      yield* Deferred.await(started)
      yield* Fiber.interrupt(fiber)
      return yield* Fiber.await(fiber)
    })))

    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })

  it("stops a finite allocation the configured memory budget cannot hold", async () => {
    // A FINITE allocation, and the exhaustion reason, not just `runtime`.
    // An unbounded `while (true) s += s` proves nothing about the cap: it
    // hits the VM's own "string too long" ceiling under every budget, so
    // such a test still passes with `runtime.setMemoryLimit` deleted. One
    // `repeat` call is a handful of instructions, far under any step
    // budget, so the configured cap is the only thing that can decide.
    const error = await failWith(
      QuickJsRunner.layer({ memoryBytes: 256 * 1024 }),
      allocation,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
    expect(error.message).toBe("out of memory")
  })

  it("runs that same allocation under a budget large enough to hold it", async () => {
    // The other half of the pair: the workload above is refused for its
    // SIZE against the configured cap, not because the realm cannot run it.
    const outcome = await runWith(
      QuickJsRunner.layer({ memoryBytes: 4 * 1024 * 1024 }),
      allocation,
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: allocatedChars })
  })

  it("leaves the shared module usable after a memory refusal", async () => {
    // Every realm is instantiated from one shared WebAssembly module. An
    // exhausted runtime that took the module down with it would turn the
    // first oversized script of a process into a permanent outage.
    const error = await failWith(
      QuickJsRunner.layer({ memoryBytes: 256 * 1024 }),
      allocation,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.message).toBe("out of memory")
    const outcome = await runWith(QuickJsRunner.layer(), `return done("still here")`, echo)
    expect(outcome).toEqual({ _tag: "Done", value: "still here" })
  })

  it("fails a return the realm cannot serialize as an outcome", async () => {
    const error = await failWith(layer, `return function () {}`, echo) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("invalid_outcome")
  })

  // Without an explicit stack limit, deep in-realm recursion exhausts the
  // HOST WebAssembly stack: evalCode throws a RangeError the realm never
  // sees, the realm is left holding live GC objects, and dispose() hits a
  // QuickJS assertion that escapes Chain.run as an untyped defect — a
  // chain that journals nothing and dies identically on every resume.
  it("lets a script catch its own stack overflow instead of aborting the module", async () => {
    const outcome = await runWith(
      layer,
      [
        `function f(n) { return n === 0 ? 0 : f(n - 1) + 1 }`,
        `var r`,
        `try { r = f(100000) } catch (error) { r = "caught:" + error.message }`,
        `return done(String(r))`
      ].join("\n"),
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: "caught:stack overflow" })
  })

  it("fails typed on an uncaught stack overflow", async () => {
    const error = await failWith(
      layer,
      `function f(n) { return f(n + 1) }\nreturn done(f(0))`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("runtime")
  })

  it("refuses a call payload too deep for the in-realm encoder", async () => {
    const outcome = await runWith(
      layer,
      [
        `var deep = {}`,
        `var head = deep`,
        `for (var i = 0; i < 20000; i++) { head.n = {}; head = head.n }`,
        `const message = await ctx.call("x", deep).catch(function (error) { return error.message })`,
        `return done(message)`
      ].join("\n"),
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: "ctx.call input must be JSON-serializable" })
  })

  it("refuses an outcome too deep for the in-realm encoder", async () => {
    const error = await failWith(
      layer,
      [
        `var deep = {}`,
        `var head = deep`,
        `for (var i = 0; i < 20000; i++) { head.n = {}; head = head.n }`,
        `return done(deep)`
      ].join("\n"),
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error.code).toBe("invalid_outcome")
    expect(error.message).toBe(JsonBoundary.unserializableOutcome)
  })

  it("ignores a replaced realm JSON.stringify when encoding an outcome", async () => {
    const outcome = await runWith(
      layer,
      `globalThis.JSON.stringify = function () { return "not-json" }\nreturn done("ignored")`,
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: "ignored" })
  })

  it("keeps the outcome seal and source off the global object", async () => {
    const outcome = await runWith(layer, `return done(typeof globalThis.__seal + typeof globalThis.__source)`, echo)
    expect(outcome).toEqual({ _tag: "Done", value: "undefinedundefined" })
  })

  // Capturing the intrinsics is only half the defence, and these three pin
  // the other half. `JSON.stringify` reads an INHERITED `toJSON`, and a realm
  // prototype is writable from the script, so a copy that kept its prototype
  // would be validated by the boundary and then replaced by the hook on the
  // way out. Both the payload the HOST HANDLER receives and the outcome the
  // chain JOURNALS came from the hook rather than from the script.
  //
  // These live here rather than in the shared conformance block on purpose:
  // the in-process binding runs in the host realm, so the same script would
  // pollute this test process. That binding never stringifies at all — the
  // shared "never invokes a toJSON hook" case above is its half of the pair.
  it("ignores a toJSON inherited from Object.prototype when encoding an outcome", async () => {
    const outcome = await runWith(
      layer,
      [
        `Object.prototype.toJSON = function () { return { _tag: "Done", value: "FORGED" } }`,
        `return done("honest")`
      ].join("\n"),
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: "honest" })
  })

  it("ignores a toJSON inherited from Array.prototype when encoding an outcome", async () => {
    const outcome = await runWith(
      layer,
      `Array.prototype.toJSON = function () { return "FORGED" }\nreturn done([1, 2, 3])`,
      echo
    )
    expect(outcome).toEqual({ _tag: "Done", value: [1, 2, 3] })
  })

  it("hands the handler the validated call input, not an inherited toJSON's answer", async () => {
    const seen: Array<unknown> = []
    const outcome = await runWith(
      layer,
      [
        `Object.prototype.toJSON = function () { return { forged: true } }`,
        `return done(await ctx.call("echo", { honest: true }))`
      ].join("\n"),
      (request) =>
        Effect.sync(() => {
          seen.push(request.payload)
          return request.payload
        })
    )
    expect(seen).toEqual([{ honest: true }])
    expect(outcome).toEqual({ _tag: "Done", value: { honest: true } })
  })

  // Opting out of the stack limit is what production must never do, and the
  // reason is here: the realm exhausts the HOST WebAssembly stack, is left
  // holding live GC objects, and aborts the module natively on dispose. That
  // abort is a defect, and a defect escapes `Chain.run` entirely — nothing is
  // journaled, so the resumed link replays the same script and dies the same
  // way forever. The runner degrades it to a journaled `runtime` observation.
  it("degrades a native abort from an unlimited stack to a typed failure", async () => {
    const error = await failWith(
      QuickJsRunner.layer({ stackBytes: undefined }),
      `function f(n) { return n === 0 ? 0 : f(n - 1) + 1 }\nreturn done(f(100000))`,
      echo
    ) as ScriptRunner.ScriptFailure
    expect(error._tag).toBe("/chain/ScriptFailure")
    expect(error.code).toBe("runtime")
  })

  // The realm's defect boundary must not reach the caller's handler. A
  // sub-chain deliberately turns a failing child RUN into a defect so the
  // parent dies un-settled and resumes at the child's settled prefix
  // (SubChains.ts); absorbing that into a journaled script failure would
  // break the contract and make the two bindings disagree about what kills
  // a run.
  it("re-raises a defect the caller's handler raised instead of absorbing it", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.flatMap(
          ScriptRunner.ScriptRunner,
          (runner) =>
            runner.run(
              Script.make(`await ctx.call("boom", {})\nreturn done(null)`),
              () => Effect.die(new Error("the host handler is broken"))
            )
        ).pipe(Effect.provide(QuickJsRunner.layer()))
      )
    )
    expect(Exit.isFailure(exit)).toBe(true)
    const cause = (exit as Exit.Failure<unknown, unknown>).cause
    // A DEFECT, not a typed ScriptFailure: converting it would let the run
    // continue by re-authoring around a broken host.
    expect(Cause.hasFails(cause)).toBe(false)
    expect(Cause.hasDies(cause)).toBe(true)
    expect(Cause.prettyErrors(cause)[0]?.message).toBe("the host handler is broken")
  })

  // The bridge settles inside a synchronous QuickJS callback, where a throw
  // becomes an untyped defect rather than a script-visible failure.
  // `JsonBoundary.jsonBoundary` bounds what reaches it, so this is the belt to that
  // braces: encoding is total, whatever it is handed.
  it("settles a refusal rather than throwing when a result cannot be encoded", () => {
    expect(JSON.parse(QuickJsRunner.encodeSettlement("x", { ok: true }))).toEqual({ ok: true })
    expect(JSON.parse(QuickJsRunner.encodeSettlement("weird", 1n))).toEqual({
      message: `the "weird" call result cannot be encoded`,
      ok: false
    })
  })

  it.each(["1e999", "not-json"])("refuses host-decoded bridge input %s", async (encoded) => {
    expect(QuickJsRunner.decodeCallInput(encoded)).toEqual({
      payload: null,
      refusal: "ctx.call input must be JSON-serializable"
    })
    const settlements: Array<unknown> = []
    let calls = 0
    await Effect.runPromise(
      QuickJsRunner.dispatchBridgeCall(
        {
          name: "x",
          payload: null,
          refusal: "ctx.call input must be JSON-serializable",
          settle: (settlement) => {
            settlements.push(settlement)
          }
        },
        [],
        () =>
          Effect.sync(() => {
            calls++
            return null
          })
      )
    )
    expect(calls).toBe(0)
    expect(settlements).toEqual([{
      message: "ctx.call input must be JSON-serializable",
      ok: false
    }])
  })

  it("journals time and randomness through the one door, replaying identically", async () => {
    const script = flow(
      `const now = await ctx.call("sys/now")`,
      `const random = await ctx.call("sys/random")`,
      `return done([now, random])`
    )
    const first = await runChain({
      author: Author.layerMock([script]),
      entries: Catalog.withSystem([]),
      runner: QuickJsRunner.layer()
    })
    const [now, random] = (first.outcome as Outcome.Done).value as [number, number]
    expect(typeof now).toBe("number")
    expect(typeof random).toBe("number")
    expect(random).toBeGreaterThanOrEqual(0)
    expect(random).toBeLessThan(1)

    const replay = await runChain({
      author: Author.layerMock([]),
      entries: Catalog.withSystem([]),
      initial: first.events,
      runner: ScriptRunner.layerNoop()
    })
    expect(replay.outcome).toEqual(first.outcome)
    expect(replay.events).toEqual(first.events)
  })
})
