import { Context, Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Author from "../src/Author.ts"
import * as QuickJsRunner from "../src/QuickJsRunner.ts"
import * as ScriptRunner from "../src/ScriptRunner.ts"
import { flow, runChain, runOn } from "./harness.ts"

const jsonContext: ReadonlyArray<unknown> = [
  { toString: null },
  { toString: 1 },
  { toString: "x" },
  { toString: {} },
  { toString: null, nested: { toString: null } },
  [{ toString: null }],
  { nested: { toString: null } }
]
const normalizedContext = [
  "{\"toString\":null}",
  "{\"toString\":1}",
  "{\"toString\":\"x\"}",
  "{\"toString\":{}}",
  "{\"toString\":null,\"nested\":{\"toString\":null}}",
  "[{\"toString\":null}]",
  "[object Object]"
]

const authorWith = (layer: ReturnType<typeof Author.layerMock>, input: Author.Input) =>
  runOn(layer, Effect.flatMap(Author.Author, (author) => author.author(input)))

const input: Author.Input = { context: ["goal"], prefix: "" }

describe("Author", () => {
  it("pops mocked outputs in order and then exhausts", async () => {
    const layer = Author.layerMock(["one", "two"])
    const { error, first, second } = await runOn(
      layer,
      Effect.gen(function*() {
        const author = yield* Author.Author
        const first = yield* author.author(input)
        const second = yield* author.author(input)
        const error = yield* Effect.flip(author.author(input))
        return { error, first, second }
      })
    )
    expect(first).toBe("one")
    expect(second).toBe("two")
    expect(error.code).toBe("exhausted")
    expect(error.message).toContain("2")
  })

  it("computes output from input with layerFn", async () => {
    const layer = Author.layerFn((seen) => `prefix=${seen.prefix} context=${seen.context.join(",")}`)
    const output = await authorWith(layer, { context: ["a", "b"], prefix: "P" })
    expect(output).toBe("prefix=P context=a,b")
  })

  it("fails as noop with a typed error", async () => {
    const error = await Effect.runPromise(Effect.flip(Author.makeNoop().author(input)))
    expect(error.code).toBe("author_unavailable")
  })

  it("accepts noop overrides and provides the noop layer", async () => {
    const overridden = Author.makeNoop({ author: () => Effect.succeed("canned") })
    expect(await Effect.runPromise(overridden.author(input))).toBe("canned")
    const error = await runOn(
      Author.layerNoop(),
      Effect.flip(Effect.flatMap(Author.Author, (author) => author.author(input)))
    )
    expect(error.code).toBe("author_unavailable")
  })

  it("normalizes author payloads to context lines", () => {
    expect(Author.contextOf({ context: ["a", 1, true] })).toEqual(["a", "1", "true"])
    expect(Author.contextOf({ context: "not an array" })).toEqual([])
    expect(Author.contextOf({ other: 1 })).toEqual([])
    expect(Author.contextOf(null)).toEqual([])
    expect(Author.contextOf("garbage")).toEqual([])
  })

  it.each(jsonContext.map((part, index) => [part, normalizedContext[index]] as const))(
    "normalizes JSON context with shadowed toString: %j",
    (part, expected) => {
      expect(Author.contextOf(JSON.parse(JSON.stringify({ context: [part] })))).toEqual([expected])
    }
  )

  it.each(
    [
      ["in-process", ScriptRunner.layerInProcess],
      ["quickjs", QuickJsRunner.layer()]
    ] as const
  )("settles and replays JSON author context through %s", async (_name, runner) => {
    const seen: Array<Author.Input> = []
    const first = await runChain({
      runner,
      author: Author.layerFn((input) => {
        seen.push(input)
        return seen.length === 1
          ? flow(
            `const next = await ctx.call("author", ${JSON.stringify({ context: jsonContext })})`,
            `return to(next)`
          )
          : flow(`return done("recovered")`)
      })
    })
    expect(first.outcome).toEqual({ _tag: "Done", value: "recovered" })
    expect(seen).toHaveLength(2)
    expect(seen[1]?.context).toEqual(normalizedContext)
    expect(first.events.filter((event) => event._tag === "CallSettled" && event.name === "author"))
      .toHaveLength(2)

    const replay = await runChain({
      runner,
      author: Author.layerMock([]),
      initial: first.events
    })
    expect(replay).toEqual(first)
  })

  it("uses a placeholder when both coercion and JSON serialization fail", () => {
    const circular = { toString: null, nested: {} }
    circular.nested = circular
    expect(Author.contextOf({ context: [circular] })).toEqual(["[unprintable context]"])
    expect(Author.contextOf({ context: [{ toString: null, toJSON: () => undefined }] }))
      .toEqual(["[unprintable context]"])
  })
})

/** A service no chain test layer provides. */
class Unprovided extends Context.Service<Unprovided, { readonly value: string }>()("test/chain/Author/Unprovided") {}

/** Never called; tsc checks it (#2704). */
const unprovidedServiceProbe = () => {
  // @ts-expect-error the author layer does not provide Unprovided
  runOn(Author.layerMock([]), Effect.map(Unprovided, (service) => service.value))
  runOn(Author.layerMock([]), Effect.map(Author.Author, (author) => author))
}

describe("regression: Remaining provide-then-cast test helpers erase layer requirements (follow-up to #2347)", () => {
  it("rejects a body that needs a service its layer does not provide", () => {
    // The assertion is the `@ts-expect-error` directive above.
    expect(unprovidedServiceProbe).toBeTypeOf("function")
  })
})
