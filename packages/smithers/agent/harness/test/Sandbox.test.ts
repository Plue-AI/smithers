/**
 * The sandbox contract, proved against the binding a production host selects.
 *
 * One binding ships. The dependency-free same-realm binding beside it went with
 * the surface it existed for: a cell whose names vanish when it returns can run
 * inside a `with`-scoped function wrapper, and a run whose cells share a realm
 * cannot — so the contract is proved where it is actually honoured, on QuickJS.
 */
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { describe, expect, it } from "vitest"
import * as Cell from "../src/Cell.ts"
import { HarnessError } from "../src/HarnessError.ts"
import * as QuickJSSandbox from "../src/QuickJSSandbox.ts"
import * as Sandbox from "../src/Sandbox.ts"
import { rejectedCell, rejectedCellNames } from "./fixtures/rejectedCells.ts"

const listInputDocument = JSON.parse(
  JSON.stringify(Schema.toJsonSchemaDocument(Schema.Struct({ path: Schema.String })))
) as Schema.Json

const flows: Readonly<Record<string, Cell.FlowProjection>> = {
  "fs/list": new Cell.FlowProjection({
    name: "fs/list",
    description: "List a directory.",
    capabilities: ["fs:read:**"],
    tier: "sealed",
    placement: Option.none(),
    input: Option.some(listInputDocument)
  })
}

/** Records every invocation and replies from a scripted table. */
const handler = (
  replies: Readonly<Record<string, Schema.Json>>,
  observed: Array<Sandbox.Invocation>,
  failing: ReadonlySet<string> = new Set()
): Sandbox.Handler =>
(invocation) =>
  Effect.sync(() => {
    observed.push(invocation)
    return failing.has(invocation.flow)
      ? new Cell.CallResult({ outcome: "failure", value: null, message: `${invocation.flow} refused` })
      : new Cell.CallResult({ outcome: "success", value: replies[invocation.flow] ?? null })
  })

/** Evaluates one cell in a realm of its own, which is what one frame does. */
const evaluate = (
  text: string,
  options: {
    readonly call?: Sandbox.Handler | undefined
    readonly limits?: Sandbox.Limits | undefined
    readonly evaluationLimits?: Sandbox.EvaluationLimits | undefined
    readonly mint?: Sandbox.Minter | undefined
  } = {}
): Promise<Cell.Outcome> =>
  Effect.gen(function*() {
    const sandbox = yield* Sandbox.Sandbox
    const open = sandbox.openRealm
    expect(open).toBeDefined()
    const realm = yield* open!({ flows, limits: options.limits })
    const frame = yield* realm.evaluate({
      cell: Cell.source(text),
      frame: 0,
      call: options.call ?? handler({}, []),
      ...(options.mint === undefined ? {} : { mint: options.mint }),
      limits: options.evaluationLimits
    })
    return frame.outcome
  }).pipe(Effect.provide(QuickJSSandbox.layer), Effect.scoped, Effect.runPromise)

/** Opens a realm and hands it to the body, so a case can drive it directly. */
const withRealm = <A, E>(
  body: (realm: Sandbox.Realm) => Effect.Effect<A, E, never>,
  limits?: Sandbox.Limits
): Effect.Effect<A, E | Sandbox.SandboxError, never> =>
  Effect.gen(function*() {
    const sandbox = yield* Sandbox.Sandbox
    const open = sandbox.openRealm
    expect(open).toBeDefined()
    const realm = yield* open!({ flows, ...(limits === undefined ? {} : { limits }) })
    return yield* body(realm)
  }).pipe(Effect.provide(QuickJSSandbox.layer), Effect.scoped)

