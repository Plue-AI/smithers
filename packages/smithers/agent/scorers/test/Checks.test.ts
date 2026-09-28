import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Checks from "../src/Checks.ts"

describe("Checks.words", () => {
  it("counts tokens holding a letter or digit", () => {
    expect(Checks.words("")).toBe(0)
    expect(Checks.words("  Hello,   world — 42 !  ")).toBe(3)
  })

  it("counts link labels rather than link URLs", () => {
    expect(Checks.words("See <https://example.com/a/b|the design doc> now")).toBe(5)
    expect(Checks.words("See [the design doc](https://example.com/a/b) now")).toBe(5)
    expect(Checks.words("See <https://example.com/a/b> now")).toBe(2)
    expect(Checks.words("See https://example.com/a/b now")).toBe(3)
  })
})

describe("Checks.length", () => {
  it("checks inclusive bounds", () => {
    const text = "one two three four"
    expect(Checks.length(text, {})).toEqual({ id: "length", pass: true, detail: "4 words" })
    expect(Checks.length(text, { min: 4, max: 4 }).pass).toBe(true)
    expect(Checks.length(text, { min: 5 })).toEqual({ id: "length", pass: false, detail: "4 words < 5" })
    expect(Checks.length(text, { max: 3 })).toEqual({ id: "length", pass: false, detail: "4 words > 3" })
  })
})

describe("Checks.includes", () => {
  it("requires every entry case-insensitively, with any-of groups", () => {
    expect(Checks.includes("Merged the PR and deployed.", ["merged", ["deployed", "shipped"]])).toEqual({
      id: "includes",
      pass: true,
      detail: "all present"
    })
    expect(Checks.includes("Merged it.", ["merged", ["deployed", "shipped"], "tests"])).toEqual({
      id: "includes",
      pass: false,
      detail: "missing: \"deployed\" | \"shipped\", \"tests\""
    })
  })

  it("matches whole words and phrases, so \"No\" is not found in \"not\"", () => {
    expect(Checks.includes("It is not fixed yet.", ["No"])).toEqual({
      id: "includes",
      pass: false,
      detail: "missing: \"No\""
    })
    expect(Checks.includes("I know it's not fixed.", [["No", "nope"]]).pass).toBe(false)
    expect(Checks.includes("No, the fix is in review.", ["No"]).pass).toBe(true)
    expect(Checks.includes("Not yet: PR #91 is a draft.", [["not yet", "No"], "#91"]).pass).toBe(true)
    expect(Checks.includes("Shipped in 0.9.3 to Fernhill", ["0.9.3", "Fernhill"]).pass).toBe(true)
    expect(Checks.includes("Shipped in 0.9.31", ["0.9.3"]).pass).toBe(false)
    expect(Checks.includes("costs $12 per seat", ["$12"]).pass).toBe(true)
    expect(Checks.includes("costs $120 per seat", ["$12"]).pass).toBe(false)
  })

  it("accepts stems written word* and /pattern/flags entries", () => {
    expect(Checks.includes("Sam's renewal is Oct 31", ["renew*"]).pass).toBe(true)
    expect(Checks.includes("Sam's renewal is Oct 31", ["renew"]).pass).toBe(false)
    expect(Checks.includes("takes 14 minutes", ["14 min*"]).pass).toBe(true)
    expect(Checks.includes("unrenewed", ["renew*"]).pass).toBe(false)
    expect(Checks.includes("anything", ["*"]).pass).toBe(false)
    expect(Checks.includes("Ready by Wed", ["/\\b(Wed|Wednesday)\\b/"]).pass).toBe(true)
    expect(Checks.includes("Ready by Thu", ["/\\b(Wed|Wednesday)\\b/"]).pass).toBe(false)
  })
})

