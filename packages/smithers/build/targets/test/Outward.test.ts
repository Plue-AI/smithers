/**
 * The shared refusal gate every outward-effect rule runs before it acts.
 *
 * These assertions are about refusals only. No rule has an outward
 * transport yet, so the package planner refuses every one before this gate.
 */
import { describe, expect, it } from "vitest"
import * as Outward from "../src/Outward.ts"
import { HttpSecret, Secret } from "../src/Secret.ts"

const npmToken = HttpSecret(Secret("NPM_TOKEN"), ["https://registry.npmjs.org"])
const otherToken = HttpSecret(Secret("OTHER_TOKEN"), ["https://registry.npmjs.org"])

const requirements = (
  overrides: Partial<Outward.Requirements> = {}
): Outward.Requirements => ({
  rule: "Npm.Publish",
  required: ["NPM_TOKEN"],
  declared: [npmToken],
  approval: undefined,
  ...overrides
})

describe("refuse", () => {
  it("refuses when the declaration names no secrets at all", () => {
    const refusal = Outward.refuse(requirements({ declared: undefined }), { approvalGranted: true })
    expect(refusal?.code).toBe("missing_secret")
    expect(refusal?.rule).toBe("Npm.Publish")
  })

  it("refuses when a non-empty list omits one required name", () => {
    const refusal = Outward.refuse(requirements({ declared: [otherToken] }), { approvalGranted: true })
    expect(refusal?.code).toBe("missing_secret")
  })

  it("spells the exact declaration the author has to add", () => {
    const refusal = Outward.refuse(requirements({ declared: [] }), { approvalGranted: true })
    expect(refusal?.message).toContain("S.HttpSecret(S.Secret(\"NPM_TOKEN\"), [...])")
  })

  it("names the first missing entry when several are required", () => {
    const refusal = Outward.refuse(
      requirements({ required: ["NPM_TOKEN", "OTHER_TOKEN"], declared: [npmToken] }),
      { approvalGranted: true }
    )
    expect(refusal?.message).toContain("OTHER_TOKEN")
    expect(refusal?.message).not.toContain("\"NPM_TOKEN\"")
  })

  it("passes when every required name is declared and no approval is asked for", () => {
    expect(Outward.refuse(requirements(), { approvalGranted: false })).toBeUndefined()
  })

  it("refuses a required approval that was not granted, and passes one that was", () => {
    const declaration = requirements({ approval: "required" })
    const refusal = Outward.refuse(declaration, { approvalGranted: false })
    expect(refusal?.code).toBe("approval_unsatisfied")
    expect(Outward.refuse(declaration, { approvalGranted: true })).toBeUndefined()
  })

  it("checks the declared secret before the approval when both fail", () => {
    const refusal = Outward.refuse(
      requirements({ declared: [], approval: "required" }),
      { approvalGranted: false }
    )
    expect(refusal?.code).toBe("missing_secret")
  })

  it("passes satisfied declaration requirements", () => {
    expect(Outward.refuse(requirements(), { approvalGranted: true })).toBeUndefined()
  })
})

describe("isRefused", () => {
  it("is true for a refusal this gate produced", () => {
    const refusal = Outward.refuse(requirements({ declared: [] }), { approvalGranted: true })
    expect(Outward.isRefused(refusal)).toBe(true)
  })

  it("is false for a plain error, undefined, and a forged shape", () => {
    expect(Outward.isRefused(new Error("missing_secret"))).toBe(false)
    expect(Outward.isRefused(undefined)).toBe(false)
    expect(Outward.isRefused({ name: "Refused", code: "missing_secret" })).toBe(false)
  })
})

describe("Refused", () => {
  it("renders rule, code, and message, and exposes rule and code as fields", () => {
    const refusal = new Outward.Refused({
      rule: "Github.Pages",
      code: "approval_unsatisfied",
      detail: "nobody approved it"
    })
    expect(refusal.message).toBe("Github.Pages: approval_unsatisfied: nobody approved it")
    expect(refusal.rule).toBe("Github.Pages")
    expect(refusal.code).toBe("approval_unsatisfied")
    expect(refusal.name).toBe("Refused")
  })
})
