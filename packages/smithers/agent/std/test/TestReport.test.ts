import { describe, expect, it } from "vitest"
import * as TestReport from "../src/internal/TestReport.ts"

describe("TestReport", () => {
  it("reads pytest's short summary and tally", () => {
    const output = [
      "============================= test session starts ==============================",
      "collected 43 items",
      "",
      "tests/test_widen.py::test_widens PASSED                                  [ 50%]",
      "tests/test_widen.py::test_narrows FAILED                                 [100%]",
      "",
      "=========================== short test summary info ============================",
      "FAILED tests/test_widen.py::test_narrows - AssertionError: 3 != 4",
      "ERROR tests/test_other.py::test_imports",
      "==================== 1 failed, 1 error, 41 passed in 1.20s ====================="
    ].join("\n")
    expect(TestReport.parse(output)).toEqual({
      passed: 41,
      failed: ["tests/test_widen.py::test_narrows", "tests/test_other.py::test_imports"],
      reportedFailed: 2,
      parsed: true
    })
  })

  it("keeps observed pytest outcomes but rejects a verbose capture without a tally", () => {
    const output = [
      "tests/test_a.py::test_one PASSED",
      "tests/test_a.py::test_two PASSED",
      "tests/test_a.py::test_three FAILED"
    ].join("\n")
    expect(TestReport.parse(output)).toEqual({
      passed: 2,
      failed: ["tests/test_a.py::test_three"],
      reportedFailed: undefined,
      parsed: false
    })
  })

  it("suppresses attribution between unrelated verbose-only pytest tails", () => {
    const base = TestReport.parse("test_a.py::test_x FAILED\n")
    const current = TestReport.parse("test_a.py::test_y PASSED\n")

    expect(TestReport.attribute(current, base)).toBeUndefined()
  })

  it("attributes complete pytest captures whose tallies agree with their ids", () => {
    const base = TestReport.parse([
      "test_a.py::test_x FAILED",
      "FAILED test_a.py::test_x - AssertionError",
      "========================= 1 failed in 0.10s ========================="
    ].join("\n"))
    const current = TestReport.parse([
      "test_a.py::test_x PASSED",
      "========================= 1 passed in 0.10s ========================="
    ].join("\n"))

    expect(base.parsed).toBe(true)
    expect(current.parsed).toBe(true)
    expect(TestReport.attribute(current, base)).toEqual({
      introduced: [],
      preexisting: [],
      fixed: ["test_a.py::test_x"]
    })
  })

  it("reads unittest, whose ids are the other way round", () => {
    const output = [
      "test_widens (tests.test_widen.WidenTests) ... ok",
      "test_narrows (tests.test_widen.WidenTests) ... FAIL",
      "======================================================================",
      "FAIL: test_narrows (tests.test_widen.WidenTests)",
      "----------------------------------------------------------------------",
      "Ran 2 tests in 0.003s",
      "",
      "FAILED (failures=1)"
    ].join("\n")
    expect(TestReport.parse(output)).toEqual({
      passed: 1,
      failed: ["tests.test_widen.WidenTests.test_narrows"],
      reportedFailed: 1,
      parsed: true
    })
  })

  it.each([
    {
      name: "Python 3.11 failure ids",
      output: "FAIL: test_x (tests.Case.test_x)\nRan 2 tests in 0.001s\nFAILED (failures=1)",
      expected: { passed: 1, failed: ["tests.Case.test_x"], reportedFailed: 1, parsed: true }
    },
    {
      name: "unittest skips only",
      output: "Ran 2 tests in 0.001s\nOK (skipped=2)",
      expected: { passed: 0, failed: [], reportedFailed: 0, parsed: true }
    },
    {
      name: "unittest pass, skip and failure",
      output: "FAIL: test_x (tests.Case.test_x)\nRan 3 tests in 0.001s\nFAILED (failures=1, skipped=1)",
      expected: { passed: 1, failed: ["tests.Case.test_x"], reportedFailed: 1, parsed: true }
    },
    {
      name: "unittest expected failure",
      output: "Ran 1 test in 0.001s\nOK (expected failures=1)",
      expected: { passed: 0, failed: [], reportedFailed: 0, parsed: true }
    },
    {
      name: "unittest failure and expected failure",
      output: "FAIL: test_x (tests.Case.test_x)\nRan 3 tests in 0.001s\nFAILED (failures=1, expected failures=1)",
      expected: { passed: 1, failed: ["tests.Case.test_x"], reportedFailed: 1, parsed: true }
    },
    {
      name: "unittest unexpected success",
      output: "UNEXPECTED SUCCESS: test_x (tests.Case.test_x)\nRan 1 test in 0.001s\nFAILED (unexpected successes=1)",
      expected: { passed: 0, failed: ["tests.Case.test_x"], reportedFailed: 1, parsed: true }
    },
    {
      name: "unittest unexpected success without an id",
      output: "Ran 1 test in 0.001s\nFAILED (unexpected successes=1)",
      expected: { passed: 0, failed: [], reportedFailed: 1, parsed: false }
    },
    {
      name: "unittest unrecognised outcome",
      output: "Ran 1 test in 0.001s\nOK (custom=1)",
      expected: { passed: 0, failed: [], reportedFailed: undefined, parsed: false }
    },
    {
      name: "TAP skip only",
      output: "1..1\nok 1 - unavailable # SKIP missing dependency",
      expected: { passed: 0, failed: [], reportedFailed: 0, parsed: true }
    },
    {
      name: "TAP pass, skip and failure",
      output: "1..3\nok 1 - works\nok 2 - unavailable # skip missing dependency\nnot ok 3 - broken",
      expected: { passed: 1, failed: ["broken"], reportedFailed: 1, parsed: true }
    },
    {
      name: "TAP TODO failure",
      output: "1..1\nnot ok 1 - future behavior # TODO implement",
      expected: { passed: 0, failed: [], reportedFailed: 0, parsed: true }
    },
    {
      name: "TAP TODO success",
      output: "1..1\nok 1 - future behavior # todo implemented",
      expected: { passed: 1, failed: [], reportedFailed: 0, parsed: true }
    },
    {
      name: "TAP skipped failure",
      output: "1..1\nnot ok 1 - unavailable # SkIp missing dependency",
      expected: { passed: 0, failed: [], reportedFailed: 0, parsed: true }
    },
    {
      name: "TAP unnamed failure",
      output: "1..1\nnot ok 1",
      expected: { passed: 0, failed: [], reportedFailed: 1, parsed: false }
    },
    {
      name: "TAP duplicate failure descriptions",
      output: "1..2\nnot ok 1 - broken\nnot ok 2 - broken",
      expected: { passed: 0, failed: ["broken"], reportedFailed: 2, parsed: false }
    },
    {
      name: "TAP incomplete skip capture",
      output: "1..2\nok 1 - unavailable # SKIP missing dependency",
      expected: { passed: 0, failed: [], reportedFailed: 0, parsed: false }
    }
  ])("reads $name and gates attribution", ({ output, expected }) => {
    const report = TestReport.parse(output)
    expect(report).toEqual(expected)
    const clean = { passed: 1, failed: [], reportedFailed: 0, parsed: true }
    expect(TestReport.attribute(report, clean)).toEqual(
      expected.parsed
        ? { introduced: expected.failed, preexisting: [], fixed: [] }
        : undefined
    )
    expect(TestReport.attribute(clean, report)).toEqual(
      expected.parsed
        ? { introduced: [], preexisting: [], fixed: expected.failed }
        : undefined
    )
  })

  it.each(["", "OK\n"])("reads pytest with captured output %j", (prefix) => {
    expect(TestReport.parse(
      prefix + [
        "FAILED tests/test_a.py::test_two - AssertionError",
        "========================= 1 failed, 1 passed in 0.10s ========================="
      ].join("\n")
    )).toEqual({
      passed: 1,
      failed: ["tests/test_a.py::test_two"],
      reportedFailed: 1,
      parsed: true
    })
  })

  it("keeps a failing Node TAP report authoritative despite diagnostic tallies", () => {
    const output = [
      "TAP version 13",
      "# 1 passed",
      "# Subtest: actual failure",
      "not ok 1 - actual failure",
      "1..1",
      "# tests 1",
      "# pass 0",
      "# fail 1"
    ].join("\n")
    const report = TestReport.parse(output)
    expect(report).toEqual({ passed: 0, failed: ["actual failure"], reportedFailed: 1, parsed: true })
    expect(TestReport.attribute(report, TestReport.parse("1..1\nnot ok 1 - actual failure"))).toEqual({
      introduced: [],
      preexisting: ["actual failure"],
      fixed: []
    })
  })

  it("ignores pytest diagnostic counts before the terminal tally", () => {
    const output = "retrying: 3 failed attempts\n=== 1 passed in 0.10s ===\n"
    expect(TestReport.parse(output)).toEqual({ passed: 1, failed: [], reportedFailed: 0, parsed: true })
  })

  it("keeps unittest diagnostics from choosing pytest", () => {
    const output = "1 passed\nFAIL: test_x (tests.Case)\nRan 1 test in 0.001s\nFAILED (failures=1)"
    expect(TestReport.parse(output)).toEqual({
      passed: 0,
      failed: ["tests.Case.test_x"],
      reportedFailed: 1,
      parsed: true
    })
  })

  it("refuses mixed runner completion markers", () => {
    const output = "TAP version 13\n1..1\nnot ok 1 - broken\n=== 1 passed in 0.10s ==="
    expect(TestReport.parse(output).parsed).toBe(false)
  })

  it("reads TAP", () => {
    const output = ["TAP version 13", "1..2", "ok 1 - widens", "not ok 2 - narrows"].join("\n")
    expect(TestReport.parse(output)).toEqual({ passed: 1, failed: ["narrows"], reportedFailed: 1, parsed: true })
  })

  it("rejects TAP outcomes without a plan", () => {
    expect(TestReport.parse("not ok 1 - narrows\n")).toEqual({
      passed: 0,
      failed: ["narrows"],
      reportedFailed: 1,
      parsed: false
    })
  })

  it("rejects TAP when the plan exceeds the observed outcome count", () => {
    const output = ["TAP version 13", "1..3", "ok 1 - widens", "not ok 2 - narrows"].join("\n")
    expect(TestReport.parse(output)).toEqual({
      passed: 1,
      failed: ["narrows"],
      reportedFailed: 1,
      parsed: false
    })
  })

  it("does not claim a complete pytest reading from a summary alone", () => {
    expect(TestReport.parse("2 failed in 0.10s\n")).toEqual({
      passed: 0,
      failed: [],
      reportedFailed: 2,
      parsed: false
    })
  })

  it("does not turn unittest's reported failures into passes when headers are missing", () => {
    expect(TestReport.parse("Ran 2 tests in 0.003s\n\nFAILED (failures=2)\n")).toEqual({
      passed: 0,
      failed: [],
      reportedFailed: 2,
      parsed: false
    })
  })

  it("rejects a pytest failure count that disagrees with the identified ids", () => {
    const output = [
      "FAILED tests/test_a.py::test_one - boom",
      "========================= 2 failed in 0.10s ========================="
    ].join("\n")
    expect(TestReport.parse(output)).toEqual({
      passed: 0,
      failed: ["tests/test_a.py::test_one"],
      reportedFailed: 2,
      parsed: false
    })
  })

  it("keeps spaces inside parameterized pytest ids", () => {
    const output = [
      "tests/test_cases.py::test_value[one two] FAILED",
      "FAILED tests/test_cases.py::test_value[one two] - AssertionError",
      "========================= 1 failed in 0.10s ========================="
    ].join("\n")
    expect(TestReport.parse(output)).toEqual({
      passed: 0,
      failed: ["tests/test_cases.py::test_value[one two]"],
      reportedFailed: 1,
      parsed: true
    })
  })

  it("says plainly when it recognised nothing", () => {
    // A wrong failure set is worse than none: attribution is built on it.
    expect(TestReport.parse("Segmentation fault (core dumped)\n")).toEqual({
      passed: 0,
      failed: [],
      reportedFailed: undefined,
      parsed: false
    })
    expect(TestReport.parse("")).toEqual({ passed: 0, failed: [], reportedFailed: undefined, parsed: false })
  })

  it("differences two runs into the three sets attribution needs", () => {
    expect(TestReport.attribute(
      { passed: 1, failed: ["a", "b"], reportedFailed: 2, parsed: true },
      { passed: 1, failed: ["b", "c"], reportedFailed: 2, parsed: true }
    )).toEqual({
      introduced: ["a"],
      preexisting: ["b"],
      fixed: ["c"]
    })
  })

  it("suppresses attribution when either report is incomplete", () => {
    const complete: TestReport.Report = {
      passed: 1,
      failed: ["tests/test_a.py::test_one"],
      reportedFailed: 1,
      parsed: true
    }
    const incomplete: TestReport.Report = { passed: 0, failed: [], reportedFailed: 2, parsed: false }
    expect(TestReport.attribute(complete, incomplete)).toBeUndefined()
    expect(TestReport.attribute(incomplete, complete)).toBeUndefined()
  })
})
