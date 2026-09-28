import { describe, expect, it } from "vitest"
import { compare, isBeforeOneZero, parse } from "../src/internal/Semver.ts"

describe("Smithers dependency version boundary", () => {
  it.each(
    [
      ["^0.35.0", { major: 0, minor: 35, patch: 0, prerelease: [] }],
      [">=0.35.0 <1", { major: 0, minor: 35, patch: 0, prerelease: [] }],
      ["1.0.0-rc.12", { major: 1, minor: 0, patch: 0, prerelease: ["rc", "12"] }],
      ["1.2.3-alpha.4.beta", { major: 1, minor: 2, patch: 3, prerelease: ["alpha", "4", "beta"] }]
    ] as const
  )("parses the first version in %s", (specifier, expected) => {
    expect(parse(specifier)).toEqual(expected)
  })

  it.each(["", "latest", "workspace:*", "file:../smithers", "link:../smithers", "^1.0"])(
    "leaves a specifier without a complete version unresolved (%s)",
    (specifier) => expect(parse(specifier)).toBeUndefined()
  )

  it.each(
    [
      ["major", "9007199254740991.0.0", { major: 9007199254740991, minor: 0, patch: 0, prerelease: [] }],
      ["minor", "0.9007199254740991.0", { major: 0, minor: 9007199254740991, patch: 0, prerelease: [] }],
      ["patch", "0.0.9007199254740991", { major: 0, minor: 0, patch: 9007199254740991, prerelease: [] }]
    ] as const
  )("accepts the largest safe %s component exactly", (_component, specifier, expected) => {
    expect(parse(specifier)).toEqual(expected)
  })

  it.each(["major", "minor", "patch"] as const)(
    "refuses unsafe %s components without rounding or Infinity",
    (component) => {
      const version = (value: string): string =>
        component === "major" ?
          `${value}.0.0`
          : component === "minor"
          ? `0.${value}.0`
          : `0.0.${value}`
      for (const value of ["9007199254740992", "9007199254740993", "9".repeat(311)]) {
        expect(parse(version(value))).toBeUndefined()
      }
    }
  )

  it("accepts a safely valued zero-padded core and decides only the first complete version", () => {
    expect(parse("0000009007199254740991.0000002.00003")).toEqual({
      major: 9007199254740991,
      minor: 2,
      patch: 3,
      prerelease: []
    })
    expect(parse(">=0.35.0 <9007199254740992.0.0")).toEqual({
      major: 0,
      minor: 35,
      patch: 0,
      prerelease: []
    })
    expect(parse(">=0.9007199254740992.0 <1.0.0")).toBeUndefined()
  })

  it("orders release and prerelease identifiers by SemVer precedence", () => {
    const ordered = [
      "1.0.0-alpha",
      "1.0.0-alpha.1",
      "1.0.0-alpha.beta",
      "1.0.0-beta",
      "1.0.0-beta.2",
      "1.0.0-beta.11",
      "1.0.0-rc.1",
      "1.0.0"
    ]
    for (let index = 0; index < ordered.length; index++) {
      const version = parse(ordered[index]!)!
      expect(compare(version, version)).toBe(0)
      for (let later = index + 1; later < ordered.length; later++) {
        expect(compare(version, parse(ordered[later]!)!)).toBe(-1)
        expect(compare(parse(ordered[later]!)!, version)).toBe(1)
      }
    }
  })

  it.each(
    [
      ["0.99.99", "1.0.0", -1],
      ["1.0.0", "1.0.1", -1],
      ["1.0.2", "1.0.1", 1],
      ["1.0.99", "1.1.0", -1],
      ["1.1.0", "1.0.99", 1],
      ["2.0.0", "1.99.99", 1],
      ["1.0.0-2", "1.0.0-11", -1],
      ["1.0.0-11", "1.0.0-beta", -1]
    ] as const
  )("compares %s with %s by numeric precedence", (left, right, expected) => {
    expect(compare(parse(left)!, parse(right)!)).toBe(expected)
  })

  it.each(
    [
      ["past the safe integer range", "9007199254740992", "9007199254740993"],
      ["past the binary64 range", `1${"0".repeat(309)}1`, `1${"0".repeat(309)}2`]
    ] as const
  )("orders adjacent numeric prerelease identifiers %s", (_boundary, smaller, larger) => {
    expect(compare(parse(`1.0.0-${smaller}`)!, parse(`1.0.0-${larger}`)!)).toBe(-1)
    expect(compare(parse(`1.0.0-${larger}`)!, parse(`1.0.0-${smaller}`)!)).toBe(1)
  })

  it("compares the next identifier after equal numeric values with different leading zeros", () => {
    expect(compare(parse("1.0.0-01")!, parse("1.0.0-1")!)).toBe(0)
    expect(compare(parse("1.0.0-1")!, parse("1.0.0-01")!)).toBe(0)
    expect(compare(parse("1.0.0-000001.alpha")!, parse("1.0.0-1.beta")!)).toBe(-1)
    expect(compare(parse("1.0.0-1.beta")!, parse("1.0.0-000001.alpha")!)).toBe(1)
  })

  it.each(
    [
      ["^0.35.0", true],
      [">=0.35.0 <1", true],
      ["1.0.0-0", false],
      ["1.0.0-rc.0", false],
      ["1.0.0", false],
      ["workspace:*", true],
      ["file:../smithers", true],
      ["9007199254740992.0.0", true]
    ] as const
  )("classifies %s at the 1.0 migration gate", (specifier, expected) => {
    expect(isBeforeOneZero(specifier)).toBe(expected)
  })
})