describe("Sandbox", () => {
  it("applies call overrides to only the requested evaluation", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const frames = await withRealm((realm) =>
      Effect.gen(function*() {
        const evaluation = {
          cell: Cell.source(`await ctx.call("fs/list", {}); ctx.done("called")`),
          frame: 0,
          call: handler({}, observed)
        }
        const blocked = yield* realm.evaluate({ ...evaluation, limits: { calls: 0 } })
        expect(observed).toHaveLength(0)
        const inherited = yield* realm.evaluate({ ...evaluation, frame: 1 })
        const raised = yield* realm.evaluate({
          ...evaluation,
          cell: Cell.source(`await ctx.call("fs/list", {}); await ctx.call("fs/list", {}); ctx.done("twice")`),
          frame: 2,
          limits: { calls: 2 }
        })
        return [blocked, inherited, raised]
      }), { calls: 1 }).pipe(Effect.runPromise)

    expect(frames.map((frame) => frame.outcome)).toMatchObject([
      { _tag: "rejected", code: "limit_exceeded" },
      { _tag: "settled", transition: { _tag: "complete", output: "called" } },
      { _tag: "settled", transition: { _tag: "complete", output: "twice" } }
    ])
    expect(observed).toHaveLength(3)
  })

  it("runs data-dependent calls in issue order without a round trip between them", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `const listed = await ctx.call("fs/list", { path: "." })
         const detail = await ctx.call("fs/list", { path: listed.entries[0] })
         ctx.done(detail.entries.join(","))`,
      {
        call: handler(
          { "fs/list": { entries: ["alpha", "beta"] } },
          observed
        )
      }
    )

    expect(observed.map((call) => [call.ordinal, call.flow, call.input])).toEqual([
      [0, "fs/list", { path: "." }],
      // The second input is derived from the first result inside the cell.
      [1, "fs/list", { path: "alpha" }]
    ])
    expect(outcome._tag).toBe("settled")
    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: "alpha,beta"
    })
  })

  it("returns mutable object properties from flow calls", async () => {
    const outcome = await evaluate(
      `const result = await ctx.call("fs/list", {})
         result.entry.name = "renamed"
         ctx.done(result.entry.name)`,
      { call: handler({ "fs/list": { entry: { name: "original" } } }, []) }
    )

    expect((outcome as Cell.Settled).transition).toMatchObject({ _tag: "complete", output: "renamed" })
  })

  it("returns mutable arrays from flow calls", async () => {
    const outcome = await evaluate(
      `const result = await ctx.call("fs/list", {})
         result.entries.push("beta")
         result.entries[0] = "renamed"
         ctx.done(result.entries.join(","))`,
      { call: handler({ "fs/list": { entries: ["alpha"] } }, []) }
    )

    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: "renamed,beta"
    })
  })

  it("uses ordinary JSON data-property descriptors for flow results", async () => {
    const outcome = await evaluate(
      `const result = await ctx.call("fs/list", {})
         const objectDescriptor = Object.getOwnPropertyDescriptor(result, "entry")
         const indexDescriptor = Object.getOwnPropertyDescriptor(result.entries, "0")
         ctx.done([
             objectDescriptor.writable,
             objectDescriptor.enumerable,
             objectDescriptor.configurable,
             indexDescriptor.writable,
             indexDescriptor.enumerable,
             indexDescriptor.configurable
           ].join(","))`,
      { call: handler({ "fs/list": { entry: "value", entries: ["alpha"] } }, []) }
    )

    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: "true,true,true,true,true,true"
    })
  })

  it("denies ambient time, randomness, network, and process access", async () => {
    for (const expression of ["Date.now()", "Math.random()", "fetch(\"http://x\")", "process.exit()"]) {
      const outcome = await evaluate(`ctx.done(String(${expression}))`)
      expect(outcome._tag, expression).toBe("raised")
    }
  })

  it("reaches nothing through `this`, which no identifier check can deny", async () => {
    // A `with` block only runs in sloppy mode, and a sloppy function called
    // without a receiver binds `this` to the host realm's global object. That
    // is a path around the scope proxy entirely: `this.process` never looks
    // up an identifier, so denial by identifier cannot see it.
    const outcome = await evaluate(
      `ctx.done([typeof this, String(this && this.process)].join("|"))`
    )

    expect(outcome._tag).toBe("settled")
    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: "object|undefined"
    })
  })

  it("evaluates deterministically: the same cell issues the same calls twice", async () => {
    const first: Array<Sandbox.Invocation> = []
    const second: Array<Sandbox.Invocation> = []
    const text = `const a = await ctx.call("fs/list", { path: "." })
        const b = await ctx.call("fs/list", { path: a.entries.length > 1 ? "many" : "one" })
        ctx.done(JSON.stringify(b))`
    const replies = { "fs/list": { entries: ["a", "b"] } }

    const one = await evaluate(text, { call: handler(replies, first) })
    const two = await evaluate(text, { call: handler(replies, second) })

    expect(first).toEqual(second)
    expect(one).toStrictEqual(two)
  })

  it("resolves a failed flow call with the failure envelope instead of throwing", async () => {
    const outcome = await evaluate(
      `const result = await ctx.call("fs/list", {})
         ctx.done(JSON.stringify(result))`,
      { call: handler({}, [], new Set(["fs/list"])) }
    )

    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: JSON.stringify({
        ok: false,
        error: {
          code: "flow_failed",
          message: "fs/list refused",
          hint: Cell.callFailureHint.flow_failed
        }
      })
    })
  })

  it("runs the calls a cell makes after one that failed, in the same frame", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `const first = await ctx.call("fs/list", { path: "missing" })
         const second = await ctx.call("fs/read", { path: "ok" })
         ctx.done(JSON.stringify([first.ok, second]))`,
      { call: handler({ "fs/read": "kept" }, observed, new Set(["fs/list"])) }
    )

    expect(observed.map((call) => call.flow)).toEqual(["fs/list", "fs/read"])
    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: JSON.stringify([false, "kept"])
    })
  })

  it("settles the active VM bridge before propagating a host failure", async () => {
    const result = await withRealm((realm) =>
      Effect.result(
        realm.evaluate({
          cell: Cell.source(`await ctx.call("fs/list", {})`),
          frame: 0,
          call: () => Effect.fail(new HarnessError({ code: "engine_failed", message: "permission park" }))
        })
      )
    ).pipe(Effect.runPromise)

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { code: "engine_failed", message: "permission park" }
    })
  })

  it("reports a thrown cell as a durable observation", async () => {
    const outcome = await evaluate(`throw new TypeError("bad plan")`)
    expect(outcome).toStrictEqual(new Cell.Raised({ name: "TypeError", message: "bad plan" }))
  })

  it("reports a cell that returns at all as a compile failure, before anything runs", async () => {
    const outcome = await evaluate(`return "done"`)
    expect(outcome._tag).toBe("rejected")
    expect((outcome as Cell.Rejected).code).toBe("compile_failed")
    expect((outcome as Cell.Rejected).message).toContain("ctx.done(output)")
  })

  it("reports a cell that does not compile without running anything", async () => {
    const outcome = await evaluate(`return {`)
    expect(outcome._tag).toBe("rejected")
    expect((outcome as Cell.Rejected).code).toBe("compile_failed")
  })

  it("teaches ctx.call to a cell that imports, and runs one that only quotes an import", async () => {
    const imported = await evaluate(`import { readFile } from "node:fs"\nreturn null`)
    expect(imported._tag).toBe("rejected")
    expect((imported as Cell.Rejected).code).toBe("imports_forbidden")
    expect((imported as Cell.Rejected).message).toContain("ctx.call")

    // The same word, inside the string a benchmark cell actually passed.
    const quoted = await evaluate(
      `const command = "python - <<'PY'\\nfrom pathlib import Path\\nprint(Path('.'))\\nPY"
         ctx.done(command)`
    )
    expect(quoted._tag).toBe("settled")
  })

  it("runs erasable TypeScript without changing its runtime meaning", async () => {
    const outcome = await withRealm((realm) =>
      realm.evaluate({
        cell: Cell.source("const x: number = 1\nctx.done(String(x))", "typescript"),
        frame: 0,
        call: handler({}, [])
      })
    ).pipe(Effect.map((frame) => frame.outcome), Effect.runPromise)

    expect(outcome).toStrictEqual(
      new Cell.Settled({
        transition: new Cell.Complete({ output: "1" })
      })
    )
  })

  it("rejects TypeScript syntax that requires JavaScript emit", async () => {
    const typed = await withRealm((realm) =>
      realm.evaluate({
        cell: Cell.source("enum Direction { Left, Right }", "typescript"),
        frame: 0,
        call: handler({}, [])
      })
    ).pipe(Effect.map((frame) => frame.outcome), Effect.runPromise)
    expect(typed._tag).toBe("rejected")
    expect((typed as Cell.Rejected).code).toBe("compile_failed")
  })

  it("enforces a declared call limit as an uncatchable typed outcome", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `await ctx.call("fs/list", {})
         try {
           await ctx.call("fs/list", {})
         } catch (error) {
           ctx.done(error.message)
         }
         ctx.done("unreachable")`,
      { call: handler({}, observed), limits: { calls: 1 } }
    )

    expect(observed).toHaveLength(1)
    expect(outcome).toMatchObject({
      _tag: "rejected",
      code: "limit_exceeded",
      message: "This cell exceeded its limit of 1 flow calls"
    })
  })

  it("counts checkpoint mints against the shared flow-call budget", async () => {
    const minted: Array<number> = []
    const outcome = await evaluate(
      `await ctx.checkpoint()
       await ctx.checkpoint()
       ctx.done("unreachable")`,
      {
        limits: { calls: 1 },
        mint: (mint) =>
          Effect.sync(() => {
            minted.push(mint.ordinal)
            return new Cell.CallResult({ outcome: "success", value: null })
          })
      }
    )

    expect(minted).toEqual([0])
    expect(outcome).toStrictEqual(
      new Cell.Rejected({ code: "limit_exceeded", message: "This cell exceeded its limit of 1 flow calls" })
    )
  })

  it("settles a stalled flow call at its own budget as a catchable failure", async () => {
    // The defect this bounds: a broad `grep` that never settled held its
    // frame for the whole 900,000 ms evaluation ceiling and was reported to
    // the model as nothing at all. A per-call budget answers the call
    // instead, inside the frame the cell is still running.
    let entered = false
    const outcome = await evaluate(
      `const result = await ctx.call("fs/list", {})
         ctx.done(JSON.stringify(result))`,
      {
        call: () =>
          Effect.sync(() => {
            entered = true
          }).pipe(Effect.andThen(Effect.never)),
        limits: { callMs: 50 }
      }
    )

    expect(entered).toBe(true)
    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: JSON.stringify({
        ok: false,
        error: {
          code: "timeout",
          message: "Flow fs/list timed out after 0.05 seconds.",
          hint: Cell.callFailureHint.timeout
        }
      })
    })
  })

  it("leaves the frame alive after a timed-out call, so a narrower call still runs", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `const broad = await ctx.call("fs/list", { path: "." })
         if (broad.ok !== false || broad.error.code !== "timeout") {
           ctx.done("unreachable")
         }
         const narrowed = await ctx.call("fs/list", { path: "django" })
         ctx.done(narrowed.entries.join(","))`,
      {
        call: (invocation) => {
          observed.push(invocation)
          return invocation.ordinal === 0
            ? Effect.never
            : Effect.succeed(new Cell.CallResult({ outcome: "success", value: { entries: ["sites.py"] } }))
        },
        limits: { callMs: 50 }
      }
    )

    expect(observed.map((call) => call.input)).toEqual([{ path: "." }, { path: "django" }])
    expect((outcome as Cell.Settled).transition).toMatchObject({ _tag: "complete", output: "sites.py" })
  })

  it("does not charge a settled call against the next call's budget", async () => {
    // Two 200 ms calls under a 300 ms per-call budget: a budget the calls
    // shared would expire 100 ms into the second one. The test clock steps
    // each call to its end, so the reading never depends on host scheduling.
    const outcome = await Effect.gen(function*() {
      const entered = [yield* Deferred.make<void>(), yield* Deferred.make<void>()]
      const fiber = yield* withRealm((realm) =>
        realm.evaluate({
          cell: Cell.source(
            `const one = await ctx.call("fs/list", { path: "one" })
             const two = await ctx.call("fs/list", { path: "two" })
             ctx.done(JSON.stringify([one, two]))`
          ),
          frame: 0,
          call: (invocation) =>
            Deferred.succeed(entered[invocation.ordinal]!, undefined).pipe(
              Effect.andThen(Effect.sleep(200)),
              Effect.as(new Cell.CallResult({ outcome: "success", value: invocation.input }))
            )
        }), { callMs: 300 }).pipe(Effect.forkChild({ startImmediately: true }))
      for (const call of entered) {
        yield* Deferred.await(call)
        yield* TestClock.adjust(200)
      }
      return (yield* Fiber.join(fiber)).outcome
    }).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)

    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: JSON.stringify([{ path: "one" }, { path: "two" }])
    })
  })

  it("exposes the catalog, the checkpoint pair, the settling calls, and nothing else", async () => {
    const outcome = await evaluate(
      `ctx.done(Object.keys(ctx).sort().join(",") + "|" + Object.keys(ctx.flows).join(","))`
    )
    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: "base,call,checkpoint,done,flows,justify,park|fs/list"
    })
  })

  it("deep-freezes every catalog descriptor", async () => {
    const outcome = await evaluate(
      `ctx.done(String(Object.isFrozen(ctx.flows) && Object.isFrozen(ctx.flows["fs/list"]) && Object.isFrozen(ctx.flows["fs/list"].capabilities)))`
    )
    expect((outcome as Cell.Settled).transition).toMatchObject({ _tag: "complete", output: "true" })
  })

  it("rejects a non-string flow name before opening a boundary", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `try {
           await ctx.call(42, {})
         } catch (error) {
           ctx.done(error.name)
         }`,
      { call: handler({}, observed) }
    )
    expect(observed).toHaveLength(0)
    expect((outcome as Cell.Settled).transition).toMatchObject({ _tag: "complete", output: "TypeError" })
  })

  it("rejects non-JSON call input before opening a boundary", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `try {
           await ctx.call("fs/list", { invalid: new Map() })
         } catch (error) {
           ctx.done(error.name + ": " + error.message)
         }`,
      { call: handler({}, observed) }
    )
    expect(observed).toHaveLength(0)
    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: "TypeError: ctx.call input must be JSON-serializable"
    })
  })

  it("reads an omitted call input as the same null an explicit one carries", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `const omitted = await ctx.call("fs/list")
         const explicit = await ctx.call("fs/list", null)
         ctx.done(JSON.stringify([omitted, explicit]))`,
      { call: handler({}, observed) }
    )

    expect(observed.map((call) => [call.ordinal, call.input])).toEqual([[0, null], [1, null]])
    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: "[null,null]"
    })
  })

  it("answers a call at a zero per-call budget without waiting for the host", async () => {
    // Zero is the boundary the message renderer has to survive as well: a
    // whole number of seconds must not read as "0.000".
    const outcome = await evaluate(
      `const result = await ctx.call("fs/list", {})
         ctx.done(result.error.code + ": " + result.error.message)`,
      { call: () => Effect.never, limits: { callMs: 0 } }
    )

    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: "timeout: Flow fs/list timed out after 0 seconds."
    })
  })

  it("admits exactly as many calls as the budget allows", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `await ctx.call("fs/list", {})
         ctx.done("spent the budget exactly")`,
      { call: handler({}, observed), limits: { calls: 1 } }
    )

    expect(observed).toHaveLength(1)
    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: "spent the budget exactly"
    })
  })

  it("refuses the very first call when the budget is zero", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `await ctx.call("fs/list", {})
         ctx.done("unreachable")`,
      { call: handler({}, observed), limits: { calls: 0 } }
    )

    expect(observed).toEqual([])
    expect(outcome).toStrictEqual(
      new Cell.Rejected({ code: "limit_exceeded", message: "This cell exceeded its limit of 0 flow calls" })
    )
  })

  it("settles a cell that makes no call at all under a zero call budget", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `ctx.done(String(Object.keys(ctx.flows).length))`,
      { call: handler({}, observed), limits: { calls: 0 } }
    )

    expect(observed).toEqual([])
    expect((outcome as Cell.Settled).transition).toMatchObject({ _tag: "complete", output: "1" })
  })

  it("settles the calls still queued behind the one that spent the budget", async () => {
    // Three calls are issued before any of them settles, so when the second
    // one meets the ceiling a third is still queued behind it. A queued call
    // that is never answered leaves a live promise behind a frame that is
    // already gone.
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `await Promise.all([
           ctx.call("fs/list", { a: 1 }),
           ctx.call("fs/list", { b: 2 }),
           ctx.call("fs/list", { c: 3 })
         ])
         ctx.done("unreachable")`,
      { call: handler({}, observed), limits: { calls: 1 } }
    )

    expect(observed.map((call) => call.input)).toEqual([{ a: 1 }])
    expect(outcome).toStrictEqual(
      new Cell.Rejected({ code: "limit_exceeded", message: "This cell exceeded its limit of 1 flow calls" })
    )
  })

  it("settles concurrent calls one at a time, in the order the cell issued them", async () => {
    // Ordinals are the replay anchor, so calls that are issued together must
    // still be numbered and answered in issue order rather than interleaved.
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `const results = await Promise.all([
           ctx.call("fs/list", { path: "a" }),
           ctx.call("fs/list", { path: "b" }),
           ctx.call("fs/list", { path: "a" })
         ])
         ctx.done(results.join(","))`,
      {
        call: (invocation) => {
          observed.push(invocation)
          return Effect.succeed(
            new Cell.CallResult({ outcome: "success", value: `${invocation.ordinal}:${observed.length}` })
          )
        }
      }
    )

    expect(observed.map((call) => [call.ordinal, call.input])).toEqual([
      [0, { path: "a" }],
      [1, { path: "b" }],
      // The same input twice is two calls with two ordinals, not one shared
      // answer: identity is positional, not content-addressed.
      [2, { path: "a" }]
    ])
    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: "0:1,1:2,2:3"
    })
  })

  it("reports a rejected promise the cell awaits as the failure it carries", async () => {
    expect(await evaluate(`await Promise.reject(new RangeError("nope"))`)).toStrictEqual(
      new Cell.Raised({ name: "RangeError", message: "nope" })
    )
  })

  it("lets a host handler that dies take the frame down instead of answering the cell", async () => {
    const exit = await withRealm((realm) =>
      Effect.exit(realm.evaluate({
        cell: Cell.source(
          `try {
               await ctx.call("fs/list", {})
             } catch (error) {
               ctx.done("the cell caught a host defect")
             }
             ctx.done("unreachable")`
        ),
        frame: 0,
        call: () =>
          Effect.sync(() => {
            throw new Error("the host blew up")
          })
      }))
    ).pipe(Effect.runPromise)

    // A defect in the host is not data the cell may recover from: the frame
    // ends, and no outcome is produced for the journal to record as an answer.
    expect(Exit.isFailure(exit)).toBe(true)
    expect(Cause.pretty((exit as Exit.Failure<never, never>).cause)).toContain("the host blew up")
  })

  it("refuses a return in every shape it can be written in", async () => {
    for (
      const expression of [
        "",
        " 42",
        " null",
        " \"done\"",
        " []",
        " { intent: \"complete\", output: \"x\" }"
      ]
    ) {
      const outcome = await evaluate(`return${expression}`)
      expect(outcome._tag, expression).toBe("rejected")
      expect((outcome as Cell.Rejected).code, expression).toBe("compile_failed")
    }
  })

  it("carries a half-megabyte output out of the cell", async () => {
    const outcome = await evaluate(`ctx.done("q".repeat(512 * 1024))`)
    const settled = outcome as Cell.Settled
    expect(settled.transition._tag).toBe("complete")
    expect((settled.transition as Cell.Complete).output.length).toBe(512 * 1024)
  }, 60_000)

  it("surfaces an interruption mid-call as an interrupted exit, never as an outcome", async () => {
    const result = await withRealm((realm) =>
      Effect.gen(function*() {
        const entered = yield* Deferred.make<void>()
        const frame = yield* realm.evaluate({
          cell: Cell.source(`await ctx.call("fs/list", {})\nctx.done("unreachable")`),
          frame: 0,
          call: () => Deferred.succeed(entered, void 0).pipe(Effect.andThen(Effect.never))
        }).pipe(Effect.forkChild({ startImmediately: true }))

        // Interrupt only once the frame is genuinely suspended in a host call.
        yield* Deferred.await(entered)
        yield* Fiber.interrupt(frame)
        return { exit: yield* Fiber.await(frame) }
      })
    ).pipe(Effect.runPromise)

    expect(Exit.isFailure(result.exit) && Cause.hasInterruptsOnly(result.exit.cause)).toBe(true)
  })
})

