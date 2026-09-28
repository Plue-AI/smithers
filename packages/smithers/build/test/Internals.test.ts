/**
 * The two internal helpers shipped code depends on for safety, tested where
 * they live.
 *
 * `diagnostic` is what a journaled error carries instead of the raw host
 * failure, so its bounds and its refusals decide whether a run records a typed
 * failure or dies encoding one. `normalizeEnvironment` is the gate every host
 * environment passes through before a child can be built from it. The seams
 * above them reach only the shapes those seams happen to produce; these are
 * the rest.
 */
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { Diagnostic, diagnostic } from "../src/internal/diagnostic.ts"
import { normalizeEnvironment, plainRecord, usableText } from "../src/internal/validate.ts"

const nul = String.fromCharCode(0)
const loneHighSurrogate = String.fromCharCode(0xd800)
const loneLowSurrogate = String.fromCharCode(0xdc00)

describe("diagnostic", () => {
  it("leaves an absent cause absent", () => {
    expect(diagnostic(undefined)).toBeUndefined()
  })

  it("describes a primitive cause without inventing a name", () => {
    expect(diagnostic("boom")).toEqual({ name: "string", message: "boom" })
    expect(diagnostic(7)).toEqual({ name: "number", message: "7" })
    expect(diagnostic(null)).toEqual({ name: "null", message: "null" })
    expect(diagnostic(Symbol("boom"))).toEqual({ name: "symbol", message: "Symbol(boom)" })
  })

  it("takes the code and the errno sentence off one nested cause", () => {
    const nested = Object.assign(new Error("no such file or directory"), { code: "ENOENT" })
    const outer = Object.assign(new Error("FileSystem.realPath"), { cause: nested })
    expect(diagnostic(outer)).toEqual({
      name: "Error",
      code: "ENOENT",
      message: "FileSystem.realPath: no such file or directory"
    })
  })

  it("does not repeat a nested message the outer one already carries", () => {
    const outer = Object.assign(new Error("outer says inner"), { cause: new Error("inner") })
    expect(diagnostic(outer)?.message).toBe("outer says inner")
  })

  it("falls back to the tag when a failure has no name", () => {
    expect(diagnostic({ _tag: "PlatformError", message: "refused" })).toEqual({
      name: "PlatformError",
      message: "refused"
    })
    expect(diagnostic({})).toEqual({ name: "Error", message: "unknown failure" })
  })

  it("bounds what it retains, so a huge failure cannot be journaled whole", () => {
    expect(diagnostic(new Error("a".repeat(10_000)))?.message.length).toBe(2_048)
  })

  /**
   * The symbol branch returned `cause.toString()` unsliced while every other
   * branch sliced to the bound, so a Symbol whose description ran past the
   * bound produced a Diagnostic its own schema refused to encode.
   */
  it("bounds a symbol's rendering and keeps it inside the schema", () => {
    const described = diagnostic(Symbol("s".repeat(2_048)))
    expect(described?.message.length).toBe(2_048)
    expect(described?.message.startsWith("Symbol(s")).toBe(true)
    expect(Schema.encodeUnknownSync(Diagnostic)(described)).toEqual(described)
    expect(Schema.encodeUnknownSync(Diagnostic)(diagnostic(Symbol("boom")))).toEqual({
      name: "symbol",
      message: "Symbol(boom)"
    })
  })

  it("refuses an over-long field at the schema, not only at the construction site", () => {
    expect(Schema.decodeUnknownSync(Diagnostic)({ name: "PlatformError", message: "refused" })).toEqual({
      name: "PlatformError",
      message: "refused"
    })
    expect(() => Schema.decodeUnknownSync(Diagnostic)({ name: "n".repeat(129), message: "m" })).toThrow()
    expect(() => Schema.decodeUnknownSync(Diagnostic)({ name: "n", message: "m".repeat(2_049) })).toThrow()
    expect(() => Schema.decodeUnknownSync(Diagnostic)({ name: "n", code: "c".repeat(129), message: "m" }))
      .toThrow()
  })

  it("reports a hostile accessor as an unnamed failure rather than invoking it", () => {
    let reads = 0
    const hostile = Object.defineProperty({}, "message", {
      enumerable: true,
      get: () => {
        reads += 1
        return "leaked"
      }
    })
    expect(diagnostic(hostile)).toEqual({ name: "Error", message: "unknown failure" })
    expect(reads).toBe(0)
  })

  it("bounds observation when a hostile proxy refuses property inspection", () => {
    let inspections = 0
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        inspections += 1
        throw new Error("sensitive proxy detail")
      }
    })
    expect(diagnostic(hostile)).toEqual({ name: "Error", message: "unknown failure" })
    expect(inspections).toBeGreaterThan(0)
  })
})

