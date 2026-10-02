/**
 * The CLI's refusal family: its fault list stays the product's, and a refusal
 * routes by tag and exits 1.
 */
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { describe, expect, it } from "vitest"
import { PLUE_FAULTS } from "../../rpc/src/PlueFailureCodes.ts"
import * as CliError from "../src/CliError.ts"

describe("CliError.Refused", () => {
  it("decodes old refusals and round-trips only bounded integer HTTP statuses", () => {
    const old = { _tag: "/cli/Refused", fault: "user", code: "cloud_request_failed", message: "Old refusal" } as const
    const decode = Schema.decodeUnknownSync(CliError.Refused)
    const encode = Schema.encodeSync(CliError.Refused)
    expect(encode(decode(old))).toEqual(old)
    expect(decode(old)).not.toHaveProperty("httpStatus")
    for (const httpStatus of [100, 401, 403, 408, 409, 429, 503, 599]) {
      const encoded = { ...old, httpStatus }
      expect(encode(decode(encoded))).toEqual(encoded)
      expect(CliError.exitCode(decode(encoded))).toBe(1)
    }
    for (const httpStatus of [undefined, null, "401", 401.5, NaN, Infinity, 99, 600]) {
      expect(() => decode({ ...old, httpStatus })).toThrow()
    }
    expect(encode(decode({ ...old, code: "non_http_refusal" }))).toEqual({ ...old, code: "non_http_refusal" })
  })

  it("uses the product's fault list", () => {
    expect(CliError.FAULTS).toEqual(PLUE_FAULTS)
  })

  it("routes by tag with its fault and code, and exits 1", () => {
    const refused = new CliError.Refused({
      fault: "user",
      code: "not_signed_in",
      message: "Sign in with smthrs auth login."
    })
    const handled = Effect.runSync(
      Effect.fail(refused).pipe(
        Effect.catchTag("/cli/Refused", (error) => Effect.succeed(`${error.fault} ${error.code}`))
      )
    )

    expect(handled).toBe("user not_signed_in")
    expect(CliError.exitCode(refused)).toBe(1)
    expect(refused.message).toBe("Sign in with smthrs auth login.")
  })
})