describe("Sandbox.makeNoop", () => {
  it("offers no realm, which is the whole of what it cannot do", () => {
    expect(Sandbox.makeNoop().openRealm).toBeUndefined()
    expect(Sandbox.realmUnsupported.code).toBe("unsupported")
    expect(Sandbox.realmUnsupported.message).toContain("no persistent realm")
  })

  it("takes an override for the one operation it has", async () => {
    const opened = await Effect.gen(function*() {
      const sandbox = yield* Sandbox.Sandbox
      const open = sandbox.openRealm
      expect(open).toBeDefined()
      return yield* open!({ flows: {} })
    }).pipe(
      Effect.provide(
        Sandbox.layerNoop({
          openRealm: () => Effect.succeed({ evaluate: () => Effect.die("unused") } as Sandbox.Realm)
        })
      ),
      Effect.scoped,
      Effect.runPromise
    )

    expect(typeof opened.evaluate).toBe("function")
  })
})

describe("Sandbox projections", () => {
  it("projects a non-Error throw into a stable outcome", () => {
    expect(Sandbox.raisedOutcome("plain string")).toStrictEqual(
      new Cell.Raised({ name: "Error", message: "plain string" })
    )
    expect(Sandbox.raisedOutcome(new RangeError("out of range"))).toStrictEqual(
      new Cell.Raised({ name: "RangeError", message: "out of range" })
    )
  })

  it("renders a thrown structure as the value it is, never as [object Object]", () => {
    expect(Sandbox.raisedOutcome({ code: 7, why: "denied" })).toStrictEqual(
      new Cell.Raised({ name: "Error", message: `{"code":7,"why":"denied"}` })
    )
    expect(Sandbox.raisedOutcome({ code: 7 }).message).not.toContain("[object Object]")
    // A symbol is outside JSON entirely, and `String` is then the only
    // faithful rendering left.
    expect(Sandbox.raisedOutcome(Symbol("nope"))).toStrictEqual(
      new Cell.Raised({ name: "Error", message: "Symbol(nope)" })
    )
  })

  it("defaults every supported safety ceiling and preserves explicit raises", async () => {
    const observed: Array<Sandbox.Limits | undefined> = []
    const sandbox = Sandbox.make({
      capabilities: { calls: true, memoryBytes: true, steps: true, timeMs: true },
      openRealm: (options) =>
        Effect.sync(() => {
          observed.push(options.limits)
          return { evaluate: () => Effect.die("unused") } as Sandbox.Realm
        })
    })
    const open = (limits?: Sandbox.Limits) =>
      Effect.runPromise(Effect.scoped(sandbox.openRealm!({ flows: {}, ...(limits === undefined ? {} : { limits }) })))

    await open()
    await open({ steps: Sandbox.defaultLimits.steps + 1 })
    await open({
      memoryBytes: Sandbox.defaultLimits.memoryBytes + 1,
      steps: Sandbox.defaultLimits.steps + 1,
      timeMs: Sandbox.defaultLimits.timeMs + 1
    })

    expect(observed).toEqual([
      Sandbox.defaultLimits,
      {
        calls: Sandbox.defaultLimits.calls,
        memoryBytes: Sandbox.defaultLimits.memoryBytes,
        steps: Sandbox.defaultLimits.steps + 1,
        timeMs: Sandbox.defaultLimits.timeMs,
        totalMs: Sandbox.defaultLimits.totalMs,
        callMs: Sandbox.defaultLimits.callMs
      },
      {
        calls: Sandbox.defaultLimits.calls,
        memoryBytes: Sandbox.defaultLimits.memoryBytes + 1,
        steps: Sandbox.defaultLimits.steps + 1,
        timeMs: Sandbox.defaultLimits.timeMs + 1,
        totalMs: Sandbox.defaultLimits.totalMs,
        callMs: Sandbox.defaultLimits.callMs
      }
    ])
  })

  it("rejects invalid numeric ceilings before a realm is opened", async () => {
    let opens = 0
    const sandbox = Sandbox.make({
      capabilities: { calls: true, memoryBytes: true, steps: true, timeMs: true },
      openRealm: () => {
        opens = opens + 1
        return Effect.succeed({ evaluate: () => Effect.die("unused") } as Sandbox.Realm)
      }
    })

    for (
      const limits of [
        { timeMs: 0 },
        { timeMs: Number.POSITIVE_INFINITY },
        { timeMs: Number.NaN },
        { totalMs: Number.POSITIVE_INFINITY },
        { totalMs: Number.NaN },
        { callMs: -1 },
        { callMs: Number.NaN },
        { steps: 0 },
        { steps: Number.POSITIVE_INFINITY },
        { steps: Number.NaN },
        { memoryBytes: 0 },
        { memoryBytes: 1 },
        { pauseTotalMsFor: [""] },
        { pauseTotalMsFor: [" "] },
        { pauseTotalMsFor: ["agent.wait", 7] as unknown as ReadonlyArray<string> },
        { pauseTotalMsFor: "agent.wait" as unknown as ReadonlyArray<string> }
      ]
    ) {
      const result = await Effect.runPromise(
        Effect.scoped(Effect.result(sandbox.openRealm!({ flows: {}, limits })))
      )
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { code: "unsupported" }
      })
    }

    expect(opens).toBe(0)
  })

  it("reports which limits the binding can enforce", async () => {
    const quickjs = await Effect.gen(function*() {
      const sandbox = yield* Sandbox.Sandbox
      return sandbox.capabilities
    }).pipe(Effect.provide(QuickJSSandbox.layer), Effect.runPromise)
    expect(quickjs).toEqual({ calls: true, memoryBytes: true, steps: true, timeMs: true })
  })
})

