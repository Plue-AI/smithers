import * as NodeFs from "node:fs"
import { describe, expect, it } from "vitest"
import { errorCode, failureMessage, optionalOpenFlag } from "../src/internal/Fs.ts"

describe("filesystem failure inspection", () => {
  it.each([
    [undefined],
    [null],
    ["EACCES"],
    [123],
    [Symbol("failure")],
    [true]
  ])("does not read fields from a non-object failure %j", (cause) => {
    expect(errorCode(cause)).toBeUndefined()
    expect(failureMessage(cause)).toBe("unavailable failure")
  })

  it("accepts only own string data fields, including on callable errors", () => {
    const cause = Object.assign(() => undefined, { code: "EACCES", message: "permission denied" })
    expect(errorCode(cause)).toBe("EACCES")
    expect(failureMessage(cause)).toBe("permission denied")
    const standard = Object.assign(new Error("file absent"), { code: "ENOENT" })
    expect(errorCode(standard)).toBe("ENOENT")
    expect(failureMessage(standard)).toBe("file absent")
  })

  it("does not inherit error fields or invoke accessors", () => {
    let reads = 0
    const parent = { code: "EACCES", message: "inherited secret" }
    const cause = Object.create(parent) as Record<string, unknown>
    Object.defineProperties(cause, {
      code: {
        get: () => {
          reads++
          throw new Error("getter ran")
        }
      },
      message: {
        get: () => {
          reads++
          throw new Error("getter ran")
        }
      }
    })
    expect(errorCode(cause)).toBeUndefined()
    expect(failureMessage(cause)).toBe("unavailable failure")
    expect(reads).toBe(0)
    expect(errorCode(Object.create(parent))).toBeUndefined()
    expect(failureMessage(Object.create(parent))).toBe("unavailable failure")
  })

  it("ignores malformed data fields and blank messages without coercion", () => {
    const hostile = {
      toString: () => {
        throw new Error("coerced failure")
      }
    }
    for (
      const cause of [
        { code: 403, message: hostile },
        { code: hostile, message: 0 },
        { code: null, message: "" }
      ]
    ) {
      expect(errorCode(cause)).toBeUndefined()
      expect(failureMessage(cause)).toBe("unavailable failure")
    }
  })

  it("never activates Proxy traps, including on a revoked Proxy", () => {
    let traps = 0
    const proxy = new Proxy({ code: "EACCES", message: "private detail" }, {
      get: () => {
        traps++
        throw new Error("get trap ran")
      },
      getOwnPropertyDescriptor: () => {
        traps++
        throw new Error("descriptor trap ran")
      }
    })
    expect(errorCode(proxy)).toBeUndefined()
    expect(failureMessage(proxy)).toBe("unavailable failure")
    expect(traps).toBe(0)
    const revoked = Proxy.revocable({ code: "EIO", message: "revoked detail" }, {})
    revoked.revoke()
    expect(errorCode(revoked.proxy)).toBeUndefined()
    expect(failureMessage(revoked.proxy)).toBe("unavailable failure")
  })
})

describe("optionalOpenFlag", () => {
  it.each(["O_NOFOLLOW", "O_NONBLOCK"] as const)("uses the platform value of %s when available", (name) => {
    expect(optionalOpenFlag(name)).toBe((NodeFs.constants as Partial<Record<string, number>>)[name] ?? 0)
  })
})
