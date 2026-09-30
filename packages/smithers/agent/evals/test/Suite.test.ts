import * as Flow from "@smthrs/core/Flow"
import * as Binding from "@smthrs/scorers/Binding"
import * as Scorer from "@smthrs/scorers/Scorer"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { EvalError } from "../src/EvalError.ts"
import * as Suite from "../src/Suite.ts"

/** Runs an effect that must fail and returns the typed failure it raised. */
const failure = (effect: Effect.Effect<unknown, EvalError>): Promise<EvalError> =>
  Effect.runPromise(Effect.flip(effect))

const target = Flow.make({ name: "suite-target" })
const scorer = Scorer.make({
  id: "packages/smithers/agent/evals/test/Suite/exact",
  version: "1",
  name: "exact",
  score: () => Effect.succeed({ score: 1 })
})

class JudgeUnavailable extends Schema.TaggedError<JudgeUnavailable>()(
  "packages/smithers/agent/evals/test/Suite/JudgeUnavailable",
  { model: Schema.String }
) {}

const judge = Scorer.make<JudgeUnavailable>({
  id: "packages/smithers/agent/evals/test/Suite/judge",
  version: "1",
  name: "judge",
  score: () => Effect.fail(new JudgeUnavailable({ model: "none" }))
})

describe("Suite", () => {
  it("pins the documented numeric ceilings", () => {
    expect(Suite.limits).toEqual({ cases: 10_000, concurrency: 1024, fixtureLength: 8_388_608 })
  })

  it.each([9_999, 10_000])("accepts %i unique cases", async (count) => {
    const cases = Array.from({ length: count }, (_, index) => ({ name: `case-${index}`, input: index }))
    const suite = await Effect.runPromise(Suite.make({ name: "boundary", concurrency: 1, cases }))
    expect(suite.cases).toHaveLength(count)
  })

  it.each([1023, 1024])("accepts concurrency %i", async (concurrency) => {
    const suite = await Effect.runPromise(
      Suite.make({ name: "boundary", concurrency, cases: [{ name: "a", input: 1 }] })
    )
    expect(suite.concurrency).toBe(concurrency)
  })

  it("rejects concurrency 1025", async () => {
    const error = await failure(Suite.make({ name: "boundary", concurrency: 1025, cases: [{ name: "a", input: 1 }] }))
    expect(error.code).toBe("invalid_suite")
    expect(error.message).toBe("Suite concurrency must be at most 1024, got 1025")
    expect(error.path).toBe("concurrency")
  })

  it.each([1, 1000])("accepts %i trials and keeps them on the suite", async (trials) => {
    const suite = await Effect.runPromise(
      Suite.make({ name: "boundary", concurrency: 1, trials, cases: [{ name: "a", input: 1 }] })
    )
    expect(suite.trials).toBe(trials)
  })

  it("runs one trial when the suite declares none", async () => {
    const suite = await Effect.runPromise(
      Suite.make({ name: "boundary", concurrency: 1, cases: [{ name: "a", input: 1 }] })
    )
    expect(suite.trials).toBe(1)
  })

  it.each([0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects %s trials", async (trials) => {
    const error = await failure(
      Suite.make({ name: "boundary", concurrency: 1, trials, cases: [{ name: "a", input: 1 }] })
    )
    expect(error.code).toBe("invalid_suite")
    expect(error.message).toBe("Suite trials must be an integer from 1 to 1000")
    expect(error.path).toBe("trials")
  })

  it("rejects an empty or control-character suite name", async () => {
    const empty = await failure(Suite.make({ name: "  ", concurrency: 1, cases: [{ name: "a", input: 1 }] }))
    expect(empty.code).toBe("invalid_suite")
    expect(empty.message).toBe("Suite name must not be empty")
    expect(empty.path).toBe("name")

    const control = await failure(Suite.make({ name: "a\u0000b", concurrency: 1, cases: [{ name: "a", input: 1 }] }))
    expect(control.message).toBe("Suite name must not contain the control character U+0000")
    expect(control.path).toBe("name")
  })

  it("rejects an empty, control-character, or duplicate case name", async () => {
    const blank = await failure(Suite.make({ name: "x", concurrency: 1, cases: [{ name: " ", input: 1 }] }))
    expect(blank.message).toBe("Suite case name must not be empty")
    expect(blank.path).toBe("cases[0].name")

    const control = await failure(
      Suite.make({ name: "x", concurrency: 1, cases: [{ name: "a", input: 1 }, { name: "b\u007F", input: 1 }] })
    )
    expect(control.message).toBe("Suite case name must not contain the control character U+007F")
    expect(control.path).toBe("cases[1].name")

    const duplicate = await failure(
      Suite.make({ name: "x", concurrency: 1, cases: [{ name: "a", input: 1 }, { name: "a", input: 2 }] })
    )
    expect(duplicate.message).toBe("Duplicate suite case: a")
    expect(duplicate.path).toBe("cases[1].name")
  })

  it("rejects a suite with no cases and one past the declared ceiling", async () => {
    const empty = await failure(Suite.make({ name: "x", concurrency: 1, cases: [] }))
    expect(empty.message).toBe("Suite must contain at least one case")
    expect(empty.path).toBe("cases")

    const tooMany = await failure(Suite.make({
      name: "x",
      concurrency: 1,
      cases: Array.from({ length: 10_001 }, (_, index) => ({ name: `case-${index}`, input: index }))
    }))
    expect(tooMany.message).toBe(
      "Suite must contain at most 10000 cases, got 10001"
    )
    expect(tooMany.path).toBe("cases")
  })

  it("rejects a concurrency that is not a safe integer inside the declared ceiling", async () => {
    const cases = [{ name: "a", input: 1 }]
    for (const concurrency of [0, -1, 1.5, Number.NaN]) {
      const error = await failure(Suite.make({ name: "x", concurrency, cases }))
      expect(error.message).toBe(`Suite concurrency must be a positive safe integer, got ${String(concurrency)}`)
      expect(error.path).toBe("concurrency")
    }
    const tooWide = await failure(
      Suite.make({ name: "x", concurrency: Number.MAX_SAFE_INTEGER, cases })
    )
    expect(tooWide.message).toBe(
      "Suite concurrency must be at most 1024, got 9007199254740991"
    )
  })

  // The run that produced a committed baseline has to be reproducible from the
  // suite value that was validated, so a suite cannot share mutable state with
  // the caller that declared it.
  it("snapshots case data and freezes the arrays it returns", async () => {
    const input = { mutable: 1 }
    const expected = { mutable: 1 }
    const cases = [{ name: "a", input, expected }]
    const suite = await Effect.runPromise(Suite.make({ name: "x", concurrency: 1, cases }))

    input.mutable = 999
    expected.mutable = 999
    cases.push({ name: "b", input: { mutable: 2 }, expected: { mutable: 2 } })

    expect(suite.cases).toHaveLength(1)
    expect(suite.cases[0]?.input).toEqual({ mutable: 1 })
    expect(suite.cases[0]?.expected).toEqual({ mutable: 1 })
    expect(Object.isFrozen(suite.cases)).toBe(true)
    expect(Object.isFrozen(suite.bindings)).toBe(true)
  })

  it("deeply freezes suite data without freezing executable identities", async () => {
    const data = { rows: [{ count: 1 }] }
    const bound = Binding.make({
      scorer,
      appliesTo: target,
      groundTruth: data,
      context: data,
      sampling: { ratio: 1, seed: "stable" }
    })
    const suite = await Effect.runPromise(Suite.make({
      name: "frozen",
      concurrency: 1,
      cases: [{ name: "a", input: data, expected: data }],
      bindings: [bound]
    }))
    for (const value of [suite, suite.cases[0], suite.bindings[0], suite.bindings[0]!.sampling]) {
      expect(Object.isFrozen(value)).toBe(true)
    }
    for (
      const value of [
        suite.cases[0]!.input,
        suite.cases[0]!.expected,
        suite.bindings[0]!.groundTruth,
        suite.bindings[0]!.context
      ]
    ) {
      const copied = value as typeof data
      expect(Object.isFrozen(copied)).toBe(true)
      expect(Object.isFrozen(copied.rows)).toBe(true)
      expect(Object.isFrozen(copied.rows[0])).toBe(true)
      expect(() => {
        copied.rows[0]!.count = 2
      }).toThrow(TypeError)
    }
    expect(suite.bindings[0]!.scorer).toBe(scorer)
    expect(suite.bindings[0]!.appliesTo).toBe(target)
    expect(Object.isFrozen(scorer)).toBe(false)
    expect(Object.isFrozen(target)).toBe(false)
  })

  it("rejects custom prototypes at nested case and binding paths", async () => {
    class Fixture {
      number = 2
      double() {
        return this.number * 2
      }
    }
    const data = { rows: [new Fixture()] }
    const options = { name: "classes", concurrency: 1, cases: [{ name: "a", input: 1 }] }
    for (const field of ["input", "expected"] as const) {
      const error = await failure(Suite.make({ ...options, cases: [{ name: "a", input: 1, [field]: data }] }))
      expect(error.code).toBe("invalid_suite")
      expect(error.path).toBe(`cases[0].${field}.rows[0]`)
    }
    for (const field of ["groundTruth", "context", "sampling"] as const) {
      const error = await failure(Suite.make({
        ...options,
        bindings: [{
          ...Binding.make({ scorer, appliesTo: target }),
          [field]: data
        } as Suite.Binding]
      }))
      expect(error.code).toBe("invalid_suite")
      expect(error.path).toBe(`bindings[0].${field}.rows[0]`)
    }
  })

  it("rejects mutable built-in collections and other non-plain objects", async () => {
    for (
      const value of [
        new Map([["count", 1]]),
        new Set([1]),
        new Date(),
        /x/,
        new Uint8Array([1]),
        new ArrayBuffer(1),
        Object.create({ inherited: 1 })
      ]
    ) {
      const error = await failure(Suite.make({
        name: "collections",
        concurrency: 1,
        cases: [{ name: "a", input: { value } }]
      }))
      expect(error.code).toBe("invalid_suite")
      expect(error.path).toBe("cases[0].input.value")
    }
  })

  it("returns invalid_suite when structuredClone rejects an otherwise plain proxy", async () => {
    const error = await failure(Suite.make({
      name: "proxy",
      concurrency: 1,
      cases: [{ name: "a", input: new Proxy({ count: 1 }, {}) }]
    }))
    expect(error.code).toBe("invalid_suite")
    expect(error.path).toBe("cases[0].input")
    expect(error.cause).toBeDefined()
  })

  it("rejects accessors and properties structuredClone would discard", async () => {
    let reads = 0
    const accessor = {
      get value() {
        reads += 1
        return 1
      }
    }
    const hidden = Object.defineProperty({}, "value", { value: 1 })
    const symbolKey = { [Symbol("value")]: 1 }
    for (
      const [input, path] of [
        [accessor, "value"],
        [hidden, "value"],
        [symbolKey, "Symbol(value)"],
        [{ value: Symbol("value") }, "value"],
        [{ value: () => 1 }, "value"]
      ] as const
    ) {
      const error = await failure(Suite.make({
        name: "properties",
        concurrency: 1,
        cases: [{ name: "a", input }]
      }))
      expect(error.code).toBe("invalid_suite")
      expect(error.path).toBe(`cases[0].input.${path}`)
    }
    expect(reads).toBe(0)
  })

  it("snapshots cycles, shared references, null-prototype records and cloneable primitives", async () => {
    const record = Object.assign(Object.create(null), { value: 1 })
    const input: { values: unknown[]; self?: unknown } = {
      values: [record, record, undefined, null, true, "x", 1n, NaN, Infinity, -0]
    }
    input.self = input
    const suite = await Effect.runPromise(Suite.make({
      name: "graph",
      concurrency: 1,
      cases: [{ name: "a", input }]
    }))
    const copy = suite.cases[0]!.input as typeof input
    expect(copy).not.toBe(input)
    expect(copy.self).toBe(copy)
    expect(copy.values[0]).toBe(copy.values[1])
    expect(copy.values).toEqual(input.values)
    expect(Object.isFrozen(copy)).toBe(true)
    expect(Object.isFrozen(copy.values[0])).toBe(true)
  })

  it("validates and copies one options snapshot when the effect runs", async () => {
    const cases = [{ name: "a", input: { value: 1 } }]
    const options = { name: "before", concurrency: 1, cases }
    const effect = Suite.make(options)

    options.name = "after"
    options.concurrency = 2
    cases.push({ name: "b", input: { value: 2 } })

    const suite = await Effect.runPromise(effect)
    options.name = "too late"
    cases[0]!.input.value = 999
    cases.push({ name: "c", input: { value: 3 } })

    expect(suite.name).toBe("after")
    expect(suite.concurrency).toBe(2)
    expect(suite.cases).toEqual([
      { name: "a", input: { value: 1 } },
      { name: "b", input: { value: 2 } }
    ])

    const invalidCases = [{ name: "a", input: 1 }]
    const invalidOptions = { name: "valid", concurrency: 1, cases: invalidCases }
    const invalidEffect = Suite.make(invalidOptions)
    invalidOptions.name = ""
    invalidOptions.concurrency = 0
    invalidCases.splice(0)

    const error = await failure(invalidEffect)
    expect(error.code).toBe("invalid_suite")
    expect(error.message).toBe("Suite name must not be empty")
    expect(error.path).toBe("name")
  })

  // Reading a field twice let a getter return the name validation accepted and
  // then a different one into the suite, the same hole a baseline record had.
  it("reads each case and binding field once, so a getter cannot diverge", async () => {
    let reads = 0
    const shifting: Suite.Case = {
      get name() {
        reads += 1
        return reads === 1 ? "a" : "b injected"
      },
      input: 1
    }
    const suite = await Effect.runPromise(Suite.make({ name: "once", concurrency: 1, cases: [shifting] }))
    expect(reads).toBe(1)
    expect(suite.cases[0]?.name).toBe("a")

    let samplingReads = 0
    const binding = {
      ...Binding.make({ scorer, appliesTo: target }),
      get sampling() {
        samplingReads += 1
        return { ratio: samplingReads === 1 ? 0.25 : 0.75, seed: "s" }
      }
    }
    const bound = await Effect.runPromise(
      Suite.make({ name: "once", concurrency: 1, cases: [{ name: "a", input: 1 }], bindings: [binding] })
    )
    expect(samplingReads).toBe(1)
    expect(bound.bindings[0]?.sampling).toEqual({ ratio: 0.25, seed: "s" })
  })

  it("snapshots binding data and keeps the scorer and target by reference", async () => {
    const groundTruth = { answer: 1 }
    const context = { rubric: "exact" }
    const binding = Binding.make({ scorer, appliesTo: target, groundTruth, context })
    const suite = await Effect.runPromise(
      Suite.make({ name: "x", concurrency: 1, cases: [{ name: "a", input: 1 }], bindings: [binding] })
    )
    groundTruth.answer = 999
    context.rubric = "changed"

    expect(suite.bindings[0]?.groundTruth).toEqual({ answer: 1 })
    expect(suite.bindings[0]?.context).toEqual({ rubric: "exact" })
    expect(suite.bindings[0]?.scorer).toBe(scorer)
    expect(suite.bindings[0]?.appliesTo).toBe(target)
    expect(suite.bindings[0]?.sampling).toBe("all")
  })

  it("snapshots a ratio sampling policy", async () => {
    const sampling = { ratio: 0.25, seed: "stable" }
    const binding = Binding.make({ scorer, appliesTo: target, sampling })
    const suite = await Effect.runPromise(
      Suite.make({ name: "x", concurrency: 1, cases: [{ name: "a", input: 1 }], bindings: [binding] })
    )

    sampling.ratio = 0.75
    sampling.seed = "changed"

    expect(suite.bindings[0]?.sampling).toEqual({ ratio: 0.25, seed: "stable" })
    expect(suite.bindings[0]?.sampling).not.toBe(sampling)
  })

  it("keeps a binding without ground truth or context bare", async () => {
    const suite = await Effect.runPromise(
      Suite.make({
        name: "x",
        concurrency: 1,
        cases: [{ name: "a", input: 1 }],
        bindings: [Binding.make({ scorer, appliesTo: target })]
      })
    )
    expect(Object.hasOwn(suite.bindings[0]!, "groundTruth")).toBe(false)
    expect(Object.hasOwn(suite.bindings[0]!, "context")).toBe(false)
    expect(Object.hasOwn(suite.cases[0]!, "expected")).toBe(false)

    const withoutSampling = {
      scorer,
      appliesTo: target,
      sampling: undefined
    } as unknown as Suite.Binding
    const legacy = await Effect.runPromise(
      Suite.make({ name: "legacy", concurrency: 1, cases: [{ name: "a", input: 1 }], bindings: [withoutSampling] })
    )
    expect(legacy.bindings[0]?.sampling).toBeUndefined()
  })

  it("rejects case and binding data that cannot be snapshotted", async () => {
    const message = "Suite data must be structured-cloneable so the suite cannot change after it is validated"

    const badInput = await failure(Suite.make({ name: "x", concurrency: 1, cases: [{ name: "a", input: () => 1 }] }))
    expect(badInput.code).toBe("invalid_suite")
    expect(badInput.message).toBe(message)
    expect(badInput.path).toBe("cases[0].input")

    const badExpected = await failure(
      Suite.make({ name: "x", concurrency: 1, cases: [{ name: "a", input: 1, expected: () => 1 }] })
    )
    expect(badExpected.path).toBe("cases[0].expected")

    const badGroundTruth = await failure(Suite.make({
      name: "x",
      concurrency: 1,
      cases: [{ name: "a", input: 1 }],
      bindings: [Binding.make({ scorer, appliesTo: target, groundTruth: () => 1 })]
    }))
    expect(badGroundTruth.path).toBe("bindings[0].groundTruth")

    const badContext = await failure(Suite.make({
      name: "x",
      concurrency: 1,
      cases: [{ name: "a", input: 1 }],
      bindings: [Binding.make({ scorer, appliesTo: target, context: () => 1 })]
    }))
    expect(badContext.path).toBe("bindings[0].context")
  })

  it("loads JSON Lines in declaration order, skipping blank lines", async () => {
    const suite = await Effect.runPromise(
      Suite.fromJsonLines("{\"name\":\"first\",\"input\":1}\n\n{\"name\":\"second\",\"input\":2}", {
        name: "fixture",
        concurrency: 2
      })
    )
    expect(suite.cases.map((suiteCase) => suiteCase.name)).toEqual(["first", "second"])
  })

  it("accepts a byte-order mark, CRLF endings, a trailing newline, and `expected`", async () => {
    const suite = await Effect.runPromise(
      Suite.fromJsonLines(
        "\uFEFF{\"name\":\"first\",\"input\":1,\"expected\":\"a\"}\r\n{\"name\":\"second\",\"input\":2}\r\n",
        { name: "fixture", concurrency: 1 }
      )
    )
    expect(suite.cases).toEqual([
      { name: "first", input: 1, expected: "a" },
      { name: "second", input: 2 }
    ])
  })

  it("names the 1-based line of a malformed or schema-invalid fixture line", async () => {
    const malformed = await failure(
      Suite.fromJsonLines("{\"name\":\"a\",\"input\":1}\n{not json}", { name: "f", concurrency: 1 })
    )
    expect(malformed.message).toBe("Invalid JSON on line 2")
    expect(malformed.path).toBe("line[2]")

    const invalid = await failure(
      Suite.fromJsonLines("{\"input\":1}", { name: "f", concurrency: 1 })
    )
    expect(invalid.message).toBe("Invalid suite case on line 1")
    expect(invalid.path).toBe("line[1]")
  })

  it.each([9_999, 10_000])("loads %i JSON Lines cases with trailing blank lines", async (count) => {
    const text = Array.from({ length: count }, (_, index) => JSON.stringify({ name: `case-${index}`, input: index }))
      .join("\n") + "\n \t\n"
    const suite = await Effect.runPromise(Suite.fromJsonLines(text, { name: "boundary", concurrency: 1 }))
    expect(suite.cases).toHaveLength(count)
  })

  it.each(["valid", "malformed", "schema-invalid"])(
    "stops before decoding a %s excess JSON Lines case",
    async (kind) => {
      const lines = Array.from(
        { length: 10_000 },
        (_, index) => JSON.stringify({ name: `case-${index}`, input: index })
      )
      const extra = kind === "valid" ? "{\"name\":\"excess\",\"input\":1}" : kind === "malformed" ? "not JSON" : "{}"
      const error = await failure(Suite.fromJsonLines(
        [...lines, extra, "deliberately not JSON"].join("\n"),
        { name: "boundary", concurrency: 1 }
      ))
      expect(error.code).toBe("invalid_suite")
      expect(error.message).toBe("Suite must contain at most 10000 cases, got 10001")
      expect(error.path).toBe("cases")
    }
  )

  it.each([8_388_607, 8_388_608, 8_388_609])("checks a fixture of %i UTF-16 code units", async (length) => {
    // The astral character occupies two UTF-16 code units, but one code point
    // and four UTF-8 bytes. Padding inside the JSON string survives trim().
    const prefix = "{\"name\":\"astral\",\"input\":\"😀"
    const suffix = "\"}"
    const padding = "x".repeat(length - prefix.length - suffix.length)
    const text = prefix + padding + suffix
    expect(text.length).toBe(length)
    const effect = Suite.fromJsonLines(text, { name: "boundary", concurrency: 1 })
    if (length === 8_388_609) {
      const error = await failure(effect)
      expect(error.code).toBe("invalid_suite")
      expect(error.message).toBe("JSON Lines fixture must be at most 8388608 characters, got 8388609")
      expect(error.path).toBe("text")
    } else {
      const suite = await Effect.runPromise(effect)
      expect(suite.cases).toHaveLength(1)
      expect(suite.cases[0]?.input).toBe("😀" + padding)
    }
  })

  it("refuses a fixture larger than the declared ceiling before parsing any of it", async () => {
    const oversize = await failure(
      Suite.fromJsonLines("x".repeat(8_388_609), { name: "f", concurrency: 1 })
    )
    expect(oversize.message).toBe(
      "JSON Lines fixture must be at most 8388608 characters, got 8388609"
    )
    expect(oversize.path).toBe("text")
  })

  it("loads the committed fixture beside these tests", async () => {
    const { readFile } = await import("node:fs/promises")
    const text = await readFile(new URL("./fixtures/suite.jsonl", import.meta.url), "utf8")
    const suite = await Effect.runPromise(Suite.fromJsonLines(text, { name: "fixture", concurrency: 1 }))
    expect(suite.cases.map((suiteCase) => suiteCase.name)).toEqual(["adds numbers", "multiplies numbers"])
  })

  it("accepts bindings whose scorers declare their own failures", async () => {
    // Compile-time: `Suite.Binding` is `@smthrs/scorers`'s binding, so a suite
    // holds scorers with unrelated typed failures without a cast.
    const suite = await Effect.runPromise(Suite.make({
      name: "typed-scorers",
      concurrency: 1,
      cases: [{ name: "a", input: 1 }],
      bindings: [
        Binding.make({ scorer, appliesTo: target }),
        Binding.make({ scorer: judge, appliesTo: target })
      ]
    }))
    expect(suite.bindings.map((binding) => binding.scorer.name)).toEqual(["exact", "judge"])
  })
})