describe("Sandbox call refusals", () => {
  it("rejects a call whose flow name is not a string, without queueing it", async () => {
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `try {
         await ctx.call(42, {})
       } catch (error) {
         ctx.done(error.name)
       }`,
      { call: handler({}, observed) }
    )

    expect(observed).toHaveLength(0)
    expect((outcome as Cell.Settled).transition).toMatchObject({ _tag: "complete", output: "TypeError" })
  })

  it("never reaches the host for a call issued after the budget was already spent", async () => {
    // The frame is already rejected by the time the third call is issued, so
    // its only observable trace is whether the host saw it. It must not.
    const observed: Array<Sandbox.Invocation> = []
    const outcome = await evaluate(
      `await ctx.call("fs/list", {})
       try {
         await ctx.call("fs/list", {})
       } catch (overBudget) {
         try {
           await ctx.call("fs/list", {})
         } catch (afterAbort) {
           ctx.done(afterAbort.message)
         }
       }`,
      { call: handler({}, observed), limits: { calls: 1 } }
    )

    expect(observed).toHaveLength(1)
    expect(outcome).toStrictEqual(
      new Cell.Rejected({ code: "limit_exceeded", message: "This cell exceeded its limit of 1 flow calls" })
    )
  })
})

describe("Sandbox.compile", () => {
  it("hands a JavaScript cell through with its top-level declarations rebindable", () => {
    // The realm outlives the cell, so a top-level `const` becomes a `var`: that
    // is what lets a later cell declare the same name again. Nothing else about
    // the JavaScript the model wrote is touched. See `CellValidation.normalize`.
    expect(Sandbox.compile(Cell.source("const kept = 1", "javascript"))).toBe("var kept = 1")
    expect(Sandbox.compile(Cell.source("await ctx.call(\"fs/list\", {})", "javascript")))
      .toBe("await ctx.call(\"fs/list\", {})")
  })

  it("erases type-only syntax from a TypeScript cell", () => {
    const compiled = Sandbox.compile(Cell.source("const x: number = 1\nctx.done(String(x))", "typescript"))
    expect(compiled).toContain("var x = 1")
    expect(compiled).not.toContain("number")
    expect(compiled).toContain("\"use strict\"")
  })

  it("names the construct that needs JavaScript emit rather than emitting it", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["enum Direction { Left, Right }", "enum declarations"],
      // The `export` inside the namespace is not ESM, and the module check
      // steps over a namespace body so it cannot be read as ESM either.
      ["namespace Shapes { export const sides = 3 }", "namespace/module declarations"],
      ["declare module \"node:fs\" {}", "namespace/module declarations"],
      ["class A { constructor(public a: number) {} }", "parameter properties"],
      ["class A { constructor(private a: number) {} }", "parameter properties"],
      ["class A { constructor(protected a: number) {} }", "parameter properties"],
      ["class A { constructor(readonly a: number) {} }", "parameter properties"],
      // `override` is the last modifier the check tests, so it is the one that
      // proves the whole list is consulted and not just its first entries.
      ["class A { constructor(override a: number) {} }", "parameter properties"]
    ]

    for (const [text, forbidden] of cases) {
      expect(Sandbox.compile(Cell.source(text, "typescript")), text).toStrictEqual(
        new Cell.Rejected({
          code: "compile_failed",
          message: `The TypeScript cell uses ${forbidden}, which are not erasable syntax.`
        })
      )
    }
  })

  it("keeps a class whose constructor parameters carry no modifier at all", () => {
    const compiled = Sandbox.compile(
      Cell.source("class Point { constructor(x: number) { this.x = x } }", "typescript")
    )
    expect(typeof compiled).toBe("string")
    expect(compiled).toContain("constructor(x)")
  })

  it("reports a TypeScript cell that does not parse as a correctable rejection", () => {
    expect(Sandbox.compile(Cell.source("const held = {", "typescript"))).toStrictEqual(
      new Cell.Rejected({
        code: "compile_failed",
        message: "The cell did not compile — line 1, column 15: Unexpected token\n  const held = {"
      })
    )
  })

  it("reports a JavaScript cell that does not parse, with the line it is on", () => {
    // The realm used to be the first party to notice, which cost the whole
    // frame. Compiling here is what lets `CellTurn` answer inside it.
    expect(Sandbox.compile(Cell.source("const a = 1\nif (a) {\n  ctx.done('x')\n", "javascript"))).toStrictEqual(
      new Cell.Rejected({
        code: "compile_failed",
        message: "The cell did not compile — line 4, column 1: Unexpected token"
      })
    )
  })

  it("refuses module syntax and says which binding to use instead", () => {
    const cases: ReadonlyArray<readonly [string, Cell.Language, string]> = [
      ["import { readFile } from \"node:fs\"", "javascript", "import"],
      ["import \"node:fs\"\nimport \"node:path\"", "javascript", "import"],
      ["const m = await import(\"node:fs\")", "javascript", "import"],
      ["const here = import.meta.url", "javascript", "import"],
      ["const fs = require(\"node:fs\")", "javascript", "require"],
      ["export const x = 1", "javascript", "export"],
      ["const x = 1\nexport { x }", "javascript", "export"],
      ["export default 1", "javascript", "export"],
      ["import fs = require(\"node:fs\")", "typescript", "import"],
      ["export = 1", "typescript", "export"]
    ]

    for (const [text, language, syntax] of cases) {
      expect(Sandbox.compile(Cell.source(text, language)), text).toStrictEqual(
        new Cell.Rejected({
          code: "imports_forbidden",
          message: `A cell may not ${syntax} anything: it runs in a realm with no module loader. ` +
            "Use ctx.call for every effect and ctx.flows for the catalog it may call; " +
            "they are the only bindings a cell has."
        })
      )
    }
  })

  it("keeps the JavaScript that only looks like module syntax", () => {
    const cases: ReadonlyArray<string> = [
      // The identifier prefix, the property name, and the string: the three
      // ways a regexp over the source read a cell as importing.
      "await ctx.call(\"bash\", { command: \"python -c 'from pathlib import Path'\" })",
      "await ctx.call(\"grep\", { pattern: \"from _pytest import\" })",
      // A modifier that is not `export`, and a meta-property that is not
      // `import.meta`.
      "async function work() { return new.target }\nawait work()"
    ]

    for (const text of cases) {
      expect(Sandbox.compile(Cell.source(text)), text).toBe(text)
    }
    // The identifier prefix and the property name, which a regexp over the
    // source read as an export.
    expect(Sandbox.compile(Cell.source("const important = ctx.flows\nconst named = important.export")))
      .toBe("var important = ctx.flows\nvar named = important.export")
  })

  for (const name of rejectedCellNames) {
    it(`never reads the wave-5 cell ${name} as importing anything`, () => {
      // These are the cells a regexp over the source refused: each one quotes
      // an import inside a string it passes to a flow. The parse is what tells
      // the quote from the syntax, and it still does — whatever else it has to
      // say about a cell written against a surface that no longer exists.
      const extracted = Cell.extract(rejectedCell(name))
      expect(extracted._tag).toBe("Success")
      const compiled = Sandbox.compile((extracted as { readonly success: Cell.Extracted }).success.source)
      expect(compiled instanceof Cell.Rejected ? compiled.code : "compiled").not.toBe("imports_forbidden")
    })
  }
})