describe("Checks.excludes", () => {
  it("matches whole words and phrases only", () => {
    expect(Checks.excludes("I will leverage this", ["leverage"]).pass).toBe(false)
    expect(Checks.excludes("Leveraged buyouts", ["leverage"]).pass).toBe(true)
    expect(Checks.excludes("In  Order\nTo ship", ["in order to"])).toEqual({
      id: "excludes",
      pass: false,
      detail: "found: \"In  Order\\nTo\""
    })
    expect(Checks.excludes("résumé", ["sum"]).pass).toBe(true)
  })

  it("escapes regex specials and anchors only word-character ends", () => {
    expect(Checks.excludes("costs $5 (approx.)", ["(approx.)"]).pass).toBe(false)
    expect(Checks.excludes("a.b", ["a*b"]).pass).toBe(true)
    expect(Checks.excludes("see --verbose", ["--verbose"]).pass).toBe(false)
  })

  it("treats a trailing * as a stem", () => {
    expect(Checks.excludes("three receipts", ["receipt*"])).toEqual({
      id: "excludes",
      pass: false,
      detail: "found: \"receipts\""
    })
    expect(Checks.excludes("three receipts", ["receipt"]).pass).toBe(true)
  })

  it("treats /pattern/flags entries as regular expressions and lists every hit", () => {
    const check = Checks.excludes("Ticket ABC-12 and abc-7, also ABC-12", ["/ABC-\\d+/", "/abc-\\d+/gi"], "jargon")
    expect(check).toEqual({ id: "jargon", pass: false, detail: "found: \"ABC-12\", \"abc-7\"" })
    expect(Checks.excludes("abc-12", ["/ABC-\\d+/"]).pass).toBe(true)
  })

  it("ignores empty entries and passes clean text", () => {
    expect(Checks.excludes("fine text", ["", "synergy"])).toEqual({ id: "excludes", pass: true, detail: "none found" })
  })

  it("clips a long detail to 200 characters", () => {
    const text = Array.from({ length: 60 }, (_, index) => `word${index}`).join(" ")
    const check = Checks.excludes(text, ["/word\\d+/"])
    expect(check.detail).toHaveLength(200)
    expect(check.detail.endsWith("…")).toBe(true)
  })
})

describe("Checks.opener", () => {
  const phrases = ["on it", "got it", "great question"]

  it("fails a filler opener after emoji, whitespace, and punctuation", () => {
    expect(Checks.opener("On it.", phrases)).toEqual({ id: "opener", pass: false, detail: "opens with \"On it\"" })
    expect(Checks.opener("  👍 on it — checking now", phrases).pass).toBe(false)
    expect(Checks.opener("*Got it!* Here you go", phrases).pass).toBe(false)
    expect(Checks.opener("Great   question, so", phrases).pass).toBe(false)
  })

  it("passes a phrase inside a sentence or as a word prefix", () => {
    expect(Checks.opener("I am on it.", phrases)).toEqual({ id: "opener", pass: true, detail: "no listed opener" })
    expect(Checks.opener("Online now", phrases).pass).toBe(true)
  })
})

describe("Checks.truncated", () => {
  it("passes complete text", () => {
    expect(Checks.truncated("All done. Tests pass.")).toEqual({ id: "truncation", pass: true, detail: "complete" })
    expect(Checks.truncated("Options: a ... b are fine.").pass).toBe(true)
  })

  it("fails a cut-off word", () => {
    expect(Checks.truncated("The operati… is finished.")).toEqual({
      id: "truncation",
      pass: false,
      detail: "found: \"operati…\""
    })
    expect(Checks.truncated("Running step-4... then more").pass).toBe(false)
  })

  it("fails an ellipsis at the very end", () => {
    expect(Checks.truncated("And then ...  ")).toEqual({
      id: "truncation",
      pass: false,
      detail: "found: trailing ellipsis"
    })
  })

  it("allows ellipses in code fences and code spans", () => {
    expect(Checks.truncated("Run:\n```\nnpm run build...\n```\nand `a...` too.").pass).toBe(true)
  })

  it("fails an unclosed code fence", () => {
    expect(Checks.truncated("Run:\n```ts\nconst a = 1")).toEqual({
      id: "truncation",
      pass: false,
      detail: "found: unclosed code fence"
    })
  })
})

