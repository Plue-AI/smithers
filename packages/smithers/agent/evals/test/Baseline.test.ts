import * as Effect from "effect/Effect"
import { describe, expect, it, vi } from "vitest"
import * as Baseline from "../src/Baseline.ts"
import type { EvalError } from "../src/EvalError.ts"

/** Runs an effect that must fail and returns the typed failure it raised. */
const failure = (effect: Effect.Effect<unknown, EvalError>): Promise<EvalError> =>
  Effect.runPromise(Effect.flip(effect))

const record = { suite: "s", case: "c", scorer: "x", stepKey: "k", score: 0.5 }

describe("Baseline", () => {
  it("builds records only from successful score observations", async () => {
    const baseline = await Effect.runPromise(Baseline.fromRun({
      runId: "run",
      suite: "suite",
      cases: [],
      observations: [
        {
          case: "scored",
          scorer: "judge",
          scorerName: "judge-name",
          stepKey: "step-1",
          kind: "score",
          score: 0.75,
          at: "now"
        },
        { case: "bare", scorer: "judge", stepKey: "step-3", kind: "score", score: 0.25, at: "now" },
        { case: "skipped", scorer: "judge", stepKey: "step-2", kind: "inconclusive", reason: "unavailable", at: "now" }
      ]
    }))

    expect(baseline.suite).toBe("suite")
    expect(baseline.records).toEqual([
      { suite: "suite", case: "scored", scorer: "judge", scorerName: "judge-name", stepKey: "step-1", score: 0.75 },
      { suite: "suite", case: "bare", scorer: "judge", stepKey: "step-3", score: 0.25 }
    ])
  })

  it("writes sorted canonical JSON and validates its version", async () => {
    const baseline = await Effect.runPromise(
      Baseline.load(
        "{\"version\":1,\"suite\":\"s\",\"records\":[{\"suite\":\"s\",\"case\":\"c\",\"scorer\":\"x\",\"stepKey\":\"k\",\"score\":0.5}]}"
      )
    )
    expect(Baseline.write(baseline)).toBe(
      "{\"records\":[{\"case\":\"c\",\"score\":0.5,\"scorer\":\"x\",\"stepKey\":\"k\",\"suite\":\"s\"}],\"suite\":\"s\",\"version\":1}\n"
    )
    const bad = await failure(Baseline.load("{\"version\":2,\"records\":[]}"))
    expect(bad.code).toBe("invalid_baseline")
    expect(bad.message).toBe("Baseline version must be 1, got 2")
    expect(bad.path).toBe("version")
  })

  it("loads a suite-less version-1 artifact when every record names the same suite", async () => {
    const records = [record, { ...record, case: "second", score: 0.75 }]
    const baseline = await Effect.runPromise(Baseline.load(JSON.stringify({ version: 1, records })))

    expect(baseline).toEqual({ version: 1, suite: "s", records })
    expect(Object.isFrozen(baseline.records)).toBe(true)
    const written = Baseline.write(baseline)
    expect(JSON.parse(written)).toEqual({ version: 1, suite: "s", records })
    expect(Baseline.write(await Effect.runPromise(Baseline.load(written)))).toBe(written)
  })

  it("rejects ambiguous ownership in a suite-less legacy artifact", async () => {
    const error = await failure(Baseline.load(JSON.stringify({
      version: 1,
      records: [record, { ...record, suite: "other" }]
    })))

    expect(error.code).toBe("invalid_baseline")
    expect(error.path).toBe("suite")
    expect(error.message).toBe("Cannot infer baseline suite: legacy records name multiple suites")
  })

  it("rejects a control character in any record string field", async () => {
    const hostile = "c\n::stop-commands::x\n\u001b[2Kpassed"
    for (const field of ["suite", "case", "scorer", "scorerName", "stepKey"] as const) {
      const error = await failure(Baseline.load(JSON.stringify({
        version: 1,
        suite: "s",
        records: [{ ...record, [field]: hostile }]
      })))

      expect(error.code).toBe("invalid_baseline")
      expect(error.path).toBe(`records[0].${field}`)
      expect(error.message).toBe(`Baseline record field '${field}' must not contain the control character U+000A`)
    }
    const del = await failure(Baseline.make({ suite: "s", records: [{ ...record, stepKey: "k\u007f" }] }))
    expect(del.message).toBe("Baseline record field 'stepKey' must not contain the control character U+007F")
  })

  // The top-level suite reaches CI logs through Regression's ownership error,
  // so it follows the same rule as record fields.
  it("rejects a control character in the top-level suite", async () => {
    for (
      const [hostile, named] of [
        ["s\n::warning::forged", "U+000A"],
        ["s\u001b[2K", "U+001B"],
        ["s\u009b2K", "U+009B"],
        ["s\u202egnp.exe", "U+202E"]
      ] as const
    ) {
      const error = await failure(Baseline.load(JSON.stringify({ version: 1, suite: hostile, records: [] })))
      expect(error.code).toBe("invalid_baseline")
      expect(error.path).toBe("suite")
      expect(error.message).toBe(`Baseline field 'suite' must not contain the control character ${named}`)
    }
    const made = await failure(Baseline.make({ suite: "s\r", records: [] }))
    expect(made.path).toBe("suite")
  })

  it("rejects text over the length limit before parsing it", async () => {
    const text = " ".repeat(Baseline.limits.length + 1)
    const parse = vi.spyOn(JSON, "parse")
    try {
      const error = await failure(Baseline.load(text))
      expect(error.code).toBe("invalid_baseline")
      expect(error.path).toBe("text")
      expect(error.message).toBe(
        `Baseline must be at most ${Baseline.limits.length} characters, got ${Baseline.limits.length + 1}`
      )
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
  })

  it("rejects an empty suite-less legacy artifact", async () => {
    const error = await failure(Baseline.load("{\"version\":1,\"records\":[]}"))

    expect(error.code).toBe("invalid_baseline")
    expect(error.path).toBe("suite")
    expect(error.message).toBe("Cannot infer baseline suite: legacy artifact has no records")
  })

  it("validates every legacy record before inferring ownership", async () => {
    const error = await failure(Baseline.load(JSON.stringify({
      version: 1,
      records: [record, { ...record, score: 2 }]
    })))

    expect(error.code).toBe("invalid_baseline")
    expect(error.path).toBe("records[1].score")
  })

  it("rejects a present null suite even when records agree", async () => {
    const error = await failure(Baseline.load(JSON.stringify({ version: 1, suite: null, records: [record] })))

    expect(error.code).toBe("invalid_baseline")
    expect(error.path).toBe("suite")
    expect(error.message).toBe("Baseline field 'suite' must be a string, got object")
  })

  it("preserves explicit ownership when writing an empty baseline", async () => {
    const baseline = await Effect.runPromise(Baseline.make({ suite: "s", records: [] }))
    const written = Baseline.write(baseline)

    expect(written).toBe("{\"records\":[],\"suite\":\"s\",\"version\":1}\n")
    expect(await Effect.runPromise(Baseline.load(written))).toEqual(baseline)
  })

  it("computes each record's write sort key once", async () => {
    const records = Array.from({ length: 32 }, (_, index) => ({
      ...record,
      case: `case-${(index * 7) % 32}`
    }))
    const baseline = await Effect.runPromise(Baseline.make({ suite: "s", records }))
    const stringify = vi.spyOn(JSON, "stringify")
    try {
      Baseline.write(baseline)
      const keys = stringify.mock.calls.filter(([value]) => Array.isArray(value))
      expect(keys).toHaveLength(records.length)
    } finally {
      stringify.mockRestore()
    }
  })

  it("orders records by an injective tuple encoding", async () => {
    const baseline = await Effect.runPromise(Baseline.make({
      suite: "collection",
      records: [
        { suite: "z", case: "c", scorer: "x", stepKey: "k", score: 1 },
        { suite: "é", case: "c", scorer: "x", stepKey: "k", score: 1 },
        // A delimiter-joined key would collide these two; a control character
        // can no longer enter a record, so the collision byte is a plain "/".
        { suite: "a", case: "b/c", scorer: "x", stepKey: "k", score: 1 },
        { suite: "a", case: "b", scorer: "/c", stepKey: "x", score: 1 }
      ]
    }))
    const suites = JSON.parse(Baseline.write(baseline)).records.map((entry: { case: string; suite: string }) =>
      `${entry.suite}|${entry.case}`
    )
    expect(suites).toEqual(["a|b", "a|b/c", "z|c", "é|c"])
  })

  it("round-trips through write and load byte for byte", async () => {
    const baseline = await Effect.runPromise(Baseline.make({
      suite: "s",
      records: [
        { suite: "s", case: "b", scorer: "x", scorerName: "exact", stepKey: "k", score: 1 },
        { suite: "s", case: "a", scorer: "x", stepKey: "k", score: 0 }
      ]
    }))
    const once = Baseline.write(baseline)
    const twice = Baseline.write(await Effect.runPromise(Baseline.load(once)))
    expect(twice).toBe(once)
  })

  // The validated baseline used to be the caller's own array holding the
  // caller's own objects, so a committed artifact could carry unknown keys and
  // run a getter during serialization.
  it("snapshots records, dropping unknown keys and never running a getter", async () => {
    const hostile = {
      ...record,
      secret: "API_KEY",
      get boom(): string {
        throw new Error("getter ran")
      }
    }
    const records: Array<Baseline.BaselineRecord> = [hostile]
    const baseline = await Effect.runPromise(Baseline.make({ suite: "s", records }))
    records.push({ ...record, case: "late" })

    expect(baseline.records).toEqual([record])
    expect(Object.isFrozen(baseline.records)).toBe(true)
    expect(Baseline.write(baseline)).toBe(
      "{\"records\":[{\"case\":\"c\",\"score\":0.5,\"scorer\":\"x\",\"stepKey\":\"k\",\"suite\":\"s\"}],\"suite\":\"s\",\"version\":1}\n"
    )
  })

  it("reads each record field once before validating and committing it", async () => {
    let reads = 0
    const stateful = {
      ...record,
      get scorerName(): unknown {
        reads += 1
        return reads === 1 ? "first" : {}
      }
    }
    const baseline = await Effect.runPromise(
      Baseline.make({ suite: "s", records: [stateful as Baseline.BaselineRecord] })
    )

    expect(reads).toBe(1)
    expect(baseline.records[0]?.scorerName).toBe("first")
  })

  it("names the record index and field of every decode failure", async () => {
    const cases: ReadonlyArray<readonly [unknown, string, string]> = [
      [{ ...record, suite: 1 }, "records[0].suite", "Baseline record field 'suite' must be a string, got number"],
      [{ ...record, case: null }, "records[0].case", "Baseline record field 'case' must be a string, got object"],
      [{ ...record, scorer: 1 }, "records[0].scorer", "Baseline record field 'scorer' must be a string, got number"],
      [
        { ...record, stepKey: 1 },
        "records[0].stepKey",
        "Baseline record field 'stepKey' must be a string, got number"
      ],
      [
        { ...record, score: 1.5 },
        "records[0].score",
        "Baseline record field 'score' must be a finite number in [0, 1], got 1.5"
      ],
      [
        { ...record, score: -0.5 },
        "records[0].score",
        "Baseline record field 'score' must be a finite number in [0, 1], got -0.5"
      ],
      [
        { ...record, score: Number.NaN },
        "records[0].score",
        "Baseline record field 'score' must be a finite number in [0, 1], got NaN"
      ],
      [
        { ...record, score: "1" },
        "records[0].score",
        "Baseline record field 'score' must be a finite number in [0, 1], got 1"
      ],
      [
        { ...record, scorerName: 1 },
        "records[0].scorerName",
        "Baseline record field 'scorerName' must be a string, got number"
      ],
      [null, "records[0]", "Baseline record must be an object, got null"],
      ["nope", "records[0]", "Baseline record must be an object, got string"],
      [[record], "records[0]", "Baseline record must be an object, got object"]
    ]
    for (const [value, path, message] of cases) {
      const error = await failure(
        Baseline.make({ suite: "s", records: [value] as ReadonlyArray<Baseline.BaselineRecord> })
      )
      expect(error.code).toBe("invalid_baseline")
      expect(error.path).toBe(path)
      expect(error.message).toBe(message)
    }
  })

  it("rejects an artifact that is not an object with an array of records", async () => {
    const notObject = await failure(Baseline.load("[]"))
    expect(notObject.message).toBe("Baseline must be an object")
    expect(notObject.path).toBeUndefined()

    const nullArtifact = await failure(Baseline.load("null"))
    expect(nullArtifact.message).toBe("Baseline must be an object")

    const notArray = await failure(Baseline.load("{\"version\":1,\"suite\":\"s\",\"records\":{}}"))
    expect(notArray.message).toBe("Baseline records must be an array")
    expect(notArray.path).toBe("records")

    const invalidSuite = await failure(Baseline.load("{\"version\":1,\"suite\":7,\"records\":[]}"))
    expect(invalidSuite.message).toBe("Baseline field 'suite' must be a string, got number")
    expect(invalidSuite.path).toBe("suite")

    const notJson = await failure(Baseline.load("{"))
    expect(notJson.message).toBe("Baseline is not valid JSON")
  })

  it("normalises a negative zero score", async () => {
    const baseline = await Effect.runPromise(Baseline.make({ suite: "s", records: [{ ...record, score: -0 }] }))
    expect(Object.is(baseline.records[0]?.score, 0)).toBe(true)
  })

  it("loads the committed fixture beside these tests", async () => {
    const { readFile } = await import("node:fs/promises")
    const text = await readFile(new URL("./fixtures/baseline.json", import.meta.url), "utf8")
    const baseline = await Effect.runPromise(Baseline.load(text))
    expect(baseline.records.map((entry) => entry.case)).toEqual(["adds numbers", "multiplies numbers"])
    expect(Baseline.write(baseline)).toBe(
      "{\"records\":[" +
        "{\"case\":\"adds numbers\",\"score\":1,\"scorer\":\"exact\",\"stepKey\":\"step-a\",\"suite\":\"arithmetic\"}," +
        "{\"case\":\"multiplies numbers\",\"score\":0.875,\"scorer\":\"exact\",\"stepKey\":\"step-b\",\"suite\":\"arithmetic\"}" +
        "],\"suite\":\"arithmetic\",\"version\":1}\n"
    )
  })
})
