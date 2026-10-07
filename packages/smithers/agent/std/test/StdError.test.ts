import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { Code, StdError } from "../src/StdError.ts"

describe("stale_read diagnostics", () => {
  it("round trips the existing typed error with its path and both digests", () => {
    const error = new StdError({
      code: "stale_read",
      message: "Re-read before retrying",
      path: "src/a.ts",
      base_digest: "e49c81e2d2f84e259d40e2fb8192f3bcd198b355184845d76d8f58807d0d78ee",
      current_digest: "92a214fa61579091222f97eaf8e9bf11c1a728af5a077a3b5568231b6dc5be43"
    })
    const encoded = Schema.encodeSync(StdError)(error)
    const decoded = Schema.decodeUnknownSync(StdError)(encoded)
    expect(decoded).toMatchObject({
      _tag: "@smthrs/std/StdError",
      code: "stale_read",
      path: "src/a.ts",
      base_digest: error.base_digest,
      current_digest: error.current_digest
    })
  })

  it("accepts unread and absent diagnostics without breaking older errors", () => {
    expect(
      Schema.decodeUnknownSync(StdError)({
        _tag: "@smthrs/std/StdError",
        code: "stale_read",
        message: "Re-read",
        path: "src/a.ts",
        base_digest: "unread",
        current_digest: "absent"
      })
    ).toMatchObject({ base_digest: "unread", current_digest: "absent" })
    expect(
      Schema.decodeUnknownSync(StdError)({
        _tag: "@smthrs/std/StdError",
        code: "not_found",
        message: "Missing",
        path: "src/a.ts"
      }).code
    ).toBe("not_found")
    expect(Schema.decodeUnknownResult(Code)("stale_read")._tag).toBe("Success")
    expect(Schema.decodeUnknownResult(Code)("made_up")._tag).toBe("Failure")
  })
})

 it("round trips the daemon moved_off refusal through the standard error", () => {
  const error = new StdError({ code: "moved_off", message: "Branch moved off the item", path: "retry.ts" })
  expect(Schema.decodeUnknownSync(StdError)(Schema.encodeSync(StdError)(error))).toMatchObject({
    _tag: "@smthrs/std/StdError", code: "moved_off", path: "retry.ts", message: "Branch moved off the item"
  })
  expect(Schema.decodeUnknownResult(Code)("moved_off")._tag).toBe("Success")
})