describe("Checks.links", () => {
  it("extracts Slack, markdown, and bare links in order", () => {
    expect(
      Checks.links(
        "See <https://a.example/x|the doc>, <https://b.example/>, [spec](https://c.example/s) and https://d.example/p."
      )
    ).toEqual([
      { url: "https://a.example/x", label: "the doc" },
      { url: "https://b.example/" },
      { url: "https://c.example/s", label: "spec" },
      { url: "https://d.example/p" }
    ])
  })

  it("strips trailing punctuation from bare URLs but keeps balanced parentheses", () => {
    expect(Checks.links("(see https://a.example/x);")).toEqual([{ url: "https://a.example/x" }])
    expect(Checks.links("https://w.example/wiki/Foo_(bar).")).toEqual([{ url: "https://w.example/wiki/Foo_(bar)" }])
    expect(Checks.links("\"https://a.example/q?x=1\"!")).toEqual([{ url: "https://a.example/q?x=1" }])
  })

  it("ignores Slack mentions and channels", () => {
    expect(Checks.links("<@U123> in <#C1|general> <!here>")).toEqual([])
  })

  it("deduplicates by URL and keeps the first label found", () => {
    expect(
      Checks.links("https://a.example [](https://a.example) <https://a.example|first> [second](https://a.example)")
    ).toEqual([{ url: "https://a.example", label: "first" }])
  })
})

describe("Checks.requiredLinks", () => {
  it("requires each URL or any-of group", () => {
    const text = "Opened <https://GitHub.com/acme/app/pull/12/files#diff|the PR>."
    expect(Checks.requiredLinks(text, ["https://github.com/acme/app/pull/12/"])).toEqual({
      id: "links",
      pass: true,
      detail: "1 links"
    })
    expect(Checks.requiredLinks(text, [["https://ci.example/run", "https://github.com/acme/app"]]).pass).toBe(true)
    expect(Checks.requiredLinks(text, ["https://github.com/acme/app/pull/1"])).toEqual({
      id: "links",
      pass: false,
      detail: "missing: https://github.com/acme/app/pull/1"
    })
    expect(Checks.requiredLinks(text, [["https://x.example", "https://y.example"]]).detail).toBe(
      "missing: https://x.example | https://y.example"
    )
  })

  it("matches a query extension and relative targets", () => {
    expect(Checks.requiredLinks("[q](https://a.example/s?q=1)", ["https://a.example/s"]).pass).toBe(true)
    expect(Checks.requiredLinks("[doc](./Docs/A.md#top)", ["./docs/a.md"]).pass).toBe(true)
  })
})

describe("Checks.linkedReferences", () => {
  const refs = [{ pattern: "#(\\d+)\\b", url: "https://github.com/acme/app/issues/$1" }]

  it("requires every reference to be linked, accepting /pull/ for /issues/", () => {
    expect(
      Checks.linkedReferences("Fixed [#12](https://github.com/acme/app/pull/12) and #40.", [
        ...refs
      ])
    ).toEqual({ id: "linked-references", pass: false, detail: "unlinked: #40" })
    expect(
      Checks.linkedReferences(
        "Fixed <https://github.com/acme/app/pull/12|#12> and #40 (https://github.com/acme/app/issues/40).",
        refs
      )
    ).toEqual({ id: "linked-references", pass: true, detail: "all linked" })
  })

  it("ignores references inside link URLs", () => {
    expect(Checks.linkedReferences("See https://example.com/page#12", refs).pass).toBe(true)
  })

  it("does not treat #1 as linked by a link to #12", () => {
    expect(Checks.linkedReferences("#1 https://github.com/acme/app/issues/12", refs).pass).toBe(false)
  })

  it("substitutes the whole match when the pattern has no group, and never swaps other templates", () => {
    const tickets = [{ pattern: "ABC-\\d+", url: "https://tracker.example/browse/$1" }]
    expect(Checks.linkedReferences("[ABC-7](https://tracker.example/browse/ABC-7)", tickets).pass).toBe(true)
    expect(Checks.linkedReferences("ABC-7", tickets).detail).toBe("unlinked: ABC-7")
  })
})

describe("Checks.barePaths", () => {
  it("fails on file paths and home-directory paths", () => {
    expect(Checks.barePaths("Wrote docs/plan.md and `src/app.ts`.")).toEqual({
      id: "bare-paths",
      pass: false,
      detail: "found: \"docs/plan.md\", \"src/app.ts\""
    })
    expect(Checks.barePaths("Stored in /Users/someone/notes and ~/work").detail).toBe(
      "found: \"/Users/someone/notes\", \"~/work\""
    )
    expect(Checks.barePaths("Logs in (/home/ci/run)").pass).toBe(false)
  })

  it("does not count URLs, linked paths, or extensionless slashes", () => {
    expect(
      Checks.barePaths(
        "See https://example.com/a/b.md, [docs/plan.md](https://example.com/plan), and/or ftp://h.example/x.json"
      )
    ).toEqual({ id: "bare-paths", pass: true, detail: "none found" })
    expect(Checks.barePaths("readme.md alone")).toEqual({ id: "bare-paths", pass: true, detail: "none found" })
  })
})