describe("Sandbox.layer", () => {
  it("provides an implementation that still validates and defaults its ceilings", async () => {
    const observed: Array<Sandbox.Limits | undefined> = []
    const opened: Sandbox.Realm = { evaluate: () => Effect.die("unused") }
    const layer = Sandbox.layer({
      capabilities: { calls: true, memoryBytes: false, steps: false, timeMs: true },
      openRealm: (options) =>
        Effect.sync(() => {
          observed.push(options.limits)
          return opened
        })
    })

    const [defaulted, refused] = await Effect.gen(function*() {
      const sandbox = yield* Sandbox.Sandbox
      return [
        yield* sandbox.openRealm!({ flows: {} }),
        yield* Effect.result(sandbox.openRealm!({ flows: {}, limits: { calls: -1 } }))
      ] as const
    }).pipe(Effect.provide(layer), Effect.scoped, Effect.runPromise)

    // The ceilings the declared capabilities can enforce are filled in, and the
    // one they cannot (`memoryBytes`) is left absent rather than invented.
    expect(observed).toEqual([{
      calls: Sandbox.defaultLimits.calls,
      steps: undefined,
      timeMs: Sandbox.defaultLimits.timeMs,
      totalMs: Sandbox.defaultLimits.totalMs,
      callMs: Sandbox.defaultLimits.callMs
    }])
    expect(defaulted).toBe(opened)
    expect(refused).toMatchObject({ _tag: "Failure", failure: { code: "unsupported" } })
  })
})

