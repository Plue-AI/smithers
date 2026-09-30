/**
 * The refusal sentence `bin.ts` prints for a failure that has none of its own.
 *
 * `test/TwoProcessClaim.test.ts` proves the line reaches an operator's stderr
 * from a real process. These cases pin what that line says, against the real
 * `@smthrs/control` errors it is written for: the module is separate from
 * `bin.ts` precisely so it can be asked directly, since importing `bin.ts`
 * runs the command line.
 */
import { ControlError } from "@smthrs/control"
import { describe, expect, it } from "vitest"
import * as Failure from "../src/internal/Failure.ts"

describe("Failure.causeLine", () => {
  it("preserves typed headlines and selects older nested cause text", () => {
    expect(Failure.causeLine("quota_exceeded: Add credits.\nError: wrapper\n  [cause]: Error: inner"))
      .toBe("quota_exceeded: Add credits.")
    expect(Failure.causeLine("Error: wrapper\n  [cause]: Error: middle\n    [cause]: Error: retry later"))
      .toBe("Error: retry later")
    expect(Failure.causeLine("")).toBe("")
    expect(Failure.causeLine("x".repeat(2000))).toHaveLength(1024)
  })

  it("redacts before extracting a nested sentence and removes terminal controls", () => {
    expect(Failure.causeLine("Error: wrapper\n [cause]: Error: api_key=privatevalue123456 \u001b[31mrefused\u001b[0m"))
      .not.toContain("privatevalue123456")
    expect(Failure.causeLine("Error: denied\u0007")).toBe("Error: denied")
  })

  it("redacts diagnostic credential spellings", () => {
    expect(Failure.causeLine("Error: wrapper\n [cause]: Error: sshpass -p ZqSynthetic7Secret4Value9 ssh host"))
      .toBe("Error: sshpass -p [REDACTED] ssh host")
    expect(Failure.causeLine("Authorization: Token ZqSynthetic7Secret4Value9")).toBe("Authorization: [REDACTED]")
  })
})

describe("Failure.sentence", () => {
  it("keeps the failure's own sentence when it has one", () => {
    const stated = new ControlError.NoMatchingWait({ runId: "run-42", waitName: "go" })

    // `NoMatchingWait` overrides `message`, and an override always wins: the
    // fields would say less than the sentence its author wrote.
    expect(Failure.sentence(stated)).toBe(stated.message)
    expect(Failure.sentence(stated)).toContain("no wait point named")
  })

  it("states the contract code and the run for a failure with no sentence", () => {
    // The line `smthrs resume` prints when a live peer owns the run. Before
    // this, the whole line was `ClaimLost: `, which named neither.
    expect(Failure.sentence(new ControlError.ClaimLost({ runId: "run-42" })))
      .toBe("claim_lost runId=run-42")
  })

  it("names every scalar field, code first, in the order the error declares them", () => {
    expect(Failure.sentence(new ControlError.Unavailable({ feature: "watch", ticket: "S-12" })))
      .toBe("unavailable feature=watch ticket=S-12")
  })

  it("bounds one field so a large value cannot flood the terminal", () => {
    const issue = "x".repeat(Failure.fieldValueLimit * 3)

    const rendered = Failure.sentence(new ControlError.InvalidInput({ issue }))

    expect(rendered).toBe(`invalid_input issue=${"x".repeat(Failure.fieldValueLimit)}`)
    // Bounded by code points rather than by UTF-16 units, so the cut cannot
    // land inside a surrogate pair and produce a lone half.
    expect([...rendered].length).toBeLessThan(issue.length)
  })

  it("leaves structured fields out of the line", () => {
    // Every rc.0 control error declares scalar fields only, so the error that
    // makes this rule observable is built here. The rule is what keeps the
    // line a line: a failure that grows an envelope, a diff, or a list of
    // candidates must not turn one refusal into a page of output, and the
    // structure is in the run's journal either way.
    const structured = Object.assign(new Error(""), {
      code: "envelope_mismatch",
      planId: "plan-1",
      expected: { capabilities: [], flows: [], budget: {} },
      candidates: ["a", "b"]
    })

    expect(Failure.sentence(structured)).toBe("envelope_mismatch planId=plan-1")
  })

  it("answers the empty string for an error carrying neither a code nor a scalar field", () => {
    // The reporter then prints exactly what it printed before this existed:
    // the class name and a colon. Nothing was invented to fill the gap.
    expect(Failure.sentence(new Error(""))).toBe("")
  })
})

