import * as Effect from "effect/Effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as Scorer from "../src/Scorer.ts"
import { ScorerError } from "../src/ScorerError.ts"

const quality = (overrides: Partial<Scorer.MakeOptions> = {}) =>
  Scorer.make({
    id: "packages/smithers/agent/scorers/test/Scorer/quality",
    version: "1",
    name: "quality",
    score: () => Effect.succeed({ score: 1 }),
    ...overrides
  })

const declarationFailure = (build: () => unknown): ScorerError => {
  try {
    build()
  } catch (error) {
    if (error instanceof ScorerError) return error
    throw error
  }
  throw new Error("expected a declaration failure")
}

describe("Scorer", () => {
  it("keeps score as the only implementation", async () => {
    expectTypeOf<Extract<keyof Scorer.MakeOptions, "body" | "model" | "flows">>().toEqualTypeOf<never>()
    const scorer = quality()
    await expect(Effect.runPromise(scorer.score({ input: "question", output: "answer" }))).resolves.toEqual({
      score: 1
    })
  })

  it.each([
    ["model", "judge"],
    ["flows", []],
    ["body", () => Effect.succeed({ score: 0 })],
    ["model", undefined],
    ["flows", undefined],
    ["body", undefined]
  ])("refuses the flow implementation option %s (%s) at construction", (key, value) => {
    // Computed keys exercise untyped callers that bypass MakeOptions.
    const failure = declarationFailure(() => quality({ [key]: value }))
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toBe(`A scorer must not declare ${key}; use score as its only implementation`)
  })

  it("names a scorer that named nothing after its own id, and keeps a declared name", () => {
    const anonymous = Scorer.make({
      id: "packages/smithers/agent/scorers/test/Scorer/anonymous",
      version: "1",
      score: () => Effect.succeed({ score: 1 })
    })
    expect(anonymous.name).toBe("packages/smithers/agent/scorers/test/Scorer/anonymous")
    expect(quality().name).toBe("quality")
    // The name is not part of the scorer's identity, so adopting the id as a
    // name cannot move a stored observation to a second key.
    expect(anonymous.scorerKey).toBe(
      Scorer.make({
        id: "packages/smithers/agent/scorers/test/Scorer/anonymous",
        version: "1",
        name: "named-differently",
        score: () => Effect.succeed({ score: 1 })
      }).scorerKey
    )
  })

  it("has an independent declaration key and validates scores", async () => {
    const scorer = quality()
    expect(scorer.scorerKey).toMatch(/^[0-9a-f]{64}$/)
    await expect(
      Effect.runPromise(Scorer.validate({ score: 2, reason: "bad" }))
    ).rejects.toMatchObject({ code: "invalid_score" })
  })

  it("uses explicit identity and canonical configuration, never closure source", () => {
    const make = (score: number, config: unknown) =>
      Scorer.make({
        id: "packages/smithers/agent/scorers/test/Scorer/configured",
        version: "2",
        config,
        score: () => Effect.succeed({ score })
      })
    expect(make(0, { b: 2, a: 1 }).scorerKey).toBe(make(1, { a: 1, b: 2 }).scorerKey)
    expect(make(0, { a: 1 }).scorerKey).not.toBe(make(0, { a: 2 }).scorerKey)
  })

  it("freezes the scorer key for a fixed declaration", () => {
    // A canonicalization or hashing change orphans every observation already
    // stored under the old key, so it must fail here rather than silently
    // start a second identity for the same scorer.
    const scorer = Scorer.make({
      // An opaque identity, not a path. It is the digest's input, so it stays
      // byte-for-byte what it was however the directory tree is arranged:
      // changing it would start a second identity for the same scorer, which
      // is the thing this cell exists to refuse.
      id: "packages/scorers/test/Scorer/frozen",
      version: "1",
      config: { rubric: "exact", threshold: 0.5 },
      score: () => Effect.succeed({ score: 1 })
    })
    expect(scorer.scorerKey).toBe("38fd2f0ee22ca194504029c045badc60f34eb53a6137384fc58581ce135875a0")
  })

  it.each([
    ["a function member", { rubric: () => 1 }, "config.rubric is function"],
    ["a symbol member", { rubric: Symbol("x") }, "config.rubric is symbol"],
    ["an undefined member", { rubric: undefined }, "config.rubric is undefined"],
    ["a bigint member", { rubric: 1n }, "config.rubric is bigint"],
    ["a non-finite member", { rubric: Number.POSITIVE_INFINITY }, "config.rubric is a non-finite number"],
    ["a nested lost member", { nested: { deep: [1, () => 1] } }, "config.nested.deep[1] is function"]
  ])("refuses a configuration carrying %s", (_name, config, expected) => {
    const failure = declarationFailure(() =>
      Scorer.make({ id: "id", version: "1", config, score: () => Effect.succeed({ score: 1 }) })
    )
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toContain(expected)
  })

  it("refuses a configuration nested past the walk bound by path", () => {
    let config: unknown = "leaf"
    for (let depth = 0; depth <= 1_000; depth += 1) config = { next: config }
    const failure = declarationFailure(() =>
      Scorer.make({ id: "id", version: "1", config, score: () => Effect.succeed({ score: 1 }) })
    )
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toContain("config.next.next")
    expect(failure.message).toMatch(/ is nested deeper than 1000 levels$/)
  })

  it("refuses a non-enumerable own property instead of sharing the plain configuration key", () => {
    const config = { a: 1 }
    Object.defineProperty(config, "x", { value: 1, enumerable: false })
    const failure = declarationFailure(() =>
      Scorer.make({ id: "id", version: "1", config, score: () => Effect.succeed({ score: 1 }) })
    )
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toContain("config.x is a non-enumerable property")
    expect(
      Scorer.make({ id: "id", version: "1", config: { a: 1 }, score: () => Effect.succeed({ score: 1 }) })
        .scorerKey
    ).toMatch(/^[0-9a-f]{64}$/)
  })

  it("refuses a configuration with a symbol key or a cycle", () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(
      declarationFailure(() =>
        Scorer.make({ id: "id", version: "1", config: cyclic, score: () => Effect.succeed({ score: 1 }) })
      ).message
    ).toContain("config.self is circular")
    expect(
      declarationFailure(() =>
        Scorer.make({
          id: "id",
          version: "1",
          config: { [Symbol("hidden")]: 1 },
          score: () => Effect.succeed({ score: 1 })
        })
      ).message
    ).toContain("has a symbol-keyed property")
  })

  it("refuses a non-index property on an array instead of sharing the plain array key", () => {
    const decorated = Object.assign([], { extra: 1 })
    const failure = declarationFailure(() =>
      Scorer.make({
        id: "id",
        version: "1",
        config: { a: decorated },
        score: () => Effect.succeed({ score: 1 })
      })
    )
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toContain("config.a.extra is a non-index array property")
    const nonEnumerable: unknown[] = []
    Object.defineProperty(nonEnumerable, "extra", { value: 1 })
    expect(
      declarationFailure(() =>
        Scorer.make({
          id: "id",
          version: "1",
          config: { a: nonEnumerable },
          score: () => Effect.succeed({ score: 1 })
        })
      ).message
    ).toContain("config.a.extra is a non-index array property")
    expect(
      Scorer.make({
        id: "id",
        version: "1",
        config: { a: [] },
        score: () => Effect.succeed({ score: 1 })
      }).scorerKey
    ).toMatch(/^[0-9a-f]{64}$/)
  })

  it("refuses a symbol-keyed property on an array", () => {
    const hidden = Symbol("hidden")
    const array = Object.assign([], { [hidden]: 1 })
    const failure = declarationFailure(() =>
      Scorer.make({ id: "id", version: "1", config: { a: array }, score: () => Effect.succeed({ score: 1 }) })
    )
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toContain("config.a has a symbol-keyed array property")
  })

  it("normalizes a configuration whose keys cannot be enumerated", () => {
    const hostile = new Proxy({}, {
      ownKeys: () => {
        throw new TypeError("no")
      }
    })
    const failure = declarationFailure(() =>
      Scorer.make({ id: "id", version: "1", config: { a: hostile }, score: () => Effect.succeed({ score: 1 }) })
    )
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toContain("config.a throws when keys are enumerated")
  })

  it("refuses a configuration whose member throws when read", () => {
    const config = {
      get rubric(): unknown {
        throw new TypeError("no")
      }
    }
    expect(
      declarationFailure(() =>
        Scorer.make({ id: "id", version: "1", config, score: () => Effect.succeed({ score: 1 }) })
      )
        .message
    ).toContain("config.rubric throws when read")
    const array = [1]
    Object.defineProperty(array, "0", {
      get: () => {
        throw new TypeError("no")
      }
    })
    expect(
      declarationFailure(() =>
        Scorer.make({ id: "id", version: "1", config: array, score: () => Effect.succeed({ score: 1 }) })
      ).message
    ).toContain("config[0] throws when read")
  })

  it.each([
    ["a Map", { index: new Map([["a", 1]]) }],
    ["a class instance", { at: new (class Marker {})() }]
  ])("normalizes the canonical refusal of %s", (_name, config) => {
    // `@smthrs/canonical` refuses these outright rather than collapsing them to
    // `{}`, so the walk lets them through and the catch has to convert the raw
    // SchemaError into this package's own failure.
    const failure = declarationFailure(() =>
      Scorer.make({ id: "id", version: "1", config, score: () => Effect.succeed({ score: 1 }) })
    )
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toBe("A scorer configuration could not be canonicalized")
  })

  it("refuses a configuration defining toJSON without calling it", () => {
    let calls = 0
    const config = {
      toJSON: () => {
        calls += 1
        return {}
      }
    }
    const failure = declarationFailure(() =>
      Scorer.make({ id: "id", version: "1", config, score: () => Effect.succeed({ score: 1 }) })
    )
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toContain("config defines toJSON")
    expect(calls).toBe(0)
    expect(
      declarationFailure(() =>
        Scorer.make({ id: "id", version: "1", config: { at: new Date(0) }, score: () => Effect.succeed({ score: 1 }) })
      ).message
    ).toContain("config.at defines toJSON")
  })

  it("refuses both toJSON replacements that would otherwise share a scorer key", () => {
    const failures = [
      { t: { toJSON: () => ({ f: () => 1 }) } },
      { t: { toJSON: () => ({}) } }
    ].map((config) =>
      declarationFailure(() =>
        Scorer.make({ id: "id", version: "1", config, score: () => Effect.succeed({ score: 1 }) })
      )
    )
    expect(failures.map((failure) => failure.code)).toEqual(["invalid_declaration", "invalid_declaration"])
    expect(failures.map((failure) => failure.message)).toEqual([
      expect.stringContaining("config.t defines toJSON"),
      expect.stringContaining("config.t defines toJSON")
    ])
  })

  it("normalizes an unexpected lossless-walk failure", () => {
    const config = new Proxy([], {
      get: (target, key, receiver) => {
        if (key === "length") throw new TypeError("no")
        return Reflect.get(target, key, receiver)
      }
    })
    const failure = declarationFailure(() =>
      Scorer.make({ id: "id", version: "1", config, score: () => Effect.succeed({ score: 1 }) })
    )
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toBe("A scorer configuration could not be inspected")
    expect(failure.cause).toBeDefined()
  })

  it.each([
    ["a nested array of plain values", { weights: [1, 2, { a: null }] }],
    ["an explicit null", null]
  ])("accepts a configuration carrying %s", (_name, config) => {
    const scorer = Scorer.make({
      id: "id",
      version: "1",
      config,
      score: () => Effect.succeed({ score: 1 })
    })
    expect(scorer.scorerKey).toMatch(/^[0-9a-f]{64}$/)
  })

  it.each([
    ["id", { id: " ", version: "1" }, "A scorer id must not be empty"],
    ["version", { id: "id", version: "" }, "A scorer version must not be empty"]
  ])("names the blank %s", (_name, options, expected) => {
    const failure = declarationFailure(() => Scorer.make({ ...options, score: () => Effect.succeed({ score: 1 }) }))
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toBe(expected)
  })

  it.each([
    ["id", { id: 1 as unknown as string, version: "1" }, "A scorer id must be a string"],
    ["version", { id: "id", version: 1 as unknown as string }, "A scorer version must be a string"]
  ])("names a non-string %s", (_name, options, expected) => {
    const failure = declarationFailure(() => Scorer.make({ ...options, score: () => Effect.succeed({ score: 1 }) }))
    expect(failure.code).toBe("invalid_declaration")
    expect(failure.message).toBe(expected)
  })

  it("distinguishes an untrimmed id from its trimmed form", () => {
    expect(quality({ id: " padded " }).scorerKey).not.toBe(quality({ id: "padded" }).scorerKey)
  })

  it.each([0, 1, 0.5])("accepts the boundary score %s", async (score) => {
    await expect(Effect.runPromise(Scorer.validate({ score }))).resolves.toEqual({ score })
  })

  it.each([
    -0.0001,
    1.0001,
    Number.NaN,
    Number.POSITIVE_INFINITY
  ])("rejects the out-of-contract score %s and names it", async (score) => {
    const failure = await Effect.runPromise(Effect.flip(Scorer.validate({ score })))
    expect(failure.code).toBe("invalid_score")
    expect(failure.message).toContain(`received ${String(score)}`)
    expect(failure.cause).toBeDefined()
  })

  it("reports a result that carries no score at all", async () => {
    const failure = await Effect.runPromise(Effect.flip(Scorer.validate({ reason: "none" })))
    expect(failure.code).toBe("invalid_score")
    expect(failure.message).toBe("A scorer result must carry a finite score in [0, 1]")
  })

  it("survives a result whose score cannot be read", async () => {
    const hostile = new Proxy({}, {
      has: () => true,
      get: () => {
        throw new TypeError("no")
      }
    })
    const failure = await Effect.runPromise(Effect.flip(Scorer.validate(hostile)))
    expect(failure.code).toBe("invalid_score")
  })
})