describe("normalizeEnvironment", () => {
  const normalize = (value: unknown) => () => normalizeEnvironment(value, false, "environment")

  it("reads an absent environment as an empty lookup table", () => {
    expect(normalizeEnvironment(undefined, false, "environment").size).toBe(0)
  })

  it("drops an undefined value rather than forwarding it as text", () => {
    expect(normalizeEnvironment({ PATH: "/bin", ABSENT: undefined }, false, "environment")).toEqual(
      new Map([["PATH", "/bin"]])
    )
  })

  it("refuses everything a child environment cannot carry", () => {
    expect(normalize("PATH=/bin")).toThrow(/must be an object of string values/)
    expect(normalize([["PATH", "/bin"]])).toThrow(/must be an object of string values/)
    expect(normalize({ [Symbol("PATH")]: "/bin" })).toThrow(/symbol properties/)
    expect(normalize({ PATH: 7 })).toThrow(/must be a string or undefined/)
    expect(normalize({ PATH: `/bin${nul}/sbin` })).toThrow(/not usable text/)
    expect(normalize({ PATH: loneHighSurrogate })).toThrow(/not usable text/)
    expect(normalize(Object.fromEntries(Array.from({ length: 4_097 }, (_, index) => [`N${index}`, "x"]))))
      .toThrow(/more than 4096 entries/)
    expect(normalize({ PATH: "x".repeat(256 * 1024 + 1) })).toThrow(/exceeds 262144 bytes/)
  })

  it("accepts an environment exactly at each bound", () => {
    const atEntryBound = Object.fromEntries(Array.from({ length: 4_096 }, (_, index) => [`N${index}`, "x"]))
    expect(normalizeEnvironment(atEntryBound, false, "environment").size).toBe(4_096)
    const atByteBound = { PATH: "x".repeat(256 * 1024 - "PATH".length) }
    expect(normalizeEnvironment(atByteBound, false, "environment").get("PATH")?.length).toBe(262_140)
    expect(normalize(Object.defineProperty({}, "PATH", { enumerable: true, get: () => "/bin" })))
      .toThrow(/must be an enumerable data property/)
  })
})

describe("validation helpers", () => {
  it("accepts a null-prototype record and refuses anything else", () => {
    expect(plainRecord(Object.create(null) as object, "options")).toBeDefined()
    expect(() => plainRecord(new Date(), "options")).toThrow(/must be a plain object/)
    expect(() => plainRecord([], "options")).toThrow(/must be a plain object/)
    expect(() => plainRecord(null, "options")).toThrow(/must be a plain object/)
  })

  it("holds text to non-empty, NUL-free, well-formed, and bounded", () => {
    expect(usableText("ok", 8)).toBe(true)
    expect(usableText("", 8)).toBe(false)
    expect(usableText(`a${nul}b`, 8)).toBe(false)
    expect(usableText(loneLowSurrogate, 8)).toBe(false)
    expect(usableText("\u{1f600}", 8)).toBe(true)
    expect(usableText("aaaaaaaa", 8)).toBe(true)
    expect(usableText("aaaaaaaaa", 8)).toBe(false)
    expect(usableText(7, 8)).toBe(false)
  })
})