describe("Failure.operatorSentence", () => {
  it("prints a tagged failure's own sentence", () => {
    const stated = new ControlError.NoMatchingWait({ runId: "run-42", waitName: "go" })

    expect(Failure.operatorSentence(stated)).toBe(stated.message)
    expect(Failure.operatorSentence(new ControlError.ClaimLost({ runId: "run-42" }))).toBe("claim_lost runId=run-42")
  })

  it("prints the sentence of a plain Error the CLI threw on purpose", () => {
    // Transitional (#2813): these become tagged refusals; until then their
    // sentence is still the one the operator needs.
    expect(Failure.operatorSentence(new Error("No flows found in /work"))).toBe("No flows found in /work")
  })

  it("prints the message of a decoded refusal record", () => {
    expect(Failure.operatorSentence({ _tag: "/control/Unavailable", message: "down" })).toBe("down")
  })

  it.each([
    ["a runtime bug", new TypeError("Cannot read properties of undefined (reading 'id')")],
    ["a range error", new RangeError("Invalid array length")],
    [
      "a Node system error",
      Object.assign(new Error("ENOENT: no such file or directory, open '/home/op/.config/x'"), {
        code: "ENOENT",
        errno: -2,
        syscall: "open"
      })
    ],
    ["a string", "TypeError: undefined is not a function"],
    ["an object", { stack: "at x (y.ts:1)" }],
    ["undefined", undefined],
    ["an Error with no sentence and no fields", new Error("")]
  ])("never prints %s; it answers the generic sentence", (_label, error) => {
    expect(Failure.operatorSentence(error)).toBe(Failure.unknownSentence)
  })

  it("matches the product's unknown-failure sentence", async () => {
    const { UNKNOWN_FAILURE } = await import("../../rpc/src/UserFailure.ts")
    expect(Failure.unknownSentence).toBe(UNKNOWN_FAILURE.sentence)
  })
})

describe("Failure.operatorLine", () => {
  it("names a tagged failure by its class, not its namespace", () => {
    expect(Failure.operatorLine(new ControlError.ClaimLost({ runId: "run-42" }), false))
      .toBe("ClaimLost: claim_lost runId=run-42")
  })

  it("prints only the generic sentence for an undesigned failure", () => {
    expect(Failure.operatorLine(new TypeError("x is not a function"), false)).toBe(Failure.unknownSentence)
  })

  it("adds the redacted raw detail under --verbose only", () => {
    const line = Failure.operatorLine(new TypeError("token=privatevalue123456 broke"), true)

    expect(line.startsWith(`${Failure.unknownSentence}\n`)).toBe(true)
    expect(line).toContain("broke")
    expect(line).not.toContain("privatevalue123456")
  })
})

describe("Failure.operatorReport", () => {
  it("prints a designed sentence alone, with or without --verbose", () => {
    const refusal = new ControlError.ClaimLost({ runId: "run-42" })
    expect(Failure.operatorReport(refusal, false)).toBe("claim_lost runId=run-42")
    expect(Failure.operatorReport(refusal, true)).toBe("claim_lost runId=run-42")
  })

  it("appends the redacted raw cause of an undesigned failure under --verbose only", () => {
    const missing = Object.assign(new Error("Cannot find package '@smthrs/gone' token=privatevalue123456"), {
      code: "ERR_MODULE_NOT_FOUND"
    })
    Object.setPrototypeOf(missing, TypeError.prototype)
    expect(Failure.operatorReport(missing, false)).toBe(Failure.unknownSentence)
    const report = Failure.operatorReport(missing, true)
    expect(report.startsWith(`${Failure.unknownSentence}\n`)).toBe(true)
    expect(report).toContain("@smthrs/gone")
    expect(report).not.toContain("privatevalue123456")
  })
})

describe("Failure.operatorDetail", () => {
  it("is the redacted, terminal-safe raw text, for --verbose only", () => {
    const detail = Failure.operatorDetail(new Error("api_key=privatevalue123456 \u001b]0;title\u0007boom"))

    expect(detail).toContain("boom")
    expect(detail).not.toContain("privatevalue123456")
    expect(detail).not.toContain("\u001b")
  })

  it("never throws for a value that cannot be printed", () => {
    const hostile = {
      get stack(): string {
        throw new Error("getter")
      },
      toString: () => {
        throw new Error("x")
      }
    }
    expect(typeof Failure.operatorDetail(hostile)).toBe("string")
  })
})

describe("terminalSafeValue", () => {
  it("makes every string of a structured value inert, keys included, and keeps other values", () => {
    expect(Failure.terminalSafeValue({
      "t\u001b[2Jitle": "a\u001b]0;x\u0007b\r\nc\td",
      list: ["\u009b31mred", 1, null, true, { deep: "\u0000z" }],
      n: 3
    })).toEqual({ title: "ab\nc\td", list: ["red", 1, null, true, { deep: "z" }], n: 3 })
    expect(Failure.terminalSafeValue(undefined)).toBeUndefined()
  })
})
