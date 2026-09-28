import * as Effect from "effect/Effect"
import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"
import { EvalError } from "../src/EvalError.ts"
import * as Regression from "../src/Regression.ts"
import * as Report from "../src/Report.ts"
import type * as Runner from "../src/Runner.ts"

// Use the GFM parser already installed by the workspace's Mermaid dependency.
const require = createRequire(import.meta.url)
const { marked } = createRequire(require.resolve("mermaid"))("marked") as {
  marked: { parse: (markdown: string, options: { gfm: boolean; async: false }) => string }
}
const html = (report: Regression.Report): string => marked.parse(Report.markdown(report), { gfm: true, async: false })
const htmlText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll(
    "'",
    "&#39;"
  )

const empty = (): Promise<Regression.Report> =>
  Effect.runPromise(
    Regression.compare({ version: 1, suite: "s", records: [] }, {
      runId: "run",
      suite: "s",
      cases: [],
      observations: []
    })
  )

const observation = (
  stepKey: string,
  score: number,
  overrides: Partial<Runner.Observation> = {}
): Runner.Observation => ({
  case: "c",
  scorer: "0123456789abcdef",
  scorerName: "exact",
  stepKey,
  kind: "score",
  score,
  at: "t",
  ...overrides
} as Runner.Observation)

const report = (overrides: Partial<Regression.Report>) =>
  Effect.runPromise(
    Regression.compare(
      {
        version: 1,
        suite: "s",
        records: [{ suite: "s", case: "c", scorer: "0123456789abcdef", stepKey: "old", score: 0.9 }]
      },
      { runId: "run", suite: "s", cases: [], observations: [observation("new", 0.2)] }
    )
  ).then((base) => ({ ...base, ...overrides }))