describe("Checks.questions", () => {
  it("counts sentences ending in a question mark, not ones inside URLs", () => {
    expect(Checks.questions("Ready? Want me to merge?? See https://a.example/x?y=1 ok")).toBe(2)
    expect(Checks.questions("Is it \"done?\" [docs](https://a.example/?q)")).toBe(1)
    expect(Checks.questions("No questions.")).toBe(0)
  })
})

describe("Checks.count", () => {
  const actions: ReadonlyArray<Checks.Action> = [
    { tool: "post_message", input: { channel: "General", thread: true } },
    { tool: "post_message", input: { channel: "random", thread: false } },
    { tool: "post_message", input: "raw" },
    { tool: "post_message", input: null },
    { tool: "create_issue", input: { priority: 2 } }
  ]

  it("defaults to at least one call", () => {
    expect(Checks.count(actions, { tool: "post_message" })).toEqual({
      id: "count:post_message",
      pass: true,
      detail: "4 post_message calls"
    })
    expect(Checks.count(actions, { tool: "delete_repo" })).toEqual({
      id: "count:delete_repo",
      pass: false,
      detail: "0 delete_repo calls < 1"
    })
  })

  it("filters with where: case-insensitive strings, strict values, any-of arrays", () => {
    expect(Checks.count(actions, { tool: "post_message", where: { channel: "general" }, max: 1 }).detail).toBe(
      "1 post_message calls"
    )
    expect(
      Checks.count(actions, { tool: "post_message", where: { channel: ["GENERAL", "random"] }, min: 2, max: 2 }).pass
    ).toBe(true)
    expect(Checks.count(actions, { tool: "post_message", where: { thread: true } }).detail).toBe(
      "1 post_message calls"
    )
    expect(Checks.count(actions, { tool: "create_issue", where: { priority: 2 } }).pass).toBe(true)
    expect(Checks.count(actions, { tool: "create_issue", where: { priority: "2" } }).pass).toBe(false)
  })

  it("enforces a maximum and a custom id", () => {
    expect(Checks.count(actions, { tool: "post_message", max: 0, id: "silent" })).toEqual({
      id: "silent",
      pass: false,
      detail: "4 post_message calls > 0"
    })
    expect(Checks.count(actions, { tool: "delete_repo", max: 0 }).pass).toBe(true)
  })
})

describe("Checks.leakage", () => {
  it("names the sink and marker, never the surrounding text", () => {
    const check = Checks.leakage(
      [
        { sink: "public-channel", text: "Update: the Project Falcon launch is on track" },
        { sink: "log", text: "falconry is a hobby" },
        { sink: "dm", text: "codename: project falcon" }
      ],
      ["project falcon", "/secret-\\d+/"]
    )
    expect(check).toEqual({
      id: "leakage",
      pass: false,
      detail: "leaked: public-channel: marker 1, dm: marker 1"
    })
    expect(check.detail).not.toContain("launch")
    expect(check.detail.toLowerCase()).not.toContain("falcon")
    expect(Checks.leakage([{ sink: "log", text: "clean" }], ["project falcon"])).toEqual({
      id: "leakage",
      pass: true,
      detail: "no markers found"
    })
  })
})

describe("Checks.leakage security", () => {
  it("finds a secret followed or preceded by more word characters", () => {
    const secret = "SECRETabc123"
    for (const text of ["token=SECRETabc123xyz", "xSECRETabc123", "SECRETabc123", "secretABC123_tail"]) {
      expect(Checks.leakage([{ sink: "slack", text }], [secret])).toEqual({
        id: "leakage",
        pass: false,
        detail: "leaked: slack: marker 1"
      })
    }
  })

  it("keeps the marker text out of the scorer reason and meta", async () => {
    const scorer = Checks.scorer({
      id: "test/leakage",
      version: "1",
      checks: ({ output }) => [Checks.leakage([{ sink: "log", text: String(output) }], ["", "canary-7f3e9"])]
    })
    const score = await Effect.runPromise(scorer.score({ input: "q", output: "sent canary-7f3e9xyz" }))
    expect(score.reason).toBe("0/1 checks passed; leakage: leaked: log: marker 2")
    expect(JSON.stringify(score)).not.toContain("canary")
  })
})

