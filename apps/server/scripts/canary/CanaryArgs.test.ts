import { describe, expect, test } from "bun:test"
import { argReader, readFlag } from "./CanaryArgs.ts"

describe("readFlag", () => {
  test("a flag reads its value", () => {
    expect(readFlag(["--sha", "abc1234", "--max-drift", "3"], "--max-drift")).toEqual({ state: "value", value: "3" })
  })

  test("an unpassed flag is absent", () => {
    expect(readFlag([], "--sha")).toEqual({ state: "absent" })
    expect(readFlag(["--max-drift", "3"], "--sha")).toEqual({ state: "absent" })
  })

  /*
   * The dangerous case: a flag with no value would otherwise swallow the next
   * flag, and the shell would grade the deployment against a string that is
   * not a sha, or write its report to a file named "--samples".
   */
  test("a flag followed by another flag has no value, and says which flag it read", () => {
    const read = readFlag(["--sha", "--max-drift", "3"], "--sha")
    expect(read.state).toBe("no-value")
    if (read.state === "no-value") expect(read.detail).toContain("--max-drift")
  })

  test("a flag passed last has no value", () => {
    expect(readFlag(["--sha"], "--sha").state).toBe("no-value")
  })

  test("a boolean flag is not eaten by a preceding value flag", () => {
    expect(readFlag(["--sha", "--allow-unstamped-html"], "--sha").state).toBe("no-value")
  })

  test("a value that merely starts with a dash is still a value", () => {
    expect(readFlag(["--run-url", "-"], "--run-url")).toEqual({ state: "value", value: "-" })
  })
})

describe("argReader", () => {
  const reader = (argv: ReadonlyArray<string>) => {
    const refused: Array<string> = []
    const read = argReader(argv, ((detail: string) => {
      refused.push(detail)
      throw new Error(detail)
    }) as (detail: string) => never)
    return { read, refused }
  }

  test("a value is returned and an absent flag is undefined", () => {
    const { read, refused } = reader(["--report", "/tmp/report.json"])
    expect(read("--report")).toBe("/tmp/report.json")
    expect(read("--body-out")).toBeUndefined()
    expect(refused).toEqual([])
  })

  test("a flag with no value refuses instead of defaulting", () => {
    const { read, refused } = reader(["--json", "--samples", "3"])
    expect(() => read("--json")).toThrow()
    expect(refused[0]).toContain("--json needs a value")
    expect(refused[0]).toContain("--samples")
  })
})
