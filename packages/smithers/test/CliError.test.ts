/**
 * The CLI's refusal family: its fault list stays the product's, and a refusal
 * routes by tag and exits 1.
 */
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import { PLUE_FAULTS } from "../../rpc/src/PlueFailureCodes.ts"
import * as CliError from "../src/CliError.ts"

describe("CliError.Refused", () => {
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