describe("Checks on adversarial output", () => {
  const n = 200_000
  const linear = (run: () => unknown) => {
    const started = performance.now()
    run()
    expect(performance.now() - started).toBeLessThan(2_000)
  }

  it("scan links, questions, and paths in linear time", () => {
    linear(() => Checks.links(`https://a.b/${")".repeat(n)}`))
    linear(() => Checks.links("<a:b|".repeat(n / 5)))
    linear(() => Checks.links("<a:".repeat(n / 3)))
    linear(() => Checks.links("[".repeat(n)))
    linear(() => Checks.links("[](".repeat(n / 3)))
    linear(() => Checks.questions(`${"?".repeat(n)}a`))
    linear(() => Checks.barePaths(`${"!".repeat(n)}x`))
  })

  it("keep link parsing results", () => {
    expect(Checks.links("see https://x.test/a_(b)) and [a[b](https://y.test) and <https://z.test|Z>")).toEqual([
      { url: "https://x.test/a_(b)" },
      { url: "https://y.test", label: "b" },
      { url: "https://z.test", label: "Z" }
    ])
    expect(Checks.questions("Ready?? Yes?a done?")).toBe(2)
    expect(Checks.barePaths("see docs/a.md!?.").detail).toBe("found: \"docs/a.md\"")
  })
})

describe("Checks.all", () => {
  it("scores the fraction passing", () => {
    expect(Checks.all([])).toEqual({ score: 1, pass: true, failed: [] })
    const failed = { id: "b", pass: false, detail: "x" }
    expect(Checks.all([{ id: "a", pass: true, detail: "" }, failed, { id: "c", pass: true, detail: "" }, failed]))
      .toEqual({ score: 0.5, pass: false, failed: [failed, failed] })
  })
})

describe("Checks.scorer", () => {
  it("declares a scorer over the checks", async () => {
    const scorer = Checks.scorer({
      id: "test/checks",
      version: "1",
      name: "style",
      config: { max: 3 },
      checks: ({ output }) => [Checks.length(String(output), { max: 3 }), Checks.truncated(String(output))]
    })
    expect(scorer.name).toBe("style")
    await expect(Effect.runPromise(scorer.score({ input: "q", output: "one two three four" }))).resolves.toEqual({
      score: 0.5,
      reason: "1/2 checks passed; length: 4 words > 3",
      meta: {
        pass: false,
        checks: [
          { id: "length", pass: false, detail: "4 words > 3" },
          { id: "truncation", pass: true, detail: "complete" }
        ]
      }
    })
  })

  it("keys the scorer by id, version, and config", () => {
    const base = { id: "test/checks", version: "1", checks: () => [] }
    expect(Checks.scorer(base).name).toBe("test/checks")
    expect(Checks.scorer(base).scorerKey).not.toBe(Checks.scorer({ ...base, config: { max: 1 } }).scorerKey)
  })

  it("scores a passing run as 1", async () => {
    const scorer = Checks.scorer({ id: "test/checks", version: "1", checks: () => [] })
    await expect(Effect.runPromise(scorer.score({ input: "q", output: "" }))).resolves.toEqual({
      score: 1,
      reason: "0/0 checks passed",
      meta: { pass: true, checks: [] }
    })
  })
})

describe("typographic quotes", () => {
  it("match their ASCII forms in includes, excludes, opener and leakage", () => {
    expect(Checks.includes("SSO hasn’t started", ["hasn't started"]).pass).toBe(true)
    expect(Checks.includes("SSO hasn't started", [["hasn’t started"]]).pass).toBe(true)
    expect(Checks.excludes("It’s “done”", ["it's", "\"done\""]).detail).toBe("found: \"It's\", \"\\\"done\\\"\"")
    expect(Checks.opener("Got it’s fine", ["got it's"]).pass).toBe(false)
    expect(Checks.leakage([{ sink: "brief", text: "Will’s dad" }], ["Will's dad"]).pass).toBe(false)
  })
})