describe("Report", () => {
  it("renders stable JSON and a summary-only Markdown report", async () => {
    const result = await empty()
    expect(Report.json(result)).toContain("\"suite\":\"s\"")
    expect(Report.markdown(result)).toBe(
      [
        "# Evaluation report: s",
        "",
        "- Regressions: 0",
        "- Nondeterminism: 0",
        "- Missing observations: 0",
        "- Inconclusive observations: 0",
        "- Failed cases: 0",
        ""
      ].join("\n").trim() + "\n"
    )
  })

  // The compatibility fixture for report format version 1. A change to these
  // bytes is a wire-format change and has to move Report.version with it.
  it("freezes the JSON wire format of report version 1", async () => {
    const result = await empty()
    expect(Report.version).toBe(1)
    expect(Report.json(result)).toBe(
      "{\"baseline\":{\"records\":[],\"suite\":\"s\",\"version\":1},\"missing\":[],\"nondeterminism\":[]," +
        "\"regressions\":[],\"reportVersion\":1," +
        "\"run\":{\"cases\":[],\"observations\":[],\"runId\":\"run\",\"suite\":\"s\"},\"suite\":\"s\"}\n"
    )
  })

  it("stamps a format version and keeps the derived views off the wire", async () => {
    const result = await empty()
    expect(Object.keys(Report.data(result)).sort()).toEqual([
      "baseline",
      "missing",
      "nondeterminism",
      "regressions",
      "reportVersion",
      "run",
      "suite"
    ])
    expect(Report.data(result).reportVersion).toBe(Report.version)
    // samples and inconclusive stay on the in-memory report; a gate reads them.
    expect(result.samples).toEqual([])
    expect(result.inconclusive).toEqual([])
  })

  it("encodes each observation once and refers to it by index", async () => {
    const marker = "M".repeat(512)
    const observations: Array<Runner.Observation> = []
    const cases: Array<Runner.CaseResult> = []
    for (let index = 0; index < 40; index++) {
      // One object in run.observations, the case list, samples, and a regression.
      const scored = observation("new", 0.2, { case: `c${index}`, reason: marker, meta: { marker } })
      observations.push(scored)
      cases.push({ case: `c${index}`, observations: [scored] })
    }
    const result = await Effect.runPromise(
      Regression.compare(
        {
          version: 1,
          suite: "s",
          records: observations.map((entry) => ({
            suite: "s",
            case: entry.case,
            scorer: entry.scorer,
            stepKey: "old",
            score: 0.9
          }))
        },
        { runId: "run", suite: "s", cases, observations }
      )
    )
    expect(result.regressions).toHaveLength(40)

    const wire = Report.json(result)
    // Two occurrences per observation, from reason and meta, and no more.
    expect(wire.split(marker).length - 1).toBe(80)
    // One copy plus the comparison around it. Encoding the graph directly was 4x.
    expect(wire.length).toBeLessThan(JSON.stringify(observations).length * 1.5)

    const projected = Report.data(result)
    expect(projected.run.observations).toEqual(observations)
    expect(projected.run.cases.map((entry) => entry.observations)).toEqual(observations.map((_, index) => [index]))
    expect([...projected.regressions].map((entry) => entry.actual).sort((left, right) => left - right)).toEqual(
      observations.map((_, index) => index)
    )
  })

  it("pools an observation reached only through a case into the table", async () => {
    const orphan = observation("only-in-a-case", 0.4)
    const result = await empty()
    const projected = Report.data({
      ...result,
      run: { runId: "run", suite: "s", cases: [{ case: "c", observations: [orphan] }], observations: [] }
    })
    expect(projected.run.observations).toEqual([orphan])
    expect(projected.run.cases[0]!.observations).toEqual([0])
  })

  it("keeps a failed case's stable error code and path in the JSON wire format", async () => {
    const base = await empty()
    const failed: Regression.Report = {
      ...base,
      run: {
        runId: "run",
        suite: "s",
        cases: [{
          case: "broken",
          error: new EvalError({
            code: "executor",
            message: "Target failed for case 'broken': boom",
            path: "cases[0].input"
          }),
          observations: []
        }],
        observations: []
      }
    }
    expect(Report.json(failed)).toBe(
      "{\"baseline\":{\"records\":[],\"suite\":\"s\",\"version\":1},\"missing\":[],\"nondeterminism\":[]," +
        "\"regressions\":[],\"reportVersion\":1,\"run\":{\"cases\":[{\"case\":\"broken\",\"error\":{" +
        "\"_tag\":\"flows/evals/EvalError\",\"code\":\"executor\",\"message\":\"Target failed for case 'broken': boom\"," +
        "\"name\":\"flows/evals/EvalError\",\"path\":\"cases[0].input\"},\"observations\":[]}]," +
        "\"observations\":[],\"runId\":\"run\",\"suite\":\"s\"},\"suite\":\"s\"}\n"
    )
  })

  it("renders a report of a run whose target crashed rather than a page of zeroes", async () => {
    const crashed = await report({
      run: {
        runId: "run",
        suite: "s",
        cases: [
          { case: "healthy", observations: [] },
          {
            case: "crashed",
            error: new EvalError({ code: "executor", message: "Target failed for case 'crashed': boom" }),
            observations: []
          }
        ],
        observations: []
      }
    })
    const rendered = Report.markdown(crashed)
    expect(rendered).toContain("- Failed cases: 1")
    expect(rendered).toContain("## Case failures")
    expect(rendered).toContain("| crashed | executor | Target failed for case 'crashed'\\: boom |")
  })

  it("names every regression, nondeterminism, missing, and inconclusive row", async () => {
    const full = await report({
      regressions: [{
        case: "c",
        scorer: "0123456789abcdef",
        baseline: { suite: "s", case: "c", scorer: "0123456789abcdef", stepKey: "old", score: 0.9 },
        actual: observation("new", 0.2) as Extract<Runner.Observation, { kind: "score" }>,
        drop: 0.7
      }],
      nondeterminism: [{
        case: "c",
        scorer: "0123456789abcdef",
        baseline: { suite: "s", case: "c", scorer: "0123456789abcdef", stepKey: "old", score: 0.9 },
        actual: observation("old", 0.5) as Extract<Runner.Observation, { kind: "score" }>,
        delta: -0.4
      }],
      missing: [{ side: "run", case: "gone", scorer: "0123456789abcdef", stepKey: "old" }],
      inconclusive: [
        {
          case: "c",
          scorer: "0123456789abcdef",
          scorerName: "exact",
          stepKey: "step",
          kind: "inconclusive",
          reason: "judge down",
          at: "t"
        }
      ]
    })
    const projected = Report.data(full)
    expect(projected.nondeterminism).toHaveLength(1)
    expect(projected.run.observations[projected.nondeterminism[0]!.actual]).toBe(full.nondeterminism[0]!.actual)
    expect(Report.markdown(full)).toBe(
      [
        "# Evaluation report: s",
        "",
        "- Regressions: 1",
        "- Nondeterminism: 1",
        "- Missing observations: 1",
        "- Inconclusive observations: 1",
        "- Failed cases: 0",
        "",
        "## Regressions",
        "",
        "| Case | Scorer | Baseline | Actual | Drop |",
        "| --- | --- | ---: | ---: | ---: |",
        "| c | exact (01234567) | 0.900000 | 0.200000 | 0.700000 |",
        "",
        "## Nondeterminism",
        "",
        "| Case | Scorer | Step key | Baseline | Actual | Delta |",
        "| --- | --- | --- | ---: | ---: | ---: |",
        "| c | exact (01234567) | old | 0.900000 | 0.500000 | -0.400000 |",
        "",
        "## Missing observations",
        "",
        "| Side | Case | Scorer | Step key |",
        "| --- | --- | --- | --- |",
        "| run | gone | 0123456789abcdef | old |",
        "",
        "## Inconclusive",
        "",
        "| Case | Scorer | Step key | Reason |",
        "| --- | --- | --- | --- |",
        "| c | exact (01234567) | step | judge down |"
      ].join("\n") + "\n"
    )
  })

  it("escapes, flattens, and caps every cell, including the heading", async () => {
    const hostile = await report({
      suite: "s <script>|\nnext",
      missing: [{
        side: "run",
        case: "a|b",
        scorer: "x".repeat(300),
        stepKey: "line\u0000break\u009bmid\u2066end"
      }]
    })
    const rendered = Report.markdown(hostile)
    expect(html(hostile)).toContain("<h1>Evaluation report: s &lt;script&gt;| next</h1>")
    expect(rendered).toContain("| run | a\\|b |")
    expect(rendered).toContain(`${"x".repeat(240)}…`)
    expect(rendered).toContain("line break mid end")
  })

  it.each([
    "a\\|b",
    "a\\\\|b",
    "[Approve](https://evil.example/phish)",
    "![](https://evil.example/beacon.png)",
    "<img src=\"https://evil.example/beacon.png\">",
    "<script>alert(1)</script>",
    "`code` **bold** _emphasis_ ~~strike~~ # heading",
    "https://evil.example www.evil.example user@evil.example",
    "&copy; &#124; &#x3c;img&#x3e;"
  ])("renders hostile names literally in the heading and baseline cells: %s", async (name) => {
    const result = await Effect.runPromise(Regression.compare(
      { version: 1, suite: name, records: [{ suite: name, case: name, scorer: name, stepKey: name, score: 1 }] },
      { runId: "run", suite: name, cases: [], observations: [] }
    ))
    const rendered = html(result)
    expect(rendered).toContain(`<h1>Evaluation report: ${htmlText(name)}</h1>`)
    const rows = [...rendered.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].slice(1)
    expect(rows).toHaveLength(1)
    expect([...rows[0]![1]!.matchAll(/<td>([\s\S]*?)<\/td>/g)].map((match) => match[1])).toEqual([
      "run",
      htmlText(name),
      htmlText(name),
      htmlText(name)
    ])
    expect(rendered).not.toMatch(/<(?:a|img|script|em|strong|code|del)\b/)
  })

  it("neutralizes scorer names, step keys, reasons, and executor error messages", async () => {
    const name = "a\\|b ![image](https://evil.example) <img src=\"x\"> **bold**"
    const base = await report({})
    const result: Regression.Report = {
      ...base,
      regressions: base.regressions.map((item) => ({
        ...item,
        case: name,
        actual: { ...item.actual, scorerName: name }
      })),
      nondeterminism: [{
        case: name,
        scorer: "0123456789abcdef",
        baseline: { suite: "s", case: name, scorer: "0123456789abcdef", stepKey: name, score: 0.9 },
        actual: observation(name, 0.5, { scorerName: name }) as Extract<Runner.Observation, { kind: "score" }>,
        delta: -0.4
      }],
      missing: [{ side: "run", case: name, scorer: "0123456789abcdef", scorerName: name, stepKey: name }],
      inconclusive: [{
        case: name,
        scorer: "0123456789abcdef",
        scorerName: name,
        stepKey: name,
        kind: "inconclusive",
        reason: name,
        at: "t"
      }],
      run: {
        ...base.run,
        cases: [{ case: name, error: new EvalError({ code: "executor", message: name }), observations: [] }]
      }
    }
    const rendered = html(result)
    const rows = [...rendered.matchAll(/<tr>([\s\S]*?)<\/tr>/g)]
      .filter((match) => match[1]!.includes("<td>"))
    expect(rows.map((match) => (match[1]!.match(/<td(?:\s|>)/g) ?? []).length)).toEqual([5, 6, 3, 4, 4])
    expect(rendered).toContain(`<td>${htmlText(name)} (01234567)</td>`)
    expect(rendered).toContain(`<td>executor</td>\n<td>${htmlText(name)}</td>`)
    expect(rendered).not.toMatch(/<(?:a|img|script|em|strong|code|del)\b/)
  })

  it.each(["\\", "|", "*", "`", "&", "😀"])("caps escaped text without splitting %s", async (suffix) => {
    const prefix = "x".repeat(239)
    const result = await report({
      suite: prefix + suffix,
      missing: [{
        side: "run",
        case: prefix + suffix,
        scorer: "key",
        stepKey: "step"
      }]
    })
    expect(html(result)).toContain(`<h1>Evaluation report: ${prefix}…</h1>`)
    expect(html(result)).toContain(`<td>${prefix}…</td>\n<td>key</td>\n<td>step</td>`)
  })

  it("coerces non-string Markdown cells and treats nullish cells as empty", async () => {
    const malformed = await report({
      suite: 42 as unknown as string,
      missing: [{
        side: null as unknown as "run",
        case: undefined as unknown as string,
        scorer: 7 as unknown as string,
        stepKey: null as unknown as string
      }]
    })
    const rendered = Report.markdown(malformed)
    expect(rendered).toContain("# Evaluation report: 42")
    expect(rendered).toContain("|  |  | 7 |  |")

    const unreadable = await report({
      suite: {
        [Symbol.toPrimitive]: () => {
          throw new TypeError("cannot stringify")
        }
      } as unknown as string
    })
    expect(() => Report.markdown(unreadable)).not.toThrow()
    expect(html(unreadable)).toContain("<h1>Evaluation report: [unreadable]</h1>")
  })

  it("falls back to the scorer key when the scorer has no name", async () => {
    const anonymous = await report({
      inconclusive: [
        {
          case: "c",
          scorer: "0123456789abcdef",
          stepKey: "step",
          kind: "inconclusive",
          reason: "judge down",
          at: "t"
        }
      ]
    })
    expect(Report.markdown(anonymous)).toContain("| c | 0123456789abcdef | step | judge down |")
  })

  it("uses a scorer name in a missing row and the bare key when no name exists", async () => {
    const missing = await report({
      missing: [
        {
          side: "run",
          case: "named",
          scorer: "0123456789abcdef",
          scorerName: "exact",
          stepKey: "step"
        },
        { side: "baseline", case: "bare", scorer: "bare-key", stepKey: "step" }
      ]
    })
    const rendered = Report.markdown(missing)
    expect(rendered).toContain("| run | named | exact (01234567) | step |")
    expect(rendered).toContain("| baseline | bare | bare-key | step |")
  })
})