describe("Sandbox.driveCell", () => {
  it("takes the shipped per-call ceiling when the caller declares none", async () => {
    // A binding that fills its own ceilings never reaches this fallback, and a
    // caller driving the loop directly still gets a bounded call rather than an
    // unbounded one.
    const observed: Array<Sandbox.Invocation> = []
    let settled: Cell.Outcome | undefined
    const pending: Array<Sandbox.PendingCall> = [{
      ordinal: 0,
      flow: "fs/list",
      input: { path: "." },
      settle: () => {
        settled = new Cell.Settled({ transition: Sandbox.replTransition({ _tag: "Done", output: "ok" }, undefined) })
      },
      abort: () => {}
    }]

    const outcome = await Effect.runPromise(
      Sandbox.driveCell({
        pending,
        flush: () => {},
        finished: () => settled,
        abort: () => {},
        handler: handler({ "fs/list": { entries: [] } }, observed)
      })
    )

    expect(observed.map((call) => call.flow)).toEqual(["fs/list"])
    expect(outcome._tag).toBe("settled")
  })

  it("waits for a queued call the flush produced rather than calling the cell stalled", async () => {
    // The loop reaches its yield point only here: the queue was empty when it
    // last looked, and flushing the binding's jobs queued the next call.
    const observed: Array<Sandbox.Invocation> = []
    const pending: Array<Sandbox.PendingCall> = []
    let settled: Cell.Outcome | undefined
    let queued = false
    const queue = (ordinal: number): void => {
      pending.push({
        ordinal,
        flow: "fs/list",
        input: { path: "." },
        settle: () => {
          settled = new Cell.Settled({ transition: Sandbox.replTransition({ _tag: "Done", output: "ok" }, undefined) })
        },
        abort: () => {}
      })
    }

    const outcome = await Effect.runPromise(
      Sandbox.driveCell({
        pending,
        flush: () => {},
        finished: () => {
          if (queued) return settled
          queued = true
          queue(0)
          return undefined
        },
        abort: () => {},
        handler: handler({ "fs/list": { entries: [] } }, observed)
      })
    )

    expect(observed.map((call) => call.ordinal)).toEqual([0])
    expect(outcome._tag).toBe("settled")
  })
})

describe("QuickJSSandbox", () => {
  it("exposes a flow's input schema document in the cell realm", async () => {
    const outcome = await evaluate(
      `ctx.done(JSON.stringify(ctx.flows["fs/list"].input))`
    )

    expect(outcome).toMatchObject({
      _tag: "settled",
      transition: { _tag: "complete", output: JSON.stringify(listInputDocument) }
    })
  })

  it("preserves a JSON __proto__ key as an own data property", async () => {
    const payload = JSON.parse("{\"__proto__\":{\"unexpected\":\"prototype\"}}") as Schema.Json
    const outcome = await evaluate(
      `const result = await ctx.call("fs/list", {})
       ctx.done([
           Object.keys(result).join(","),
           Object.hasOwn(result, "__proto__"),
           Object.prototype.hasOwnProperty.call(result, "__proto__"),
           Object.getPrototypeOf(result) === Object.prototype ? "" : "yes",
           Object.getOwnPropertyDescriptor(result, "__proto__").writable
         ].join("|"))`,
      { call: handler({ "fs/list": payload }, []) }
    )

    expect(outcome).toMatchObject({
      _tag: "settled",
      transition: { _tag: "complete", output: "__proto__|true|true||true" }
    })
  })

  it("does not invoke hostile Object.prototype setters while materializing flow results", async () => {
    const outcome = await evaluate(
      `let captured = "missed"
       Object.defineProperty(Object.prototype, "entry", {
         configurable: true,
         set: function () { captured = "captured" }
       })
       const result = await ctx.call("fs/list", {})
       ctx.done([Object.hasOwn(result, "entry"), String(result.entry), captured].join("|"))`,
      { call: handler({ "fs/list": { entry: "preserved" } }, []) }
    )

    expect(outcome).toMatchObject({
      _tag: "settled",
      transition: { _tag: "complete", output: "true|preserved|missed" }
    })
  })

  it("does not invoke hostile Array.prototype setters while materializing flow results", async () => {
    const outcome = await evaluate(
      // The poison is removed before the cell ends: the realm outlives the
      // cell, so a booby-trapped `Array.prototype` left in place would be there
      // for the harness's own reflection as well as for the next cell.
      `var captured = "missed"
       Object.defineProperty(Array.prototype, 0, {
         configurable: true,
         set: function (value) { if (value === "preserved") captured = "captured" }
       })
       const result = await ctx.call("fs/list", {})
       const answer = [Object.hasOwn(result.entries, "0"), String(result.entries[0]), captured].join("|")
       delete Array.prototype[0]
       ctx.done(answer)`,
      { call: handler({ "fs/list": { entries: ["preserved"] } }, []) }
    )

    expect(outcome).toMatchObject({
      _tag: "settled",
      transition: { _tag: "complete", output: "true|preserved|missed" }
    })
  })

  it("carries a 2 MB flow result across the WebAssembly boundary", async () => {
    const payload = `${"x".repeat(2 * 1024 * 1024)}🗼`
    const outcome = await evaluate(
      `const text = await ctx.call("fs/list", { path: "big" })
       ctx.done(text.length + ":" + text.slice(-2))`,
      { call: handler({ "fs/list": payload }, []) }
    )

    expect(outcome._tag).toBe("settled")
    expect((outcome as Cell.Settled).transition).toMatchObject({
      _tag: "complete",
      output: `${payload.length}:🗼`
    })
  }, 60_000)

  it("rejects pathological memory limits before QuickJS initialization", async () => {
    for (const memoryBytes of [0, 1]) {
      const result = await Effect.gen(function*() {
        const sandbox = yield* Sandbox.Sandbox
        return yield* Effect.result(sandbox.openRealm!({ flows, limits: { memoryBytes } }))
      }).pipe(Effect.provide(QuickJSSandbox.layer), Effect.scoped, Effect.runPromise)

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: {
          code: "unsupported",
          message: `The memoryBytes limit must be a safe integer of at least ${Sandbox.minimumMemoryBytes} bytes`
        }
      })
    }
  })

  it("enforces a declared memory limit", async () => {
    const outcome = await evaluate(
      `const held = []
       for (let index = 0; index < 100000; index++) held.push({ index: index, pad: "x".repeat(64) })
       ctx.done(String(held.length))`,
      { limits: { memoryBytes: Sandbox.minimumMemoryBytes } }
    )
    expect(outcome).toStrictEqual(new Cell.Raised({ name: "InternalError", message: "out of memory" }))
  })

  it("stops a cell that awaits something the realm can never settle", async () => {
    const outcome = await evaluate(`await new Promise(() => {})`)
    expect(outcome._tag).toBe("rejected")
    expect((outcome as Cell.Rejected).code).toBe("stalled")
  })

  it("enforces a declared step limit", async () => {
    const outcome = await evaluate(
      `let total = 0
       for (let index = 0; index < 100000000; index++) total += index
       ctx.done(String(total))`,
      { limits: { steps: 100 } }
    )
    expect(outcome).toMatchObject({
      _tag: "rejected",
      code: "limit_exceeded",
      message: "This cell exceeded its limit of 100 interpreter steps"
    })
  })

  it("enforces default ceilings when the caller omits limits", async () => {
    const outcome = await evaluate(
      `let total = 0
       while (true) total += 1`
    )

    expect(outcome).toMatchObject({ _tag: "rejected", code: "limit_exceeded" })
  })

  it("bounds a stalled flow call with the whole-evaluation ceiling, not the compute clock", async () => {
    let handlerEntered = false
    const outcome = await evaluate(
      `await ctx.call("fs/list", {})
       ctx.done("unreachable")`,
      {
        call: () =>
          Effect.sync(() => {
            handlerEntered = true
          }).pipe(Effect.andThen(Effect.never)),
        limits: { timeMs: 60_000, totalMs: 250, steps: Number.MAX_SAFE_INTEGER }
      }
    )

    expect(handlerEntered).toBe(true)
    expect(outcome).toMatchObject({
      _tag: "rejected",
      code: "limit_exceeded",
      message: "This cell exceeded its wall-clock limit of 250 milliseconds"
    })
  })

  it("refunds a settled flow call's duration to the compute clock", async () => {
    // The call takes longer than the whole compute budget. Charging its
    // duration to the cell rejected every frame that awaited a real test run;
    // the settled call must instead resume the cell with its budget intact.
    // The compute clock is a counter the call advances past the budget, and
    // the loop after the call is what makes the realm read it again.
    let now = 0
    const outcome = await Effect.gen(function*() {
      const sandbox = yield* QuickJSSandbox.makeWithClock
      const realm = yield* sandbox.openRealm!({
        flows,
        limits: { timeMs: 1_000, totalMs: 60_000, steps: Number.MAX_SAFE_INTEGER }
      })
      const frame = yield* realm.evaluate({
        cell: Cell.source(
          `const listed = await ctx.call("fs/list", {})
           let sum = 0
           for (let index = 0; index < 100000; index++) sum += index
           ctx.done(String(listed.ok))`
        ),
        frame: 0,
        call: () =>
          Effect.sync(() => {
            now += 5_000
            return new Cell.CallResult({ outcome: "success", value: { ok: true } })
          })
      })
      return frame.outcome
    }).pipe(
      Effect.provideService(QuickJSSandbox.ComputeClock, { now: () => now++ }),
      Effect.scoped,
      Effect.runPromise
    )

    expect(outcome).toMatchObject({ _tag: "settled", transition: { _tag: "complete", output: "true" } })
  })
})
